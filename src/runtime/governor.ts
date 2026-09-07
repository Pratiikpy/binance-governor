// The Governor: the one place a tool call can become an order.
//
// Reads go straight through — they cost nothing and refusing them would only make the agent guess.
// Writes take the long path: build the context, run every gate, ask Binance itself to validate the
// order without executing it, and only then forward. Allowed or refused, the whole decision is
// written to the ledger before the caller hears anything back.
//
// A refusal is returned as structured data, not as a thrown error, and it names the gate and the
// numbers that failed it. An agent that is told "05_order_sized: order specifies neither quantity
// nor quoteOrderQty" can fix its own call. An agent that is told "error" will retry the same
// mistake until the rate limiter stops it.

import type { BinanceUpstream, CallResult } from "../upstream/binance-mcp.ts";
import type { Policy } from "../policy/config.ts";
import { evaluateWrite, fingerprintOrder, type Decision } from "../policy/gates.ts";
import { canonicalize, type Passport } from "../policy/passport.ts";
import { effectOf, parseOrder, SIMULATE_TOOLS, type Effect } from "../policy/surface.ts";
import { Ledger, type LedgerRecord } from "../ledger/ledger.ts";
import { ContextBuilder } from "./context.ts";
import { createHash } from "node:crypto";

export interface GovernorOptions {
  upstream: BinanceUpstream;
  policy: Policy;
  ledger?: Ledger;
  context?: ContextBuilder;
  /** Tools the upstream hides behind META mode, routed via tool_execute. */
  metaTools?: ReadonlySet<string>;
  /** Emitted for every decision so the console can stream them. */
  onDecision?: (record: LedgerRecord) => void;
  /** Certifications already issued — used to seed a Governor from a saved passport store. */
  passports?: readonly Passport[];
}

export interface GovernorOutcome {
  /** What the caller gets back. Always MCP tool-result shaped. */
  content: { type: "text"; text: string }[];
  isError: boolean;
  record: LedgerRecord;
}

/**
 * Arguments Governor consumes itself and must not pass upstream.
 *
 * Kept as one named list so the strip stays complete: a governor-only argument added to the tool
 * schema without a line here is a field that leaks onto a real Binance order.
 */
const GOVERNOR_ONLY_ARGS = ["strategyHash", "expectedEdgePct"] as const;

function stripGovernorArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const k of GOVERNOR_ONLY_ARGS) delete out[k];
  return out;
}

/** Binance's own validation endpoint for each order tool, where one exists. */
const PREFLIGHT_FOR: Readonly<Record<string, string>> = {
  "spot.newOrder": "spot.orderTest",
  "spot.sorOrder": "spot.sorOrderTest",
};

export class Governor {
  private readonly upstream: BinanceUpstream;
  private readonly ledger: Ledger;
  private readonly ctx: ContextBuilder;
  private readonly onDecision: ((r: LedgerRecord) => void) | undefined;
  private metaTools: ReadonlySet<string>;
  /**
   * Certifications this Governor has issued. Held in memory alongside the ledger rather than in a
   * separate database: a passport is only meaningful next to the decisions it authorised, and the
   * ledger already carries every issuance as a signed, hash-chained record.
   */
  private readonly passports: Passport[];
  policy: Policy;

  constructor(opts: GovernorOptions) {
    this.upstream = opts.upstream;
    this.policy = opts.policy;
    this.ledger = opts.ledger ?? new Ledger();
    this.ctx = opts.context ?? new ContextBuilder(opts.upstream);
    this.metaTools = opts.metaTools ?? new Set();
    this.onDecision = opts.onDecision;
    this.passports = [...(opts.passports ?? [])];
  }

  /**
   * Record a certification. Re-certifying the same strategy replaces the old passport rather than
   * accumulating duplicates — the hash is the identity, so two entries for one hash would leave
   * gate 17 picking arbitrarily between them.
   */
  certify(passport: Passport): Passport {
    const existing = this.passports.findIndex((p) => p.strategyHash === passport.strategyHash);
    if (existing >= 0) this.passports.splice(existing, 1, passport);
    else this.passports.push(passport);
    return passport;
  }

