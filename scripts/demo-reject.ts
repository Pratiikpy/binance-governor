#!/usr/bin/env node --import tsx
// The reject half of the demo pair: not one strategy, but what a real builder actually does
// — sweep parameters, keep the best-looking one — on real Binance data, then told the truth
// about how many configurations were tried before it's judged. This mirrors the corpus's own
// real study (`okx/trading/notes/43`, a 160-config MA sweep) rather than a single cherry-picked
// example, because "we swept honestly and it still fails" is the whole point of the gate: the
// input nobody counts honestly is N, and the sweep is where N actually comes from.

import { fetchKlinesCached, closeToCloseReturns, type Kline } from "../src/data/binance-klines.ts";
import { runIdeaGate } from "../src/idea-gate/client.ts";
import { mkdirSync, writeFileSync } from "node:fs";

function sma(values: number[], window: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= window) sum -= values[i - window]!;
    out.push(i >= window - 1 ? sum / window : null);
  }
  return out;
}

interface BacktestOutcome {
  fastWindow: number;
  slowWindow: number;
  strategyReturns: number[];
  roundTrips: number;
  sharpeAnnual: number;
}

/** Long-only fast/slow SMA crossover. Returns the strategy's own per-bar returns and how
 * many times it actually changed position — not a formula, a count of real state changes. */
function backtestSmaCrossover(klines: Kline[], fastWindow: number, slowWindow: number): BacktestOutcome {
  const closes = klines.map((k) => k.close);
  const fast = sma(closes, fastWindow);
  const slow = sma(closes, slowWindow);
  const dailyReturns = closeToCloseReturns(klines);

  const strategyReturns: number[] = [];
  let position = 0;
  let transitions = 0;

  for (let i = 1; i < klines.length; i++) {
    const f = fast[i - 1];
    const s = slow[i - 1];
    const desired = f !== null && s !== null && f > s ? 1 : 0;
    if (desired !== position) {
      transitions += 1;
      position = desired;
    }
    strategyReturns.push(position === 1 ? dailyReturns[i - 1]! : 0);
  }

  const mean = strategyReturns.reduce((a, b) => a + b, 0) / strategyReturns.length;
  const variance = strategyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / strategyReturns.length;
  const sharpeAnnual = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(365) : 0;

  return { fastWindow, slowWindow, strategyReturns, roundTrips: Math.floor(transitions / 2), sharpeAnnual };
}

async function main() {
  const end = Date.now();
  const start = end - 4 * 365 * 24 * 3600 * 1000;
  const klines = await fetchKlinesCached("data/klines", "BTCUSDT", "1d", start, end);
  console.log(`Fetched ${klines.length} real BTCUSDT daily bars from Binance, ${new Date(klines[0]!.openTimeMs).toISOString().slice(0, 10)} to ${new Date(klines[klines.length - 1]!.openTimeMs).toISOString().slice(0, 10)}.\n`);

  // The sweep a real builder actually runs: every fast/slow pair with fast < slow.
  const fastWindows = [5, 8, 10, 12, 15, 20, 25, 30];
  const slowWindows = [30, 40, 50, 60, 80, 100, 120, 150, 200];
  const outcomes: BacktestOutcome[] = [];
  for (const f of fastWindows) {
    for (const s of slowWindows) {
      if (f >= s) continue;
      outcomes.push(backtestSmaCrossover(klines, f, s));
    }
  }
  const nTrials = outcomes.length;

  const best = outcomes.reduce((a, b) => (b.sharpeAnnual > a.sharpeAnnual ? b : a));
  console.log(`Swept ${nTrials} fast/slow SMA combinations on real BTCUSDT — exactly what a builder does before shipping "the" strategy.`);
  console.log(`Best of the sweep: SMA(${best.fastWindow})/SMA(${best.slowWindow}), annualised Sharpe ${best.sharpeAnnual.toFixed(3)}, ${best.roundTrips} round trips.\n`);

  const grossMean = best.strategyReturns.reduce((a, b) => a + b, 0) / best.strategyReturns.length;
  const years = best.strategyReturns.length / 365;
  const totalGrossReturn = best.strategyReturns.reduce((a, r) => a * (1 + r), 1) - 1;
  const bpsPerRoundTrip = best.roundTrips > 0 ? (totalGrossReturn / best.roundTrips) * 10000 : 0;

  console.log(`Gross annualised return: ${(grossMean * 365 * 100).toFixed(2)}%   Total gross return: ${(totalGrossReturn * 100).toFixed(1)}%`);
  console.log(`Average gross edge per round trip: ${bpsPerRoundTrip.toFixed(2)} bps\n`);

  // The variance across the sweep is the honest input to the deflation, not a guess.
  const sharpeValues = outcomes.map((o) => o.sharpeAnnual);
  const sweepMean = sharpeValues.reduce((a, b) => a + b, 0) / sharpeValues.length;
  const sweepVar = sharpeValues.reduce((a, b) => a + (b - sweepMean) ** 2, 0) / sharpeValues.length;

  // The whole sweep, not just the winner: (T x N), column n = configuration n's return series.
  // This is what PBO needs, and it is exactly what a builder normally discards after picking one.
  const T = best.strategyReturns.length;
  const sweepMatrix: number[][] = Array.from({ length: T }, (_, t) => outcomes.map((o) => o.strategyReturns[t] ?? 0));

  console.log(`--- Honest framing: n_trials = ${nTrials} (every combination actually tried) ---`);
  const honest = await runIdeaGate({
    returns: best.strategyReturns,
    nTrials,
    varTrialSharpeAnnual: sweepVar,
    claimedEdgeBps: bpsPerRoundTrip,
    sweepMatrix,
  });
  console.log(JSON.stringify(honest, null, 2));

  console.log(`\n--- Dishonest framing, for comparison only: n_trials = 1 (as if this one config were chosen a priori) ---`);
  const dishonest = await runIdeaGate({
    returns: best.strategyReturns,
    nTrials: 1,
    claimedEdgeBps: bpsPerRoundTrip,
  });
  console.log(`DSR at n_trials=1: ${dishonest.dsr?.dsr?.toFixed(4)}  →  verdict ${dishonest.verdict}`);
  console.log(`DSR at n_trials=${nTrials}: ${honest.dsr?.dsr?.toFixed(4)}  →  verdict ${honest.verdict}`);
  console.log(`\nSame data. Same "best" strategy. The only thing that changed is telling the truth about how hard we searched.`);

  mkdirSync("data/demo", { recursive: true });
  writeFileSync(
    "data/demo/reject.json",
    JSON.stringify(
      {
        title: "The honest sweep",
        symbol: "BTCUSDT",
        dataRange: { from: new Date(klines[0]!.openTimeMs).toISOString(), to: new Date(klines[klines.length - 1]!.openTimeMs).toISOString() },
        barsUsed: klines.length,
        sweep: { nTrials, fastWindows, slowWindows, bestFast: best.fastWindow, bestSlow: best.slowWindow, bestSharpeAnnual: best.sharpeAnnual, roundTrips: best.roundTrips },
        grossAnnualisedPct: grossMean * 365 * 100,
        totalGrossReturnPct: totalGrossReturn * 100,
        edgePerRoundTripBps: bpsPerRoundTrip,
        honest,
        dishonestComparison: { nTrials: 1, dsr: dishonest.dsr?.dsr, verdict: dishonest.verdict },
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote data/demo/reject.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
