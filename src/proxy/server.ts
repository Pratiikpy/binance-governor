#!/usr/bin/env tsx
// The Governor MCP server — what your AI client connects to instead of Binance directly.
//
// It speaks the same protocol Binance's own server speaks (streamable HTTP, JSON-RPC 2.0) and
// re-exposes every tool Binance offers, so nothing an agent could do before becomes impossible.
// The difference is what happens in between: reads pass through untouched, and every write is
// gated, validated by Binance itself, and written to a signed ledger before it can reach the
// exchange.
//
// Deliberately node:http and nothing else. A security layer whose supply chain is a dependency tree
// is not much of a security layer, and a user who has to trust 400 packages to gain one guarantee
// has not gained it.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BinanceUpstream, TOOL_CATEGORIES, type ToolDescriptor } from "../upstream/binance-mcp.ts";
import { loadPolicy, type Policy } from "../policy/config.ts";
import { effectOf } from "../policy/surface.ts";
import { SchemaPins, screenTool } from "../policy/tool-screen.ts";
import { issuePassport, type DatasetRef, type Passport, type StrategySpec } from "../policy/passport.ts";
import { Governor } from "../runtime/governor.ts";
import { Ledger, type LedgerRecord } from "../ledger/ledger.ts";
import { ContextBuilder } from "../runtime/context.ts";
import { runIdeaGate, type IdeaGateRequest } from "../idea-gate/client.ts";
import { renderConsolePage } from "../console/page.ts";
import { readFileSync, existsSync } from "node:fs";
import { join as joinPath } from "node:path";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "binance-governor";
const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Binance, through a governor.

Every Binance Agent OS tool is available here and behaves exactly as it does upstream. Market data,
balances, order history and every other read passes straight through.

Writes are different. Before an order reaches Binance it is checked against a policy the user wrote:
per-order size, position and gross exposure caps, a daily loss limit, a drawdown halt, a symbol
allowlist, order rate and per-symbol cooldown, duplicate detection, a fat-finger price check, and a
slippage estimate walked against the live order book. It is then validated by Binance's own
spot.orderTest, which applies the exchange's real filters without executing.

If an order is refused you will get a structured result naming the gate that stopped it and the
numbers involved. Read it and correct the order — do not retry the same call. Refusals are not
transport errors; the order never reached the exchange.

Every decision, allowed and refused alike, is appended to a hash-chained, Ed25519-signed ledger.
Call governor.verifyLedger to check it, and governor.policy to see the limits currently in force.

