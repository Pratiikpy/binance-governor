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

// --- halt tempo: the bridge between the idea gate and the operator's own order policy ---

test("the Monte Carlo halt engine reproduces the closed-form first-passage probability", async () => {
  // The only genuine golden-value test available here. Under Gaussian iid returns the
  // probability that cumulative log-return ever falls b below its start has a closed form
  // (reflection principle, with the Broadie/Glasserman/Kou correction for the fact that a
  // per-bar simulation only checks the barrier at bar ends). If the simulator disagrees
  // with that, the simulator is wrong — every other number it produces is unverifiable.
  const { execFileSync } = await import("node:child_process");
  const script = `
import sys, math, numpy as np
sys.path.insert(0, "idea-gate")
from ruin import halt_tempo, first_passage_analytic_discrete
mu, sigma, H = 0.0004, 0.02, 250
pool = np.expm1(np.random.default_rng(7).normal(mu, sigma, 400_000))
worst = 0.0
for thr in (5.0, 10.0, 15.0, 25.0):
    b = -math.log(1 - thr / 100)
    exact = first_passage_analytic_discrete(mu, sigma, b, H)
    # mean_block=1 makes the resample iid, matching the closed form's assumption; the
    # production default is a real block bootstrap, which is why this is a test-only knob.
    res = halt_tempo(pool, max_drawdown_pct=thr, max_daily_loss_pct=99.0,
                     horizon=H, n_paths=40_000, mean_block=1.0, seed=11)
    z = abs(res["p_first_passage"] - exact) / res["p_first_passage_stderr"]
    worst = max(worst, z)
print(worst)
`;
  const worstZ = Number(execFileSync("python", ["-c", script], { encoding: "utf8" }).trim());
  assert.ok(worstZ < 3, `Monte Carlo disagreed with the closed form by ${worstZ.toFixed(2)} standard errors`);
});

test("halt tempo discriminates a strategy the policy stops constantly from one it does not", async () => {
  const policy = { maxDrawdownPct: 5, maxDailyLossPct: 3 };
  const choppy = await runIdeaGate({ returns: normalReturns(1200, 0.0005, 0.02, 21), nTrials: 1, policy });
  const smooth = await runIdeaGate({ returns: normalReturns(1200, 0.0008, 0.004, 21), nTrials: 1, policy });

  assert.equal(choppy.halt_tempo?.status, "ok");
  assert.equal(smooth.halt_tempo?.status, "ok");
  // The whole reason this replaced a "does it ever breach" check: that one returned 1.0 for
  // everything over a multi-year horizon and could not tell these two apart at all.
  assert.ok(
    choppy.halt_tempo!.survives_30_days! < 0.5,
    `a 2%/day strategy should rarely clear 30 days under a 5% halt, got ${choppy.halt_tempo!.survives_30_days}`,
  );
  assert.ok(
    smooth.halt_tempo!.survives_30_days! > 0.9,
    `a 0.4%/day strategy should almost always clear 30 days, got ${smooth.halt_tempo!.survives_30_days}`,
  );
});

test("halt tempo is reported but never changes the verdict", async () => {
  // Deliberate: "a halt every N days" has no published pass line, and the operator — not
  // this gate — decides whether that tempo is acceptable. A future edit that quietly wires
  // it into the verdict should fail here.
  const returns = normalReturns(1200, 0.0005, 0.02, 33); // halts almost immediately
  const withPolicy = await runIdeaGate({
    returns,
    nTrials: 1,
    claimedEdgeBps: 45,
    policy: { maxDrawdownPct: 5, maxDailyLossPct: 3 },
  });
  const withoutPolicy = await runIdeaGate({ returns, nTrials: 1, claimedEdgeBps: 45 });

  assert.ok(withPolicy.halt_tempo!.survives_30_days! < 0.5, "this fixture must actually halt, or the test proves nothing");
  assert.equal(withPolicy.verdict, withoutPolicy.verdict);
  assert.equal(withPolicy.reason, withoutPolicy.reason);
});

test("halt tempo is simply not run when no policy is supplied", async () => {
  const result = await runIdeaGate({ returns: normalReturns(400, 0.002, 0.01, 5), nTrials: 1 });
  assert.equal(result.halt_tempo, undefined);
});

// --- timing permutation and parameter plateau ---

/** A market that drifts up, and positions with a known relationship to it. */
function marketAndPositions(n: number, seed: number) {
  const market = normalReturns(n, 0.0008, 0.02, seed);
  return { market };
}

test("buy-and-hold on a rising market is NOT significant — exposure is not timing", async () => {
  // The trap this test exists to catch: a long-only strategy on an asset that rose has a positive
  // Sharpe purely from being long. If the null re-discovered "the market went up", every such
  // strategy would pass and the check would be worthless.
  const { market } = marketAndPositions(800, 3);
  const alwaysLong = market.map((_, i) => (i === 0 ? 0 : 1));
  const r = await runIdeaGate({ returns: market, nTrials: 1, positions: alwaysLong, marketReturns: market });
  assert.equal(r.timing_permutation?.status, "ok");
  assert.ok(r.timing_permutation!.actual_sharpe_annual! > 0, "the fixture must actually be profitable, or it proves nothing");
  assert.ok(r.timing_permutation!.p_value! > 0.05, `exposure alone must not read as timing skill, got p=${r.timing_permutation!.p_value}`);
});

