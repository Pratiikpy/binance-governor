// Bridge to the idea gate: can a strategy survive costs at all, before it trades.
//
// The math lives in Python (idea-gate/gate.py), vendored from Bailey & López de Prado's
// own reference implementation — Deflated Sharpe Ratio, Minimum Backtest Length,
// effective breadth — already tested to six decimals against their worked examples.
// Reimplementing that in TypeScript is how a sign error gets introduced twice; shelling
// out to the tested version is not. One process per call, stdin/stdout JSON, no server.

import { spawn } from "node:child_process";
import { join } from "node:path";

export interface IdeaGateRequest {
  /** Per-bar NET returns of the strategy under evaluation. */
  returns: number[];
  /** 365 for a 24/7 crypto market. */
  barsPerYear?: number;
  /** How many configurations were tried before arriving at this one. Honesty input. */
  nTrials?: number;
  /** Variance of annualised Sharpe across those trials. Defaults to a moderate 0.25. */
  varTrialSharpeAnnual?: number;
  /** The edge the caller claims per round trip, in basis points. */
  claimedEdgeBps?: number;
  /** Round trips per period, for a break-even cost search. */
  turnoverPerPeriod?: number[];
  /** Correlation matrix across the symbols traded, for an effective-breadth report. */
  correlationMatrix?: number[][];
  nObservations?: number;
  /**
   * The whole parameter sweep as a (T x N) matrix — column n is configuration n's per-bar
   * return series. Enables the Probability of Backtest Overfitting check, which asks whether
   * the selection procedure itself is picking noise. Without this, PBO simply isn't run.
   */
  sweepMatrix?: number[][];
  /** CSCV group count S (even). 16 suits ~4 years of daily bars; 24 beyond ~6 years. */
  pboNGroups?: number;
  /**
   * This operator's own halt thresholds, straight from `policy.json`. Supplying them turns
   * on the halt-probability check — the only place the idea gate reads the *order* gate's
   * configuration, and the only question in this file that is about deployability under a
   * specific policy rather than about the statistics of the strategy in the abstract.
   */
  policy?: { maxDrawdownPct: number; maxDailyLossPct: number; nPaths?: number };
  /**
   * Per-bar position (0/1, or a weight) and the market series it traded. Supplying both turns on
   * the timing-permutation test — the only check here that separates a real edge from plain market
   * exposure, by asking whether the same days held, placed at random times, would do as well.
   */
  positions?: number[];
  marketReturns?: number[];
  /**
   * Every configuration's position series, (T x N). Supplying it corrects the timing permutation
   * for the size of the search — the analogue of deflating a Sharpe for the trial count.
   */
  positionsMatrix?: number[][];
  winnerConfigIndex?: number;
  /** The sweep laid out on its grid, for parameter-plateau reporting. */
  parameterGrid?: { i: number; j: number; score: number }[];
  winnerGridIndex?: number;
}

export interface DsrResult {
  status: "ok" | "unsupported";
  reason: string | null;
  dsr: number | null;
  psr_zero: number | null;
  sr_annual: number | null;
  sr_star_annual: number | null;
  n_trials: number;
  n_obs: number;
  years_held: number;
  min_backtest_years: number | null;
  required_sharpe_annual: number | null;
  record_sufficient: boolean | null;
  backtest_long_enough: boolean | null;
  passes: boolean | null;
}

export interface CostFloorResult {
  round_trip_bps: number;
  claimed_edge_bps: number;
  net_edge_bps: number;
  required_hit_rate_for_this_barrier: number;
  passes: boolean;
  detail: string;
}

export interface BreadthResult {
  n_assets: number;
  rho_bar: number;
  participation_ratio: number;
  independent_bets_raw: number;
  quote_this: number;
  detail: string;
}

export interface PboResult {
  status: "ok" | "unsupported";
  reason?: string;
  pbo?: number;
  n_configs?: number;
  n_combinations?: number;
  prob_oos_loss?: number;
  frac_oos_negative?: number;
  granularity_ok?: boolean;
  passes?: boolean;
  detail?: string;
}

/** One percentile of the time-to-first-halt distribution. `censored` means the simulation
 *  ran out of horizon before that percentile halted — the number is a lower bound, not a value. */
export interface TimingPermutationResult {
  status: "ok" | "unsupported";
  reason?: string;
  actual_sharpe_annual?: number;
  null_mean_sharpe?: number;
  null_p95_sharpe?: number;
  n_permutations?: number;
  max_available_rotations?: number;
  p_value?: number;
  exposure_fraction?: number;
  passes?: boolean;
  detail?: string;
  method?: string;
}

export interface FamilyWisePermutationResult {
  status: "ok" | "unsupported";
  reason?: string;
  n_configs?: number;
  n_permutations?: number;
  observed_best_sharpe?: number;
  observed_winner_sharpe?: number;
  null_max_mean?: number;
  null_max_p95?: number;
  p_value_family_wise?: number;
  passes?: boolean;
  detail?: string;
  method?: string;
}

export interface ParameterPlateauResult {
  status: "ok" | "unsupported";
  reason?: string;
  winner_score?: number;
  n_neighbours?: number;
  neighbour_mean_score?: number;
  neighbour_min_score?: number;
  neighbour_max_score?: number;
  sweep_sd?: number;
  isolation_sds?: number | null;
  neighbours_in_top_quartile?: number;
  detail?: string;
  reporting_note?: string;
}