Before proposing that a strategy run live, call governor.evaluateIdea with its backtested returns.
It computes the Deflated Sharpe Ratio and Minimum Backtest Length against this account's real trial
count, and checks the claimed edge against this account's actual 20bps round-trip cost. Most ideas
come back UNSUPPORTED — that is not a bug in the gate, it is the correct prior. The order gate stops
a bad order; this stops a bad idea before it becomes one.`;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** Tools the Governor adds on top of Binance's. Read-only; none of them can move money. */
const GOVERNOR_TOOLS: ToolDescriptor[] = [
  {
    name: "governor.policy",
    description:
      "The limits currently in force: size caps, exposure caps, loss and drawdown halts, allowed symbols, rate limits. Read this before proposing a trade so you propose one that will pass.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "governor.status",
    description:
      "Live session state: kill switch, equity, current exposure, how many orders have been allowed and refused, and the ledger chain head.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "governor.verifyLedger",
    description:
      "Re-derive the decision ledger's hash chain from genesis and check its Ed25519 signature. Names the exact record if the history does not add up.",
    inputSchema: {
      type: "object",
      properties: { day: { type: "string", description: "UTC date as YYYY-MM-DD. Defaults to today." } },
      additionalProperties: false,
    },
  },
  {
    name: "governor.evaluateIdea",
    description:
      "Check whether a strategy is statistically supported BEFORE trading it. Computes the Deflated Sharpe Ratio, Minimum Backtest Length, and a real cost-floor check against this account's actual Binance spot commission (10bps/10bps, 20bps round trip) — Bailey & López de Prado's own math, not an opinion. Returns SUPPORTED or UNSUPPORTED with the exact numbers. Most ideas come back UNSUPPORTED — across ~150 published studies, none report a positive, cost-aware, out-of-sample trading result on any price series, and that is the correct prior to start from. Call this before proposing that an agent run a strategy live, not after.",
    inputSchema: {
      type: "object",
      properties: {
        returns: {
          type: "array",
          items: { type: "number" },
          description: "Per-bar NET returns of the strategy (after fees), at least 2 values. More bars = a more meaningful answer.",
        },
        barsPerYear: { type: "number", description: "365 for a 24/7 crypto market. Defaults to 365." },
        nTrials: {
          type: "number",
          description: "How many parameter configurations were tried before arriving at this one. Undercounting this is the single most common way a strategy looks better than it is. Defaults to 1 (an honest single try).",
        },
        claimedEdgeBps: { type: "number", description: "The edge you expect per round trip, in basis points, checked against this account's real 20bps round-trip cost." },
        correlationMatrix: {
          type: "array",
          items: { type: "array", items: { type: "number" } },
          description: "Correlation matrix across symbols traded, if more than one — reports how many independent bets the set actually represents (usually far fewer than the symbol count).",
        },
        strategy: {
          type: "object",
          description:
            "The action being certified. Supplying this issues an Action Passport: an immutable SHA-256 identity for these exact parameters on these exact symbols. Every live order must then carry that hash (see governor.passports), so an order can be traced to the research that authorised it. Change a parameter and the hash changes — a mutated strategy cannot inherit its parent's certification.",
          properties: {
            name: { type: "string", description: "Human name, e.g. \"sma-crossover\"." },
            symbols: { type: "array", items: { type: "string" }, description: "Symbols this action may trade. An order on any other symbol is refused by gate 17." },
            protocols: { type: "array", items: { type: "string" }, description: "DeFi protocols this action may enter, by Binance's own defiProtocolId. A separate namespace from symbols: a passport certified for BTCUSDT must not authorise a deposit into a contract, and does not." },
            params: { type: "object", description: "Everything that defines the behaviour: windows, thresholds, sizing rules." },
          },
          required: ["name", "symbols", "params"],
        },
        dataset: {
          type: "object",
          description: "What the strategy was judged on. Hashed into the passport so a re-run is checkable.",
          properties: {
            symbol: { type: "string" },
            interval: { type: "string" },
            bars: { type: "number" },
            from: { type: "string" },
            to: { type: "string" },
          },
          required: ["symbol", "interval", "bars", "from", "to"],
        },
      },
      required: ["returns"],
      additionalProperties: false,
    },
  },
  {
    name: "governor.passports",
    description:
      "Strategy Passports this Governor has issued — the certifications that authorise live orders. Each carries an immutable strategy hash, the evidence behind the verdict, and an expiry. A live order must name a SUPPORTED, unexpired hash certified for that symbol, or gate 17 refuses it. Call this to find the hash to put on your order.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "governor.decisions",
    description: "The most recent gate decisions, newest first — what was allowed, what was refused, and why.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "How many to return (default 20, max 200)." } },
      additionalProperties: false,
    },
  },
];

/**
 * Screen upstream tool metadata, then annotate it.
 *
 * Screening comes first and is not optional. Everything an upstream server advertises — its
 * descriptions, its parameter descriptions — reaches the model as text, and the published
 * MCP-security work demonstrates instruction injection through exactly that channel, with working
 * code. Governor's existing defence covers poisoned tool *results*; without this, poisoned tool
 * *descriptions* were relayed to the agent verbatim.
 *
 * A flagged description is replaced rather than annotated, because a warning printed next to
 * injected instructions still delivers the instructions.
 */
function screenAndAnnotate(tool: ToolDescriptor, pins: SchemaPins, onFinding: (line: string) => void): ToolDescriptor {
  const screened = screenTool(tool);
  if (screened.quarantined) {
    onFinding(`quarantined ${tool.name}: ${screened.findings.map((f) => `${f.rule} (${JSON.stringify(f.match)})`).join(", ")}`);
  }

  // Pin the screened contract, so a tool that redefines itself mid-session is caught even if the
  // new definition is clean. Trust was established against the old one.
  const drift = pins.check(screened.tool);
  if (drift) {
    onFinding(`schema drift on ${drift.name}: ${drift.previous.slice(0, 12)}… → ${drift.current.slice(0, 12)}…`);
    return {
      ...screened.tool,
      description:
        `[governor] This tool changed its advertised contract during this session and is withheld ` +
        `pending review. A server that behaves until it is trusted and then redefines itself is the ` +
        `documented "rug pull" — the old definition is what the operator approved.`,
    };
  }

  return annotate(screened.tool);
}

/** Annotate an upstream tool so a client can see, from the listing alone, what is gated. */
function annotate(tool: ToolDescriptor): ToolDescriptor {
  const effect = effectOf(tool.name);
  if (effect === "READ") return tool;
  const note =
    effect === "SIMULATE"
      ? "\n\n[governor] Validation only — this never executes an order. Safe to call freely."
      : "\n\n[governor] GATED. This call is checked against the user's policy before it reaches Binance and may be refused or held. Call governor.policy first to see the limits.";
  return { ...tool, description: `${tool.description ?? ""}${note}` };
}

async function main(): Promise<void> {
  const port = Number(process.env.GOVERNOR_PORT ?? 8787);
  const policyFile = process.env.GOVERNOR_POLICY ?? "policy.json";

  let policy: Policy;
  try {
    policy = loadPolicy(policyFile);
  } catch (err) {
    console.error(`[governor] policy file is invalid: ${String(err)}`);
    process.exit(1);
  }

  const upstream = new BinanceUpstream();
  const ledger = new Ledger();
  const context = new ContextBuilder(upstream);

  const recent: LedgerRecord[] = [];
  const governor = new Governor({
    upstream,
    policy,
    ledger,
    context,
    onDecision: (r) => {
      recent.push(r);
      if (recent.length > 500) recent.shift();
      const mark = r.verdict === "ALLOW" ? "·" : r.verdict === "BLOCK" ? "✕" : r.verdict === "HOLD" ? "⏸" : "▸";
      if (r.effect !== "READ") console.error(`[governor] ${mark} ${r.verdict} ${r.tool} — ${r.reason}`);
    },
  });

  console.error(`[governor] connecting to Binance…`);
  const init = (await upstream.initialize(SERVER_NAME, SERVER_VERSION)) as { serverInfo?: { name?: string } };
  console.error(`[governor] upstream ready: ${init.serverInfo?.name ?? "unknown"}`);

  // Discover the full surface once at startup. Anything the upstream hides behind META mode has to
  // be invoked through tool_execute, so the Governor has to know which those are before it forwards.
  const exposed = await upstream.listTools();
  const exposedNames = new Set(exposed.map((t) => t.name));
  const hidden: ToolDescriptor[] = [];
  for (const category of TOOL_CATEGORIES) {
    for (const t of await upstream.searchTools(category)) {
      const name = (t.name ?? (t as { toolName?: string }).toolName) as string | undefined;
      if (name && !exposedNames.has(name)) hidden.push({ ...t, name });
    }
  }
  const metaNames = new Set(hidden.map((t) => t.name));
  governor.setMetaTools(metaNames);

  const pins = new SchemaPins();
  const screenFindings: string[] = [];
  const catalogue = [
    ...GOVERNOR_TOOLS,
    ...[...exposed, ...hidden].map((t) => screenAndAnnotate(t, pins, (line) => screenFindings.push(line))),
  ];
  const gatedCount = catalogue.filter((t) => effectOf(t.name) === "WRITE").length;
  console.error(`[governor] ${catalogue.length} tools (${exposed.length} exposed, ${hidden.length} via META); ${gatedCount} gated`);
  console.error(
    screenFindings.length === 0
      ? `[governor] upstream tool metadata screened: ${pins.size} contracts pinned, nothing flagged`
      : `[governor] upstream tool metadata: ${screenFindings.length} finding(s) — ${screenFindings.join(" | ")}`,
  );
  for (const line of screenFindings) {
    ledger.append({
      tool: "governor.screenUpstream",
      effect: "CERTIFY",
      args: {},
      verdict: "BLOCK",
      reason: line,
      gates: [],
      notionalUsd: null,
    });
  }
  console.error(`[governor] policy: ${policy.symbolAllowlist.join(", ") || "no symbols"} · max order $${policy.maxOrderNotionalUsd}`);

  const handle = async (req: JsonRpcRequest): Promise<unknown> => {
    switch (req.method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: "Binance Governor", version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        };
      case "notifications/initialized":
        return {};
      case "ping":
        return {};
      case "tools/list":
        return { tools: catalogue };
      case "tools/call": {
        const name = String(req.params?.["name"] ?? "");
        const args = (req.params?.["arguments"] ?? {}) as Record<string, unknown>;
        if (name.startsWith("governor.")) return governorTool(name, args, governor, ledger, context, recent);
        const out = await governor.call(name, args);
        return { content: out.content, isError: out.isError };
      }
      default:
        throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 });
    }
  };

  const server = createServer((httpReq, httpRes) => void serve(httpReq, httpRes, handle, ledger, recent, policy, governor));
  // Loopback only, deliberately. This process holds a live trading session for a funded Binance
  // sub-account; it has no authentication of its own and must never be reachable off the machine.
  server.listen(port, "127.0.0.1", () => {
    console.error(`[governor] listening on http://127.0.0.1:${port}/mcp`);
    console.error(`[governor] connect it:  claude mcp add binance-governor --transport http http://127.0.0.1:${port}/mcp`);
  });
}

