#!/usr/bin/env python3
"""The idea gate: can this strategy survive costs at all, before it ever trades?

Called as a subprocess from the TypeScript Governor (``src/idea-gate/client.ts``),
one JSON object in on stdin, one JSON object out on stdout. Kept as a subprocess
rather than ported to TypeScript on purpose — this is Bailey & Lopez de Prado's own
math, vendored from ``okx/trading/validation`` where it is already tested against
their worked examples to six decimals. Reimplementing it in a second language is
how a sign error gets introduced; calling the tested version is not.

Input shape (stdin, one line of JSON)::

    {
      "returns": [r0, r1, ...],        // per-bar NET returns of the strategy, required
      "bars_per_year": 365,            // 365 for a 24/7 spot market
      "n_trials": 1,                   // how many configurations were tried to find this one
      "var_trial_sharpe_annual": 0.25, // variance of annualised Sharpe across those trials
      "claimed_edge_bps": 8.0,         // OPTIONAL: the edge the caller claims per round trip
      "turnover_per_period": [...],    // OPTIONAL: round trips per bar, for break-even search
      "correlation_matrix": [[...]],   // OPTIONAL: for effective-breadth reporting
      "n_observations": 1440,          // OPTIONAL: sample size backing the correlation matrix
      "positions": [0, 1, ...],        // OPTIONAL: per-bar position, for the timing permutation test
      "market_returns": [...],         // OPTIONAL: the underlying series those positions traded
      "parameter_grid": [              // OPTIONAL: the sweep laid out on its grid, for plateau
        {"i": 0, "j": 3, "score": 1.2}
      ],
      "winner_grid_index": 12,
      "policy": {                      // OPTIONAL: this operator's own halt thresholds
        "max_drawdown_pct": 5.0,       //   -> enables the halt-tempo report (informational)
        "max_daily_loss_pct": 3.0
      }
    }

Output shape (stdout, one line of JSON)::

    {
      "verdict": "SUPPORTED" | "UNSUPPORTED",
      "reason": "...",
      "dsr": {...},          // full DSRResult
      "cost_floor": {...},   // present only when claimed_edge_bps was given
      "breadth": {...},      // present only when correlation_matrix was given
      "halt_tempo": {...}    // present only when policy was given; informational, never gates
    }

The verdict is SUPPORTED only when every check that was actually run passes. A
check that could not run (no edge claimed, no correlation matrix given) is skipped,
never counted as a pass — see ``_all_available_checks_passed``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "vendor"))

from deflated_sharpe import DSR_ACCEPT, deflated_sharpe_ratio  # noqa: E402
from cost_model import RoundTripCostModel, break_even_cost_bps, required_precision  # noqa: E402
from binance_spot import BINANCE_SPOT_VIP0  # noqa: E402
from breadth import enb_independent_bets, enb_participation_ratio, enb_rho_bar  # noqa: E402
from pbo import cscv  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))

from ruin import halt_tempo  # noqa: E402
from robustness import family_wise_timing_permutation, parameter_plateau, timing_permutation  # noqa: E402

import numpy as np  # noqa: E402
import math  # noqa: E402


def _json_safe(value):
    """Replace non-finite floats with null. ``json.dumps`` happily emits the Python
    literals ``Infinity``/``NaN``, which are not valid JSON and every strict parser
    (including JS ``JSON.parse``) rejects them. An unreachable MinTRL is a real,
    meaningful result — "no amount of data helps" — so it must survive the trip, not
    crash the caller.
    """
    if isinstance(value, float):
        return None if not math.isfinite(value) else value
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    return value


def _cost_floor_check(claimed_edge_bps: float, turnover_per_period: list[float] | None) -> dict:
    """Does the claimed edge survive Binance spot's real 20 bps round trip?"""
    model = RoundTripCostModel(fees=BINANCE_SPOT_VIP0)
    round_trip_bps = model.total_bps()
    net_edge_bps = model.net_edge_bps(claimed_edge_bps)
    required_hit_rate = required_precision(barrier_pct=abs(claimed_edge_bps) / 100.0 or 0.01, round_trip_bps=round_trip_bps)

    result = {
        "round_trip_bps": round_trip_bps,
        "claimed_edge_bps": claimed_edge_bps,
        "net_edge_bps": net_edge_bps,
        "required_hit_rate_for_this_barrier": required_hit_rate,
        "passes": net_edge_bps > 0,
        "detail": (
            f"net edge {net_edge_bps:+.3f} bps = claimed {claimed_edge_bps:.3f} - "
            f"round-trip {round_trip_bps:.3f} (Binance spot, 10bps/10bps live commission)"
        ),
    }

    if turnover_per_period:
        # Break-even search needs per-period gross returns; approximate from the
        # claimed edge applied at each declared round trip.
        gross = [claimed_edge_bps / 1e4 * t for t in turnover_per_period]
        be = break_even_cost_bps(gross, turnover_per_period)
        result["break_even_search"] = {
            "status": be.status,
            "break_even_bps": be.break_even_bps,
            "detail": be.detail,
        }

    return result