  listPassports(): readonly Passport[] {
    return this.passports;
  }

  setMetaTools(names: ReadonlySet<string>): void {
    this.metaTools = names;
  }

  get ledgerRef(): Ledger {
    return this.ledger;
  }

  private forward(tool: string, args: Record<string, unknown>): Promise<CallResult> {
    return this.upstream.callTool(tool, args, this.metaTools.has(tool));
  }

  private text(value: unknown): { type: "text"; text: string }[] {
    return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
  }

  async call(tool: string, args: Record<string, unknown>): Promise<GovernorOutcome> {
    const effect: Effect = effectOf(tool);

    // Reads and Binance's own no-execution validators pass through. They are still recorded, because
    // an audit trail with holes in it is not an audit trail — but they are not gated.
    if (effect === "READ" || effect === "SIMULATE") {
      let result: CallResult;
      try {
        result = await this.forward(tool, args);
      } catch (err) {
        const record = this.write({
          tool,
          effect,
          args,
          verdict: "ALLOW",
          reason: "passthrough",
          gates: [],
          notionalUsd: null,
          upstream: { isError: true, raw: String(err) },
        });
        return { content: this.text({ error: String(err) }), isError: true, record };
      }
      const record = this.write({
        tool,
        effect,
        args,
        verdict: "ALLOW",
        reason: effect === "SIMULATE" ? "validation only — never executes" : "read",
        gates: [],
        notionalUsd: null,
        upstream: { isError: result.isError, raw: truncate(result.raw) },
      });
      return { content: this.text(result.raw), isError: result.isError, record };
    }

    // --- write path -----------------------------------------------------------------------------
    const order = parseOrder(tool, args);
    const nowMs = Date.now();
    const [market, account] = await Promise.all([this.ctx.market(order, nowMs), this.ctx.account(nowMs)]);
    const history = this.ctx.history(nowMs);
    const expectedEdgePct = typeof args["expectedEdgePct"] === "number" ? (args["expectedEdgePct"] as number) : undefined;
    const strategyHash = typeof args["strategyHash"] === "string" ? (args["strategyHash"] as string) : undefined;

    const decision: Decision = evaluateWrite(order, {
      policy: this.policy,
      market,
      account,
      history,
      passports: this.passports,
      ...(expectedEdgePct !== undefined ? { expectedEdgePct } : {}),
      ...(strategyHash !== undefined ? { strategyHash } : {}),
    });

    const contextSnapshot = {
      market,
      account: {
        equityUsd: account.equityUsd,
        grossUsd: account.grossUsd,
        dayStartEquityUsd: account.dayStartEquityUsd,
        peakEquityUsd: account.peakEquityUsd,
        positionUsdBySymbol: account.positionUsdBySymbol,
      },
      recentOrderCount: history.recent.length,
      policySnapshot: this.policy,
    };

    if (decision.verdict === "BLOCK" || decision.verdict === "HOLD") {
      const record = this.write({
        tool,
        effect,
        args,
        verdict: decision.verdict,
        reason: decision.reason,
        gates: decision.results,
        notionalUsd: decision.notionalUsd,
        context: contextSnapshot,
      });
      return { content: this.text(refusalPayload(decision)), isError: true, record };
    }

    // Governor's own arguments never reach Binance. They are inputs to the decision, not to the
    // order, and forwarding them would put unknown fields on a real exchange call — a latent bug
    // that predated `strategyHash` and would have been made worse by adding a second one.
    const outboundArgs = stripGovernorArgs(
      decision.verdict === "ALLOW_CAPPED" && decision.cappedArgs ? { ...args, ...decision.cappedArgs } : args,
    );

    // Binance validates its own order before we send it for real. This catches everything the policy
    // engine has no business knowing: lot size, tick size, min notional, permissions, symbol state.
    // Bind the decision to the ORDER THAT IS ACTUALLY SENT, not merely to the one that was judged.
    // ALLOW_CAPPED rewrites the order between those two moments, so without this the ledger records
    // an approval for one instruction and an execution of another, and nobody can prove afterwards
    // that the second descended from the first. Hashing the outbound arguments closes that window.
    const enforcedOrderHash = createHash("sha256").update(canonicalize(outboundArgs), "utf8").digest("hex");

    const preflight = await this.preflight(tool, outboundArgs);
    if (preflight && !preflight.ok) {
      const record = this.write({
        tool,
        effect,
        args,
        verdict: "BLOCK",
        reason: `preflight: ${preflight.detail}`,
        gates: decision.results,
        notionalUsd: decision.notionalUsd,
        context: contextSnapshot,
        preflight,
        ...(decision.cappedArgs ? { cappedArgs: decision.cappedArgs } : {}),
      });
      return {
        content: this.text({
          governor: "BLOCK",
          reason: `Binance rejected this order in validation: ${preflight.detail}`,
          hint: "The order never reached the exchange. Fix the arguments and try again.",
        }),
        isError: true,
        record,
      };
    }

    let result: CallResult;
    try {
      result = await this.forward(tool, outboundArgs);
    } catch (err) {
      const record = this.write({
        tool,
        effect,
        args,
        verdict: decision.verdict,
        reason: `sent, upstream failed: ${String(err)}`,
        gates: decision.results,
        notionalUsd: decision.notionalUsd,
        context: contextSnapshot,
        enforcedOrderHash,
        ...(preflight ? { preflight } : {}),
        upstream: { isError: true, raw: String(err) },
      });
      return { content: this.text({ error: String(err) }), isError: true, record };
    }

    if (!result.isError) {
      this.ctx.noteSent({ tsMs: nowMs, symbol: order.symbol, fingerprint: fingerprintOrder(order) });
    }

    const record = this.write({
      tool,
      effect,
      args,
      verdict: decision.verdict,
      reason: decision.reason,
      gates: decision.results,
      notionalUsd: decision.notionalUsd,
      context: contextSnapshot,
      enforcedOrderHash,
      ...(preflight ? { preflight } : {}),
      ...(decision.cappedArgs ? { cappedArgs: decision.cappedArgs } : {}),
      upstream: { isError: result.isError, raw: truncate(result.raw) },
    });

    // A capped order is reported as capped. Silently sending something other than what was asked for
    // would make the Governor the unreliable narrator it exists to prevent.
    const payload =
      decision.verdict === "ALLOW_CAPPED"
        ? { governor: "ALLOW_CAPPED", reason: decision.reason, sentArguments: outboundArgs, result: result.data }
        : result.data;

    return { content: this.text(payload), isError: result.isError, record };
  }

