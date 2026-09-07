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

export interface IdeaGateResult {
  verdict: "SUPPORTED" | "UNSUPPORTED";
  reason: string;
  dsr?: DsrResult;
  cost_floor?: CostFloorResult;
  breadth?: BreadthResult;
  pbo?: PboResult;
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
