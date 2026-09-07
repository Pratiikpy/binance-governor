#!/usr/bin/env tsx
// Persona-driven UAT: does the product actually work for the people who will judge it?
//
// The release audit proves the gates refuse bad orders. That is necessary and not sufficient —
// it tests the mechanism, not the journey. A judge does not call `governor.call()`; they clone a
// repo, run a command, click a button, and decide within ninety seconds whether to believe any of
// it. This walks those journeys end to end and fails if one of them is broken.
//
// Ported in shape from NightDesk's scenario-uat.ts (persona / goal / steps / passCriteria, spawned
// and artifact-checked automatically), rewritten for Governor's own surfaces.
//
// Deliberately runs offline against a fake Binance upstream, so it is deterministic and needs no
// credentials. The one journey it cannot fully walk is "a real order fills on a funded account" —
// that needs real money, and this script says so rather than pretending otherwise.

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinanceUpstream } from "../upstream/binance-mcp.ts";
import { Governor } from "../runtime/governor.ts";
import { Ledger } from "../ledger/ledger.ts";
import { ContextBuilder } from "../runtime/context.ts";
import { DEFAULT_POLICY, parsePolicy } from "../policy/config.ts";
import { runIdeaGate } from "../idea-gate/client.ts";
import { renderConsolePage } from "../console/page.ts";

function fakeUpstream(): BinanceUpstream {
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; params?: { name?: string } };
    const name = body.params?.name;
    let result: unknown;
    if (name === "spot.tickerPrice") result = { content: [{ type: "text", text: JSON.stringify({ symbol: "BTCUSDT", price: "80000.00" }) }], isError: false };
    else if (name === "spot.getAccount") result = { content: [{ type: "text", text: JSON.stringify({ balances: [{ asset: "USDT", free: "1000", locked: "0" }] }) }], isError: false };
    else if (name === "spot.exchangeInfo") result = { content: [{ type: "text", text: JSON.stringify({ symbols: [{ symbol: "BTCUSDT", status: "TRADING" }] }) }], isError: false };
    else if (name === "spot.depth") {
      result = {
        content: [{ type: "text", text: JSON.stringify({ bids: Array.from({ length: 50 }, (_, i) => [String(80000 - i), "1.0"]), asks: Array.from({ length: 50 }, (_, i) => [String(80001 + i), "1.0"]) }) }],
        isError: false,
      };
    } else result = { content: [{ type: "text", text: "{}" }], isError: false };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return new BinanceUpstream({ token: "scenario-uat", fetchImpl });
}

interface Scenario {
  persona: string;
  goal: string;
  run: () => Promise<{ pass: boolean; evidence: string }>;
}