  /** Ask Binance to validate the order without executing it. Null when the tool has no validator. */
  private async preflight(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; detail: string } | null> {
    const validator = PREFLIGHT_FOR[tool];
    if (!validator || !SIMULATE_TOOLS.has(validator)) return null;
    try {
      const res = await this.forward(validator, args);
      if (res.isError) return { ok: false, detail: truncate(res.raw, 400) };
      return { ok: true, detail: "accepted by spot.orderTest" };
    } catch (err) {
      // A validator that is unreachable must not become an implicit approval.
      return { ok: false, detail: `validation unavailable: ${String(err)}` };
    }
  }

  private write(entry: Omit<LedgerRecord, "seq" | "ts" | "prevHash" | "hash">): LedgerRecord {
    const record = this.ledger.append(entry);
    this.onDecision?.(record);
    return record;
  }
}

/** What a refused caller sees. Shaped so an agent can act on it rather than just retry. */
function refusalPayload(d: Decision): Record<string, unknown> {
  const failed = d.results.filter((r) => !r.passed);
  return {
    governor: d.verdict,
    reason: d.reason,
    failedGates: failed.map((r) => ({ gate: r.gate, detail: r.detail, indeterminate: r.indeterminate ?? false })),
    passedGates: d.results.filter((r) => r.passed).map((r) => r.gate),
    notionalUsd: d.notionalUsd,
    hint:
      d.verdict === "HOLD"
        ? "This order is within policy but above the auto-approve limit. A human must release it."
        : "The order was not sent to Binance. Adjust it to satisfy the failed gate, or change the policy deliberately.",
  };
}

function truncate(s: string, max = 4000): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[${s.length - max} more chars]`;
}