test("genuine timing skill IS significant through the same code path", async () => {
  const { market } = marketAndPositions(800, 4);
  const foresight = market.map((r) => (r > 0 ? 1 : 0)); // perfect, deliberately
  const r = await runIdeaGate({ returns: market, nTrials: 1, positions: foresight, marketReturns: market });
  assert.equal(r.timing_permutation?.status, "ok");
  assert.ok(r.timing_permutation!.p_value! < 0.05, `perfect foresight must be significant, got p=${r.timing_permutation!.p_value}`);
  assert.equal(r.timing_permutation!.passes, true);
});

test("the permutation null holds exposure fixed — it only breaks the alignment", async () => {
  const { market } = marketAndPositions(600, 8);
  const positions = market.map((_, i) => (i % 3 === 0 ? 1 : 0));
  const r = await runIdeaGate({ returns: market, nTrials: 1, positions, marketReturns: market });
  // A third of the bars are held, and rotation cannot change that.
  assert.ok(Math.abs(r.timing_permutation!.exposure_fraction! - 1 / 3) < 0.02);
  // Rotation gives at most T-1 distinct permutations; the report must not claim more resolution.
  assert.ok(r.timing_permutation!.n_permutations! <= r.timing_permutation!.max_available_rotations!);
});

test("a constant position is refused rather than scored — there is no timing to test", async () => {
  const { market } = marketAndPositions(300, 9);
  const r = await runIdeaGate({ returns: market, nTrials: 1, positions: market.map(() => 1), marketReturns: market });
  assert.equal(r.timing_permutation?.status, "unsupported");
  assert.match(r.timing_permutation!.reason!, /never changes/);
});

test("the plateau check separates an isolated spike from a genuine region", async () => {
  const spike = [];
  const region = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      spike.push({ i, j, score: i === 2 && j === 2 ? 2 : 0.1 });
      region.push({ i, j, score: 2 - 0.15 * (Math.abs(i - 2) + Math.abs(j - 2)) });
    }
  }
  const winner = spike.findIndex((g) => g.i === 2 && g.j === 2);
  const returns = normalReturns(400, 0.001, 0.01, 12);
  const a = await runIdeaGate({ returns, nTrials: 1, parameterGrid: spike, winnerGridIndex: winner });
  const b = await runIdeaGate({ returns, nTrials: 1, parameterGrid: region, winnerGridIndex: winner });
  assert.ok(a.parameter_plateau!.isolation_sds! > b.parameter_plateau!.isolation_sds! + 1);
  assert.equal(b.parameter_plateau!.neighbours_in_top_quartile, 8);
});

test("the plateau check survives a triangular grid with missing neighbours", async () => {
  // The real sweep only contains fast < slow pairs, so the grid has holes and edge configurations
  // have fewer than eight neighbours. The count that actually existed must be reported, not assumed.
  const grid = [];
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) grid.push({ i, j, score: 1 - 0.1 * j });
  const returns = normalReturns(400, 0.001, 0.01, 13);
  const r = await runIdeaGate({ returns, nTrials: 1, parameterGrid: grid, winnerGridIndex: 0 });
  assert.equal(r.parameter_plateau?.status, "ok");
  assert.ok(r.parameter_plateau!.n_neighbours! < 8, "a corner of a triangular grid cannot have eight neighbours");
});

test("the plateau is reported but never changes the verdict; the permutation test does", async () => {
  const { market } = marketAndPositions(700, 21);
  const grid = [{ i: 0, j: 1, score: 2 }, { i: 0, j: 2, score: 0.1 }, { i: 1, j: 2, score: 0.1 }];
  const noTiming = market.map((_, i) => (i % 2 === 0 ? 1 : 0)); // arbitrary, unrelated to returns

  const plateauOnly = await runIdeaGate({ returns: market, nTrials: 1, claimedEdgeBps: 45, parameterGrid: grid, winnerGridIndex: 0 });
  const bare = await runIdeaGate({ returns: market, nTrials: 1, claimedEdgeBps: 45 });
  assert.equal(plateauOnly.verdict, bare.verdict, "the plateau must not move the verdict");

  const withPerm = await runIdeaGate({ returns: market, nTrials: 1, claimedEdgeBps: 45, positions: noTiming, marketReturns: market });
  assert.equal(withPerm.timing_permutation?.passes, false);
  assert.equal(withPerm.verdict, "UNSUPPORTED");
  assert.match(withPerm.reason, /timing permutation/);
});

test("the family-wise permutation is stricter than the marginal one on a searched sweep", async () => {
  // The point of the correction: the config under test was chosen because it looked best, so its
  // marginal p is optimistic in exactly the way an undeflated Sharpe is. A pure-noise sweep must
  // come back clearly non-significant under the max-statistic null.
  const T = 400;
  const N = 20;
  const market = normalReturns(T, 0.0008, 0.02, 44);
  const matrix: number[][] = [];
  for (let t = 0; t < T; t++) {
    matrix.push(Array.from({ length: N }, (_, n) => (normalReturns(1, 0, 1, t * N + n + 900)[0]! > 0 ? 1 : 0)));
  }
  const r = await runIdeaGate({ returns: market, nTrials: N, positionsMatrix: matrix, marketReturns: market, winnerConfigIndex: 0 });
  assert.equal(r.timing_permutation_family_wise?.status, "ok");
  assert.equal(r.timing_permutation_family_wise!.n_configs, N);
  assert.ok(
    r.timing_permutation_family_wise!.p_value_family_wise! > 0.05,
    `a sweep of pure-noise timings must not be significant, got p=${r.timing_permutation_family_wise!.p_value_family_wise}`,
  );
  assert.equal(r.timing_permutation_family_wise!.passes, false);
});