def _breadth_check(correlation_matrix: list[list[float]], n_observations: int | None) -> dict:
    corr = np.asarray(correlation_matrix, dtype=float)
    n = corr.shape[0]
    off_diag = corr[~np.eye(n, dtype=bool)]
    rho_bar = float(np.mean(off_diag)) if off_diag.size else 0.0
    participation = enb_participation_ratio(corr)
    independent_bets = enb_independent_bets(corr, n_observations=n_observations)
    formula_bets = enb_rho_bar(n, rho_bar)

    return {
        "n_assets": n,
        "rho_bar": rho_bar,
        "participation_ratio": participation,
        "independent_bets_raw": independent_bets,
        "independent_bets_formula": formula_bets,
        "quote_this": participation if n > 20 else formula_bets,
        "detail": (
            f"{n} assets at rho_bar={rho_bar:.3f} carry roughly "
            f"{(participation if n > 20 else formula_bets):.2f} independent bets, not {n}"
        ),
    }


def _pbo_check(sweep_matrix: list[list[float]], n_groups: int) -> dict:
    """Probability of Backtest Overfitting, via Combinatorially Symmetric Cross-Validation.

    DSR asks "is this Sharpe better than the best of N noise draws?". PBO asks a different
    and harder question: "is my selection procedure adding value, or picking noise?" — by
    checking how often the in-sample winner lands below the out-of-sample median across
    every symmetric split. They fail differently, which is why both are worth running.

    Needs the WHOLE sweep, not just the winner: a (T x N) matrix where column n is the
    per-bar return series of configuration n. That is exactly what a real parameter sweep
    produces and exactly what a builder usually throws away after picking the best one.
    """
    m = np.asarray(sweep_matrix, dtype=float)
    if m.ndim != 2 or m.shape[1] < 2:
        return {"status": "unsupported", "reason": "need a (T, N) matrix with at least 2 configurations"}
    result = cscv(m, n_groups=n_groups)
    # The paper's own reject line is phi > 0.05. Below ~10 configurations the logit is too
    # coarse for that threshold to mean much, which the module flags rather than hiding.
    return {
        "status": "ok",
        "pbo": result.pbo,
        "n_configs": result.n_configs,
        "n_groups": result.n_groups,
        "n_combinations": result.n_combinations,
        "prob_oos_loss": result.prob_oos_loss,
        "frac_oos_negative": result.frac_oos_negative,
        "granularity_ok": bool(result.granularity_ok),
        "passes": bool(result.pbo <= 0.5),
        "detail": (
            f"PBO {result.pbo:.4f} across {result.n_configs} configs / {result.n_combinations} splits; "
            f"the in-sample winner lands below the out-of-sample median {result.pbo * 100:.1f}% of the time"
            + ("" if result.granularity_ok else " (N < 10: logit granularity too coarse to trust the exact value)")
        ),
    }


def _walk_forward_check(sweep_matrix: list[list[float]], is_fraction: float, bars_per_year: int) -> dict:
    """Anchored walk-forward: pick the winner on early data only, judge it on data it never saw.

    This is partially redundant with PBO and worth being honest about that. CSCV already
    recombines slices into C(S, S/2) in/out splits. But its splits are SYMMETRIC — roughly half of
    them select on chronologically LATER slices and test on EARLIER ones, which never happens in
    deployment. Bailey/Borwein/Lopez de Prado/Zhu concede in their own limitations section that
    CSCV cannot detect structural breaks or regime shifts because it treats the sample as one
    regime.

    A single forward-only holdout tests exactly the thing CSCV structurally cannot: causal,
    chronological generalisation. It is not a hypothesis test — no null, no p-value, and no
    published significance threshold for walk-forward efficiency exists. It is reported as a
    diagnostic and it does not, on its own, decide the verdict.
    """
    m = np.asarray(sweep_matrix, dtype=float)
    if m.ndim != 2 or m.shape[1] < 2:
        return {"status": "unsupported", "reason": "need a (T, N) matrix with at least 2 configurations"}

    T = m.shape[0]
    split = int(T * is_fraction)
    if split < 30 or (T - split) < 30:
        return {"status": "unsupported", "reason": f"too few bars either side of the split (in-sample {split}, out-of-sample {T - split}; need 30 each)"}

    in_sample, out_of_sample = m[:split], m[split:]

    def annualised_sharpe(block: np.ndarray) -> np.ndarray:
        mean = block.mean(axis=0)
        sd = block.std(axis=0)
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(sd > 0, mean / sd * np.sqrt(bars_per_year), 0.0)

    is_sharpe = annualised_sharpe(in_sample)
    oos_sharpe = annualised_sharpe(out_of_sample)

    # The selection happens on early data ONLY. That is the entire point: the winner is chosen
    # without ever seeing the segment it is then judged on.
    winner = int(np.argmax(is_sharpe))
    winner_is = float(is_sharpe[winner])
    winner_oos = float(oos_sharpe[winner])

    # Walk-forward efficiency, Pardo's ratio. Reported because it is the number people expect;
    # flagged because no source gives it a pass/fail threshold or a false-positive rate.
    wfe = (winner_oos / winner_is) if winner_is > 0 else float("nan")
    survived = winner_oos > 0

    return {
        "status": "ok",
        "in_sample_bars": split,
        "out_of_sample_bars": T - split,
        "selected_config_index": winner,
        "in_sample_sharpe_annual": winner_is,
        "out_of_sample_sharpe_annual": winner_oos,
        "walk_forward_efficiency": wfe,
        "edge_survived": bool(survived),
        "passes": bool(survived),
        "detail": (
            f"config #{winner} was selected on the first {split} bars (Sharpe {winner_is:.3f}) and scored "
            f"{winner_oos:.3f} on the {T - split} bars it never saw"
            + ("" if survived else " (the edge did not survive going forward)")
        ),
        "caveat": "A diagnostic, not a hypothesis test. No published significance threshold exists for walk-forward efficiency, so a good number here is not evidence on its own.",
    }