async function governorTool(
  name: string,
  args: Record<string, unknown>,
  governor: Governor,
  ledger: Ledger,
  context: ContextBuilder,
  recent: LedgerRecord[],
): Promise<unknown> {
  const text = (v: unknown): unknown => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }], isError: false });

  switch (name) {
    case "governor.policy":
      return text(governor.policy);
    case "governor.evaluateIdea": {
      const req: IdeaGateRequest = {
        returns: (args["returns"] as number[]) ?? [],
        ...(args["barsPerYear"] !== undefined ? { barsPerYear: args["barsPerYear"] as number } : {}),
        ...(args["nTrials"] !== undefined ? { nTrials: args["nTrials"] as number } : {}),
        ...(args["claimedEdgeBps"] !== undefined ? { claimedEdgeBps: args["claimedEdgeBps"] as number } : {}),
        ...(args["correlationMatrix"] !== undefined ? { correlationMatrix: args["correlationMatrix"] as number[][] } : {}),
      };
      try {
        const result = await runIdeaGate(req);

        // A certification is only issued when the caller actually names the strategy. Minting a
        // passport for an anonymous return series would create an identity nothing could be held
        // to — the hash has to cover something an order can be checked against.
        const spec = args["strategy"] as StrategySpec | undefined;
        const dataset = args["dataset"] as DatasetRef | undefined;
        if (!spec || !dataset) return text(result);

        const wf = result.walk_forward;
        const passport = governor.certify(
          issuePassport({
            spec,
            dataset,
            verdict: result.verdict,
            reason: result.reason,
            evidence: {
              nTrials: req.nTrials ?? 1,
              dsr: result.dsr?.dsr ?? null,
              minBacktestYears: result.dsr?.min_backtest_years ?? null,
              yearsHeld: result.dsr?.years_held ?? null,
              pbo: result.pbo?.pbo ?? null,
              walkForwardOosSharpe: wf?.status === "ok" ? (wf.out_of_sample_sharpe_annual ?? null) : null,
              netEdgeBps: result.cost_floor?.net_edge_bps ?? null,
              haltTempoMedianBars: result.halt_tempo?.status === "ok" ? (result.halt_tempo.bars_to_first_halt?.median.bars ?? null) : null,
            },
            nowMs: Date.now(),
            validForDays: governor.policy.certificationValidDays,
          }),
        );

        // The issuance goes in the signed ledger next to the decisions it authorises. A
        // certification nobody can audit later is as weak as no certification at all.
        ledger.append({
          tool: "governor.evaluateIdea",
          effect: "CERTIFY",
          args: { strategy: spec, dataset },
          verdict: passport.verdict === "SUPPORTED" ? "ALLOW" : "BLOCK",
          reason: `certification ${passport.verdict}: ${passport.strategyHash}`,
          gates: [],
          notionalUsd: null,
          context: { passport },
        });

        return text({ ...result, passport });
      } catch (err) {
        // The gate could not run at all. Treated the same as UNSUPPORTED — an unanswered
        // question is never a pass — but the caller sees clearly that this was a transport
        // failure (e.g. Python missing), not the math saying no.
        return text({ verdict: "UNSUPPORTED", reason: `idea gate unavailable: ${String(err)}` });
      }
    }
    case "governor.passports":
      return text(
        governor.listPassports().map((p) => ({
          strategyHash: p.strategyHash,
          name: p.spec.name,
          symbols: p.spec.symbols,
          verdict: p.verdict,
          reason: p.reason,
          evidence: p.evidence,
          issuedAt: p.issuedAt,
          expiresAt: p.expiresAt,
          expired: Date.parse(p.expiresAt) <= Date.now(),
        })),
      );
    case "governor.verifyLedger":
      return text(ledger.verify(typeof args["day"] === "string" ? (args["day"] as string) : undefined));
    case "governor.decisions": {
      const limit = Math.min(Math.max(Number(args["limit"] ?? 20) || 20, 1), 200);
      return text(
        recent
          .slice(-limit)
          .reverse()
          .map((r) => ({ seq: r.seq, ts: r.ts, tool: r.tool, verdict: r.verdict, reason: r.reason, notionalUsd: r.notionalUsd })),
      );
    }
    case "governor.status": {
      const account = await context.account();
      const writes = recent.filter((r) => r.effect === "WRITE");
      return text({
        killSwitch: governor.policy.killSwitch,
        equityUsd: account.equityUsd,
        grossUsd: account.grossUsd,
        positions: account.positionUsdBySymbol,
        peakEquityUsd: account.peakEquityUsd,
        dayStartEquityUsd: account.dayStartEquityUsd,
        decisions: {
          allowed: writes.filter((r) => r.verdict === "ALLOW" || r.verdict === "ALLOW_CAPPED").length,
          blocked: writes.filter((r) => r.verdict === "BLOCK").length,
          held: writes.filter((r) => r.verdict === "HOLD").length,
        },
        ledger: { records: ledger.count, chainHead: ledger.chainHead },
      });
    }
    default:
      throw Object.assign(new Error(`method not found: ${name}`), { code: -32601 });
  }
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  handle: (r: JsonRpcRequest) => Promise<unknown>,
  ledger: Ledger,
  recent: LedgerRecord[],
  policy: Policy,
  governor: Governor,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // The judge console: a static page whose every claim it verifies itself, client-side.
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/console")) {
    const html = renderConsolePage();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
    return void res.end(html);
  }

  // Small read-only surface for the console. Loopback only — see the bind address below.
  if (req.method === "GET" && url.pathname === "/api/state") {
    return json(res, 200, {
      policy,
      ledger: { records: ledger.count, chainHead: ledger.chainHead },
      decisions: recent.slice(-100).reverse(),
      passports: governor.listPassports().map((pp: Passport) => ({
        strategyHash: pp.strategyHash,
        name: pp.spec.name,
        symbols: pp.spec.symbols,
        params: pp.spec.params,
        verdict: pp.verdict,
        evidence: pp.evidence,
        expiresAt: pp.expiresAt,
        expired: Date.parse(pp.expiresAt) <= Date.now(),
      })),
    });
  }
  if (req.method === "GET" && url.pathname === "/api/verify") {
    return json(res, 200, ledger.verify());
  }
  // Raw records and the signed attestation, unfiltered — what the browser needs to re-derive
  // and verify the chain itself, rather than trust this endpoint's own opinion of it.
  if (req.method === "GET" && url.pathname === "/api/ledger") {
    const day = url.searchParams.get("day") ?? undefined;
    return json(res, 200, ledger.read(day));
  }
  if (req.method === "GET" && url.pathname === "/api/attestation") {
    const day = url.searchParams.get("day") ?? undefined;
    const att = ledger.readAttestation(day);
    if (!att) return json(res, 404, { error: "no signed chain for that day yet" });
    return json(res, 200, att);
  }
  if (req.method === "GET" && (url.pathname === "/api/demo/reject" || url.pathname === "/api/demo/accept")) {
    const file = joinPath(process.cwd(), "data", "demo", url.pathname.endsWith("reject") ? "reject.json" : "accept.json");
    if (!existsSync(file)) return json(res, 404, { error: "demo fixture not generated yet — run scripts/demo-reject.ts or demo-accept.ts" });
    res.writeHead(200, { "Content-Type": "application/json" });
    return void res.end(readFileSync(file, "utf8"));
  }
  if (req.method !== "POST") {
    return json(res, 405, { error: "GET / for the console, or POST JSON-RPC to /mcp" });
  }

  const body = await readBody(req);
  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(body) as JsonRpcRequest;
  } catch {
    return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }

  try {
    const result = await handle(parsed);
    // Notifications have no id and expect no response body.
    if (parsed.id === undefined || parsed.id === null) return json(res, 202, {});
    return json(res, 200, { jsonrpc: "2.0", id: parsed.id, result });
  } catch (err) {
    const code = (err as { code?: number }).code ?? -32603;
    return json(res, 200, {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      error: { code, message: err instanceof Error ? err.message : String(err) },
    });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) {
        req.destroy();
        reject(new Error("request too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

main().catch((err) => {
  console.error(`[governor] fatal: ${String(err)}`);
  process.exit(1);
});