export interface WalkForwardResult {
  status: "ok" | "unsupported";
  reason?: string;
  in_sample_bars?: number;
  out_of_sample_bars?: number;
  selected_config_index?: number;
  in_sample_sharpe_annual?: number;
  out_of_sample_sharpe_annual?: number;
  walk_forward_efficiency?: number | null;
  edge_survived?: boolean;
  passes?: boolean;
  detail?: string;
  caveat?: string;
}

export interface HaltTimePercentile {
  bars: number;
  censored: boolean;
}

export interface HaltTempoResult {
  status: "ok" | "unsupported";
  reason?: string;
  n_paths?: number;
  horizon_bars?: number;
  mean_block?: number;
  bars_per_day?: number;
  max_drawdown_pct?: number;
  max_daily_loss_pct?: number;
  p_halt_within_horizon?: number;
  p_halt_within_horizon_stderr?: number;
  bars_to_first_halt?: { p05: HaltTimePercentile; p25: HaltTimePercentile; median: HaltTimePercentile; p75: HaltTimePercentile };
  survives_30_days?: number;
  survives_90_days?: number;
  share_of_halts_caused_by_drawdown?: number;
  p_first_passage?: number;
  p_first_passage_stderr?: number;
  detail?: string;
  reporting_note?: string;
  method?: string;
}

export interface IdeaGateResult {
  verdict: "SUPPORTED" | "UNSUPPORTED";
  reason: string;
  dsr?: DsrResult;
  cost_floor?: CostFloorResult;
  breadth?: BreadthResult;
  pbo?: PboResult;
  walk_forward?: WalkForwardResult;
  timing_permutation?: TimingPermutationResult;
  timing_permutation_family_wise?: FamilyWisePermutationResult;
  parameter_plateau?: ParameterPlateauResult;
  halt_tempo?: HaltTempoResult;
  dsr_accept_threshold?: number;
}

const GATE_SCRIPT = join(process.cwd(), "idea-gate", "gate.py");

/**
 * Run the idea gate. Never throws on a bad verdict — an UNSUPPORTED result is a normal,
 * expected answer, not a failure. Only a transport problem (Python missing, the process
 * refusing to start) throws, and even then the caller should treat "the gate could not
 * run" the same as "the gate said no": fail closed, never trade on an unanswered question.
 */
export function runIdeaGate(req: IdeaGateRequest, pythonBin = "python"): Promise<IdeaGateResult> {
  const payload = {
    returns: req.returns,
    bars_per_year: req.barsPerYear ?? 365,
    n_trials: req.nTrials ?? 1,
    var_trial_sharpe_annual: req.varTrialSharpeAnnual ?? 0.25,
    ...(req.claimedEdgeBps !== undefined ? { claimed_edge_bps: req.claimedEdgeBps } : {}),
    ...(req.turnoverPerPeriod ? { turnover_per_period: req.turnoverPerPeriod } : {}),
    ...(req.correlationMatrix ? { correlation_matrix: req.correlationMatrix } : {}),
    ...(req.nObservations !== undefined ? { n_observations: req.nObservations } : {}),
    ...(req.sweepMatrix ? { sweep_matrix: req.sweepMatrix } : {}),
    ...(req.pboNGroups !== undefined ? { pbo_n_groups: req.pboNGroups } : {}),
    ...(req.positions ? { positions: req.positions } : {}),
    ...(req.marketReturns ? { market_returns: req.marketReturns } : {}),
    ...(req.positionsMatrix ? { positions_matrix: req.positionsMatrix } : {}),
    ...(req.winnerConfigIndex !== undefined ? { winner_config_index: req.winnerConfigIndex } : {}),
    ...(req.parameterGrid ? { parameter_grid: req.parameterGrid } : {}),
    ...(req.winnerGridIndex !== undefined ? { winner_grid_index: req.winnerGridIndex } : {}),
    ...(req.policy
      ? {
          policy: {
            max_drawdown_pct: req.policy.maxDrawdownPct,
            max_daily_loss_pct: req.policy.maxDailyLossPct,
            ...(req.positions ? { positions: req.positions } : {}),
    ...(req.marketReturns ? { market_returns: req.marketReturns } : {}),
    ...(req.positionsMatrix ? { positions_matrix: req.positionsMatrix } : {}),
    ...(req.winnerConfigIndex !== undefined ? { winner_config_index: req.winnerConfigIndex } : {}),
    ...(req.parameterGrid ? { parameter_grid: req.parameterGrid } : {}),
    ...(req.winnerGridIndex !== undefined ? { winner_grid_index: req.winnerGridIndex } : {}),
    ...(req.policy.nPaths !== undefined ? { n_paths: req.policy.nPaths } : {}),
          },
        }
      : {}),
  };

  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [GATE_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("idea gate timed out after 30s"));
    }, 30_000);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`could not start idea gate (${pythonBin} on PATH?): ${err.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        reject(new Error(`idea gate produced no output. stderr: ${stderr.slice(0, 2000)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split("\n").pop()!) as IdeaGateResult);
      } catch (err) {
        reject(new Error(`idea gate returned non-JSON: ${stdout.slice(0, 500)} (${String(err)})`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}