def _halt_tempo_report(returns, policy: dict, bars_per_year: int) -> dict:
    """How long does this strategy run before the operator's own halts stop it?

    The only thing in this file that reads the *order* gate's policy. Every other statistic
    here judges a strategy against the literature; this one judges it against the limits this
    particular operator agreed to sit through — a different, more operational question, and
    one that cannot be asked without both gates in the same product.

    Reported, never gated. See ``ruin.py`` for why.
    """
    return halt_tempo(
        returns,
        max_drawdown_pct=float(policy.get("max_drawdown_pct", 5.0)),
        max_daily_loss_pct=float(policy.get("max_daily_loss_pct", 3.0)),
        bars_per_year=bars_per_year,
        n_paths=int(policy.get("n_paths", 20_000)),
    )


def _robustness_checks(payload: dict, bars_per_year: int, out: dict, checks_run: list[bool]) -> None:
    """Two questions the vendored statistics do not ask. See ``robustness.py``.

    The permutation test IS gated — it has a null, a p-value and the conventional 0.05 line. The
    plateau is not, for the same reason breadth and halt tempo are not: no published threshold.
    """
    positions = payload.get("positions")
    market_returns = payload.get("market_returns")
    if positions and market_returns:
        perm = timing_permutation(positions, market_returns, bars_per_year=bars_per_year)
        out["timing_permutation"] = perm
        if perm.get("status") == "ok":
            checks_run.append(perm["passes"])

    # The whole sweep's positions, when supplied: corrects the marginal p above for the fact that
    # the configuration under test is the best of N, not one chosen a priori. Same logic as
    # deflating a Sharpe for the trial count, applied to the permutation null.
    pos_matrix = payload.get("positions_matrix")
    if pos_matrix and market_returns:
        fam = family_wise_timing_permutation(
            pos_matrix, market_returns,
            winner_index=int(payload.get("winner_config_index", 0)),
            bars_per_year=bars_per_year,
        )
        out["timing_permutation_family_wise"] = fam
        if fam.get("status") == "ok":
            checks_run.append(fam["passes"])

    grid = payload.get("parameter_grid")
    winner = payload.get("winner_grid_index")
    if grid and winner is not None:
        out["parameter_plateau"] = parameter_plateau(grid, winner_index=int(winner))


