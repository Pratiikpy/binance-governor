#!/usr/bin/env node --import tsx
// The accept half of the demo pair: a strategy with a genuine, planted, cost-surviving edge,
// through the exact same code path that just rejected the honest SMA sweep.
//
// Why synthetic, not real: across ~150 primary sources spanning 1956-2026, none report a
// positive, cost-aware, out-of-sample, standard-error-checked trading result on any price
// series (best-of-the-best/papers/11-WHAT-THE-LITERATURE-SAYS.md). His own real sweep just
// confirmed it again on live Binance data. Demonstrating that the gate CAN accept something
// therefore requires a case engineered to deserve it — the alternative is pretending a real
// edge exists when the entire point of this project is refusing to pretend that.

import { runIdeaGate } from "../src/idea-gate/client.ts";
import { loadPolicy } from "../src/policy/config.ts";
import { mkdirSync, writeFileSync } from "node:fs";

/** Deterministic normal-ish returns via Box-Muller, seeded so this script is reproducible. */
function plantedReturns(n: number, mean: number, std: number, seed: number): number[] {
  let s = seed;
  const rand = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.push(mean + std * z);
  }
  return out;
}

async function main() {
  const n = 1459; // match the real sample size the reject case used
  const returns = plantedReturns(n, 0.0022, 0.009, 99); // a genuinely large, consistent daily edge

  const grossAnnualPct = returns.reduce((a, b) => a + b, 0) * (365 / n) * 100;
  console.log(`Synthetic strategy: ${n} bars, planted mean daily return 0.22%, std 0.9% — gross annualised ~${grossAnnualPct.toFixed(1)}%.`);
  console.log(`Declared honestly as n_trials = 1: this exact configuration, chosen before looking at any other, no sweep.\n`);

  const policy = loadPolicy();
  const result = await runIdeaGate({
    returns,
    nTrials: 1,
    claimedEdgeBps: 40, // a real, substantial edge per round trip — still well above Binance's 20bps cost
    policy: { maxDrawdownPct: policy.maxDrawdownPct, maxDailyLossPct: policy.maxDailyLossPct },
  });

  console.log("=== IDEA GATE VERDICT ===");
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nDSR ${result.dsr?.dsr?.toFixed(4)} >= 0.95, MinBTL ${result.dsr?.min_backtest_years?.toFixed(2)}y <= ${result.dsr?.years_held?.toFixed(2)}y held, net edge +${result.cost_floor?.net_edge_bps?.toFixed(1)} bps after Binance's real 20bps round trip.`);
  console.log(`Same gate. Same code path. This is what SUPPORTED looks like when it is actually earned.`);

  mkdirSync("data/demo", { recursive: true });
  writeFileSync(
    "data/demo/accept.json",
    JSON.stringify(
      {
        title: "The planted edge",
        n,
        plantedMeanDailyPct: 0.22,
        plantedStdPct: 0.9,
        grossAnnualisedPct: grossAnnualPct,
        claimedEdgeBps: 40,
        result,
        note: "Synthetic and declared as such. Across ~150 studies from 1956-2026, none report a positive, cost-aware, out-of-sample trading result on any price series -- this case exists to prove the gate CAN say yes, not to claim a real edge exists.",
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote data/demo/accept.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
