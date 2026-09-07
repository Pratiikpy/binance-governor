// Integration tests for the idea gate bridge. These actually spawn Python — slower than
// the pure-TS gate tests, but the whole point of this module is that the math lives in a
// tested Python implementation, so a test that mocks the subprocess would prove nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runIdeaGate } from "../src/idea-gate/client.ts";

function normalReturns(n: number, mean: number, std: number, seed: number): number[] {
  // Deterministic Box-Muller so the test is reproducible without a dependency.
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

test("a searched, weak strategy is UNSUPPORTED with real DSR/MinBTL numbers", async () => {
  const returns = normalReturns(1440, 0.00015, 0.012, 42);
  const result = await runIdeaGate({ returns, nTrials: 200, claimedEdgeBps: 8 });
  assert.equal(result.verdict, "UNSUPPORTED");
  assert.ok(result.dsr);
  assert.ok(result.dsr!.dsr! < 0.95);
  assert.ok(result.dsr!.min_backtest_years! > result.dsr!.years_held);
  assert.equal(result.cost_floor?.passes, false);
  assert.match(result.reason, /DSR .* required|net edge/);
});

test("a single-trial, strong planted edge is SUPPORTED through the identical path", async () => {
  const returns = normalReturns(1440, 0.0025, 0.01, 7);
  const result = await runIdeaGate({ returns, nTrials: 1, claimedEdgeBps: 45 });
  assert.equal(result.verdict, "SUPPORTED");
  assert.equal(result.dsr?.passes, true);
  assert.equal(result.cost_floor?.passes, true);
});

test("Binance spot's real 20bps round trip is used, not a perp schedule", async () => {
  const returns = normalReturns(200, 0.001, 0.01, 3);
  const result = await runIdeaGate({ returns, claimedEdgeBps: 15 });
  assert.equal(result.cost_floor?.round_trip_bps, 20);
  assert.equal(result.cost_floor?.net_edge_bps, -5);
});

test("too few observations fails closed rather than crashing", async () => {
  const result = await runIdeaGate({ returns: [0.01] });
  assert.equal(result.verdict, "UNSUPPORTED");
  assert.equal(result.reason, "insufficient-observations");
});

test("PBO catches a selection procedure that is picking noise", async () => {
  // 40 configurations of pure noise. There is no edge to find, so the in-sample winner should
  // land below the out-of-sample median roughly half the time -- a high PBO. If this ever comes
  // back low, CSCV is not doing its job.
  const T = 600;
  const N = 40;
  const sweepMatrix: number[][] = Array.from({ length: T }, (_, t) =>
    Array.from({ length: N }, (_, n) => normalReturns(1, 0, 0.01, t * N + n + 1)[0]!),
  );
  const result = await runIdeaGate({
    returns: sweepMatrix.map((row) => row[0]!),
    nTrials: N,
    sweepMatrix,
  });
  assert.equal(result.pbo?.status, "ok");
  assert.equal(result.pbo?.n_configs, N);
  assert.ok(result.pbo!.pbo! > 0.3, `pure noise should show a high PBO, got ${result.pbo!.pbo}`);
  assert.equal(result.verdict, "UNSUPPORTED");
});

test("PBO is simply not run when no sweep matrix is supplied — never silently passed", async () => {
  const result = await runIdeaGate({ returns: normalReturns(400, 0.002, 0.01, 5), nTrials: 1 });
  assert.equal(result.pbo, undefined);
});

test("breadth reproduces the corpus's own 8-asset figure", async () => {
  const returns = normalReturns(1440, 0.0025, 0.01, 11);
  const corr = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => (i === j ? 1 : 0.8)));
  const result = await runIdeaGate({ returns, correlationMatrix: corr, nObservations: 1440 });
  assert.ok(result.breadth);
  assert.ok(Math.abs(result.breadth!.quote_this - 1.2) < 0.3);
});