def run(payload: dict) -> dict:
    returns = payload.get("returns")
    if not returns or len(returns) < 2:
        return {
            "verdict": "UNSUPPORTED",
            "reason": "insufficient-observations",
            "detail": "need at least 2 per-bar returns to compute anything",
        }

    bars_per_year = int(payload.get("bars_per_year", 365))
    n_trials = int(payload.get("n_trials", 1))
    var_trial_sharpe_annual = float(payload.get("var_trial_sharpe_annual", 0.25))

    dsr_result = deflated_sharpe_ratio(
        returns,
        n_trials=n_trials,
        var_trial_sharpe_annual=var_trial_sharpe_annual,
        bars_per_year=bars_per_year,
        trials_source=payload.get("trials_source", "declared"),
    )

    checks_run: list[bool] = []
    out: dict = {"dsr": dsr_result.as_dict()}

    if dsr_result.status == "ok":
        checks_run.append(dsr_result.passes)
    else:
        checks_run.append(False)
        out["dsr_reason"] = dsr_result.reason

    claimed_edge_bps = payload.get("claimed_edge_bps")
    if claimed_edge_bps is not None:
        cost = _cost_floor_check(float(claimed_edge_bps), payload.get("turnover_per_period"))
        out["cost_floor"] = cost
        checks_run.append(cost["passes"])

    sweep = payload.get("sweep_matrix")
    if sweep:
        pbo_result = _pbo_check(sweep, int(payload.get("pbo_n_groups", 16)))
        out["pbo"] = pbo_result
        if pbo_result["status"] == "ok":
            checks_run.append(pbo_result["passes"])

        wf_result = _walk_forward_check(sweep, float(payload.get("walk_forward_is_fraction", 0.75)), bars_per_year)
        out["walk_forward"] = wf_result
        if wf_result["status"] == "ok":
            checks_run.append(wf_result["passes"])

    _robustness_checks(payload, bars_per_year, out, checks_run)

    policy = payload.get("policy")
    if policy:
        # Informational, exactly like breadth below: it tells the operator what operating
        # tempo to expect under the policy they already wrote, but "a halt every N days" has
        # no published pass line and inventing one would be a convention wearing a
        # statistic's clothes. Deliberately not added to checks_run.
        out["halt_tempo"] = _halt_tempo_report(returns, policy, bars_per_year)

    corr = payload.get("correlation_matrix")
    if corr:
        out["breadth"] = _breadth_check(corr, payload.get("n_observations"))
        # Breadth is informational — it changes how a passing result should be read,
        # but a small breadth number does not itself fail a strategy that already
        # cleared DSR and the cost floor. Not added to checks_run.

    supported = all(checks_run)
    out["verdict"] = "SUPPORTED" if supported else "UNSUPPORTED"
    out["reason"] = (
        "all available checks passed"
        if supported
        else _explain_failure(
            dsr_result,
            out.get("cost_floor"),
            out.get("pbo"),
            out.get("walk_forward"),
            out.get("timing_permutation"),
            out.get("timing_permutation_family_wise"),
        )
    )
    out["dsr_accept_threshold"] = DSR_ACCEPT
    return out


def _explain_failure(
    dsr_result,
    cost_floor: dict | None,
    pbo_result: dict | None = None,
    wf_result: dict | None = None,
    perm_result: dict | None = None,
    family_result: dict | None = None,
) -> str:
    reasons = []
    if dsr_result.status != "ok":
        reasons.append(f"DSR unsupported: {dsr_result.reason}")
    elif not dsr_result.passes:
        reasons.append(
            f"DSR {dsr_result.dsr:.4f} < {DSR_ACCEPT} required, OR "
            f"MinBTL {dsr_result.min_backtest_years:.2f}y > {dsr_result.years_held:.2f}y held"
        )
    if cost_floor is not None and not cost_floor["passes"]:
        reasons.append(f"net edge after costs is {cost_floor['net_edge_bps']:+.3f} bps (must be > 0)")
    if pbo_result is not None and pbo_result.get("status") == "ok" and not pbo_result["passes"]:
        reasons.append(f"PBO {pbo_result['pbo']:.4f} — the selection is picking noise more often than signal")
    if wf_result is not None and wf_result.get("status") == "ok" and not wf_result["passes"]:
        reasons.append(
            f"walk-forward: the config chosen on early data scored {wf_result['out_of_sample_sharpe_annual']:.3f} "
            f"annualised Sharpe on the {wf_result['out_of_sample_bars']} bars it never saw"
        )
    if perm_result is not None and perm_result.get("status") == "ok" and not perm_result["passes"]:
        reasons.append(
            f"timing permutation: p = {perm_result['p_value']:.4f} — the same exposure placed at random "
            f"times scores {perm_result['null_mean_sharpe']:.3f} against the real timing's {perm_result['actual_sharpe_annual']:.3f}"
        )
    if family_result is not None and family_result.get("status") == "ok" and not family_result["passes"]:
        reasons.append(
            f"family-wise timing permutation: p = {family_result['p_value_family_wise']:.4f} across all "
            f"{family_result['n_configs']} configurations searched"
        )
    return "; ".join(reasons) if reasons else "unknown"


def main() -> None:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"verdict": "UNSUPPORTED", "reason": f"invalid-json-input: {e}"}))
        sys.exit(1)

    try:
        result = run(payload)
    except Exception as e:  # fail closed: a crash is UNSUPPORTED, never a silent pass
        print(json.dumps({
            "verdict": "UNSUPPORTED",
            "reason": f"internal-error: {type(e).__name__}: {e}",
        }))
        sys.exit(0)

    print(json.dumps(_json_safe(result)))


if __name__ == "__main__":
    main()