const SCENARIOS: Scenario[] = [
  {
    persona: "The sceptical judge",
    goal: "Verify the signed ledger myself, without trusting the server that produced it",
    run: async () => {
      const dir = mkdtempSync(join(tmpdir(), "uat-sceptic-"));
      try {
        const ledger = new Ledger(dir);
        const governor = new Governor({ upstream: fakeUpstream(), policy: DEFAULT_POLICY, ledger, context: new ContextBuilder(fakeUpstream()) });
        await governor.call("spot.tickerPrice", { symbol: "BTCUSDT" });
        await governor.call("spot.newOrder", { symbol: "DOGEUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 10 });

        const records = ledger.read();
        const att = ledger.readAttestation();
        const report = ledger.verify();
        // The judge's actual question: are both an allowed and a refused decision recorded, is the
        // chain intact, and is there a public key they can check it against?
        const hasBoth = records.some((r) => r.verdict === "ALLOW") && records.some((r) => r.verdict === "BLOCK");
        const pass = report.ok && hasBoth && !!att?.publicKeyPem.includes("BEGIN PUBLIC KEY");
        return { pass, evidence: `${report.recordCount} records, chain ${report.ok ? "intact" : "BROKEN"}, both verdict kinds present: ${hasBoth}, public key published: ${!!att}` };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    persona: "The judge who tries to break it",
    goal: "Get a reckless order through the console's attack form",
    run: async () => {
      const dir = mkdtempSync(join(tmpdir(), "uat-attacker-"));
      try {
        const governor = new Governor({ upstream: fakeUpstream(), policy: { ...DEFAULT_POLICY, symbolAllowlist: ["BTCUSDT"] }, ledger: new Ledger(dir), context: new ContextBuilder(fakeUpstream()) });
        const attacks = [
          { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 50000 },
          { symbol: "DOGEUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 10 },
          { symbol: "BTCUSDT", side: "BUY", type: "LIMIT", price: 400000, quantity: 0.001 },
          { symbol: "BTCUSDT", side: "BUY", type: "MARKET" },
        ];
        const results = await Promise.all(attacks.map((a) => governor.call("spot.newOrder", a)));
        const allBlocked = results.every((r) => r.isError);
        return { pass: allBlocked, evidence: `${results.filter((r) => r.isError).length}/${attacks.length} reckless orders refused` };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    persona: "The quant",
    goal: "Check whether a strategy is worth running, and be told no when it isn't",
    run: async () => {
      const noise = Array.from({ length: 800 }, (_, i) => Math.sin(i * 12.9898) * 0.02);
      const weak = await runIdeaGate({ returns: noise, nTrials: 100, claimedEdgeBps: 5 });
      const strong = await runIdeaGate({ returns: Array.from({ length: 800 }, (_, i) => 0.002 + Math.sin(i * 7.7) * 0.004), nTrials: 1, claimedEdgeBps: 60 });
      // The gate is only useful if it discriminates. Refusing everything is not a risk layer,
      // it is an off switch.
      const pass = weak.verdict === "UNSUPPORTED" && strong.verdict === "SUPPORTED";
      return { pass, evidence: `noise -> ${weak.verdict}, planted edge -> ${strong.verdict}` };
    },
  },
  {
    persona: "The stranger following the README",
    goal: "Understand what to run, and have the environment actually support it",
    run: async () => {
      const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
      const commands = ["npm install", "npm run governor", "npm run verify", "npm run doctor"];
      const documented = commands.filter((c) => readme.includes(c));
      const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
      // Every command the README tells a stranger to run must actually exist as a script.
      const real = ["governor", "verify", "doctor"].filter((s) => pkg.scripts[s] !== undefined);
      const pass = documented.length === commands.length && real.length === 3;
      return { pass, evidence: `${documented.length}/${commands.length} commands documented, ${real.length}/3 npm scripts actually exist` };
    },
  },
  {
    persona: "The judge on a phone, with no install",
    goal: "Open the console and see something meaningful without running anything",
    run: async () => {
      const html = renderConsolePage();
      const needs = ["Attack it yourself", "Verify in my browser", "Tamper a byte", "Honest boundaries", "crypto.subtle", "Ed25519"];
      const missing = needs.filter((n) => !html.includes(n));
      return { pass: missing.length === 0, evidence: missing.length === 0 ? `all ${needs.length} judge-facing elements present` : `missing: ${missing.join(", ")}` };
    },
  },
  {
    persona: "The operator who misconfigures it",
    goal: "Get told clearly, rather than silently trading on a default I did not choose",
    run: async () => {
      const bad = [
        { policy: { maxOrderNotinalUsd: 100 }, why: "typo in a field name" },
        { policy: { maxOrderNotionalUsd: -5 }, why: "negative limit" },
        { policy: { maxPositionPct: 90, maxGrossPct: 50 }, why: "position cap above gross cap" },
        { policy: { maxDailyLossPct: 9, maxDrawdownPct: 5 }, why: "daily halt that could never fire" },
      ];
      const rejected = bad.filter((b) => {
        try {
          parsePolicy(b.policy);
          return false;
        } catch {
          return true;
        }
      });
      return { pass: rejected.length === bad.length, evidence: `${rejected.length}/${bad.length} malformed policies rejected rather than silently defaulted` };
    },
  },
];

async function main(): Promise<void> {
  console.log("=== SCENARIO UAT: the journeys a judge actually takes ===\n");
  let failed = 0;

  for (const s of SCENARIOS) {
    let pass = false;
    let evidence = "";
    try {
      ({ pass, evidence } = await s.run());
    } catch (err) {
      evidence = `threw: ${String(err).slice(0, 200)}`;
    }
    if (!pass) failed++;
    console.log(`[${pass ? "PASS" : "FAIL"}] ${s.persona}`);
    console.log(`       goal: ${s.goal}`);
    console.log(`       ${evidence}\n`);
  }

  // The journey this script honestly cannot walk.
  console.log("[N/A ] The judge who wants to see a real fill");
  console.log("       goal: watch a real order execute on a funded account");
  console.log("       Requires real funds in the Agentic sub-account. Not simulated here, and not");
  console.log("       claimed as passing. See README 'Honest boundaries'.\n");

  console.log(`${failed === 0 ? "ALL JOURNEYS PASS" : `${failed} JOURNEY(S) BROKEN`} — ${SCENARIOS.length - failed}/${SCENARIOS.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("scenario UAT crashed:", err);
  process.exit(1);
});
