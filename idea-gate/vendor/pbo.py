"""Probability of Backtest Overfitting via Combinatorially Symmetric Cross-Validation.

WHAT IT ANSWERS
===============

Not "is this strategy good". PBO answers **"is my selection procedure adding value,
or is it choosing noise?"** — by measuring how the in-sample winner ranks
out-of-sample, across every symmetric split of the sample.

Bailey, Borwein, López de Prado & Zhu (2015), *The Probability of Backtest
Overfitting*, J. Computational Finance 20(4). Read as primary text; the notes are in
``best-of-the-best/papers/01-validation-canon.md`` §1.

    Definition 2.1 (Backtest Overfitting). "We say that the backtest strategy
    selection process overfits if a strategy with optimal performance IS has an
    expected ranking below the median OOS."

    Definition 2.2 (PBO). φ = Σₙ Prob[r̄ₙ < N/2 | r ∈ Ω*ₙ] · Prob[r ∈ Ω*ₙ].

φ ≈ 0 means selection adds value. φ ≈ 1 means it is actively destructive. Their
suggested reject line is φ > 0.05 — **which is not reachable at our config count;
see the null-calibration section below.**

THE ALGORITHM (their Algorithm 2.3, implemented step for step)
==============================================================

1. Build ``M``, a real ``(T × N)`` matrix. Column *n* is the per-period performance
   series of trial *n*. Two hard conditions: the same rows for every column
   (observations synchronous across trials), and a metric estimable on subsamples of
   a column.
2. Partition ``M`` **across rows** into an even number ``S`` of disjoint contiguous
   submatrices. **Row order is preserved — no shuffling.** That is why CSCV survives
   serial correlation, and it is the property that distinguishes it from a bootstrap.
3. Form all ``C(S, S/2)`` combinations of those submatrices taken ``S/2`` at a time.
4. For each combination *c*: the training set ``J`` is those ``S/2`` submatrices
   joined **in their original order**, the test set ``J̄`` is the complement, also in
   original order. Compute the metric on each of the ``N`` columns of both. Take
   ``n*`` = the in-sample argmax, find its out-of-sample rank ``r̄``, form the
   relative rank ``ω = r̄/(N+1) ∈ (0,1)`` and the logit ``λ = ln(ω/(1−ω))``.
5. ``φ = Prob[λ < 0]`` — the share of splits where the in-sample winner lands below
   the out-of-sample median.

*Why the logit.* It is the inverse of the logistic CDF, which resembles the standard
normal. If ω is uniform — the information-less case — the logits are approximately
standard normal, so the null has a known shape and "λ centred well above 0 with a
thin left tail" is what a real edge looks like.

FOUR OUTPUTS, NOT ONE
=====================

PBO is almost always reported as a single φ. The paper defines four (§1.4 of our
paper note), and this module returns all of them:

1. **φ** — the PBO itself.
2. **Performance degradation** — OLS of the selected config's OOS performance on its
   IS performance, across combinations. Their worked example: 100% of IS Sharpes
   positive, ranging 1-3, and **78% of OOS Sharpes negative**.

   **Read the slope with care; it does not mean what it looks like.**
   ``purgedcv`` documents its equivalent as *"< 0 means in-sample strength predicts
   out-of-sample weakness (severe overfit)"* and that is backwards. Because the two
   halves are complementary, the slope goes to **−1 precisely when one configuration
   dominates every split, i.e. when the edge is real.** Reproduced here on our own
   implementation, which shares no code with theirs: on a matrix with a planted
   drift the slope is **−0.9995 with φ = 0.0000**, while on pure noise it is
   **−0.4255 with φ = 0.5096**. Report ``pbo``; treat ``degradation_slope`` as
   descriptive only. ``tests/test_pbo.py::test_degradation_slope_is_not_an_overfit_measure``
   pins this so nobody re-learns it.
3. **Probability of loss** — ``Prob[R̄_{n*} < 0]``. Explicitly from the paper: *"even
   if φ ≈ 0, Prob[R̄ < 0] could be high, in which case the strategy's performance OOS
   is poor for reasons other than overfitting."*
4. **Stochastic dominance** — is our selection procedure better than picking a
   variant at random? First and second order, against the mean-across-configs OOS
   distribution.

WHAT PBO CANNOT DETECT — the paper's own list, and it is the important part
==========================================================================

* **It does not evaluate the correctness of a backtest.** Wrong fees, lookahead,
  same-bar fills, a fabricated price: φ says nothing. It measures *selection*, not
  *simulation*. Our own +90%-to-−0.45% replay gap would have a perfectly healthy φ.
* **The file-drawer problem is fatal.** *"Hiding trials will lead to an
  underestimation of the overfit."* This is why ``trial_ledger.py`` exists.
* **High PBO does not mean no skill.** If all N strategies are genuinely good and
  similar, φ is high because none dominates — "overfitting among many skilful
  strategies".
* **Structural breaks outside the window are invisible.**
* **Never optimise against PBO.** *"When a measure becomes a target, it ceases to be
  a good measure"* (Strathern). Using CSCV to search for a configuration is, in the
  authors' words, *"a gross misuse of our method."*

TWO HARD CONSTRAINTS ON US
==========================

* **T must be double the selection sample.** p.22: PBO compares combinations of T/2
  observations with their complements, so ``T`` should be twice the number of
  observations used to choose a configuration. We hold T = 1440 daily bars per
  symbol, so **an honest CSCV may select on at most 720 of them.** See
  :func:`max_selection_window`.
* **φ has no usable null at our config count.** Measured on shuffled pure-noise
  configs (``notes/20-validation-stats.md``): at n=480 observations φ spans
  **0.26-0.90** across seeds, median 0.56. A single φ of 0.4 or 0.7 sits inside the
  noise band and means nothing. :func:`pbo_null_distribution` calibrates your own
  null; quote φ against it, never against the paper's 0.05.

One correction to the paper, verified by reading p.22 as an image so it is not an OCR
artefact: it prints ``C(16,8) = 12,780`` twice. The true value is **12,870**.
:func:`n_combinations` returns the true value and the test suite pins it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import combinations
from math import comb
from typing import Callable, Sequence

import numpy as np
from scipy import stats

__all__ = [
    "PBOResult",
    "cscv",
    "n_combinations",
    "max_selection_window",
    "pbo_null_distribution",
]


def n_combinations(n_groups: int) -> int:
    """``C(S, S/2)`` — the number of symmetric splits at ``S`` groups.

    S=12 -> 924, S=16 -> **12,870** (the paper says 12,780; it is wrong),
    S=24 -> 2,704,156.
    """
    if n_groups % 2 or n_groups < 2:
        raise ValueError("n_groups must be a positive even integer")
    return comb(n_groups, n_groups // 2)


def max_selection_window(n_obs: int) -> int:
    """Largest honest selection sample given ``n_obs`` total observations.

    The paper's own requirement (p.22): the backtest works with T observations but
    PBO compares T/2 against its complement, so T must be **double** the sample used
    to choose a configuration. At our T = 1440 daily bars this caps every
    walk-forward design at a 720-bar selection window.
    """
    return int(n_obs) // 2


# --------------------------------------------------------------------------- #
# Result
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class PBOResult:
    """All four CSCV outputs plus the diagnostics needed to judge them."""

    pbo: float
    n_configs: int
    n_groups: int
    n_combinations: int
    n_obs_used: int
    n_obs_dropped: int
    logits: np.ndarray = field(repr=False)
    relative_ranks: np.ndarray = field(repr=False)
    is_best_config: np.ndarray = field(repr=False)
    is_performance: np.ndarray = field(repr=False)
    oos_performance: np.ndarray = field(repr=False)
    oos_performance_random_pick: np.ndarray = field(repr=False)
    degradation_slope: float
    degradation_intercept: float
    degradation_r2: float
    prob_oos_loss: float
    first_order_dominance: bool
    second_order_dominance: bool
    sd2_min: float
    frac_is_positive: float
    frac_oos_negative: float
    granularity_ok: bool

    def report(self) -> str:
        lines = [
            f"PBO (phi)                      {self.pbo:.4f}",
            f"  configs N                    {self.n_configs}"
            + ("" if self.granularity_ok else "   <- N < 10: logit granularity too coarse"),
            f"  groups S / combinations      {self.n_groups} / {self.n_combinations}",
            f"  observations used / dropped  {self.n_obs_used} / {self.n_obs_dropped}",
            f"performance degradation slope  {self.degradation_slope:+.4f} (r2 {self.degradation_r2:.4f})"
            "   [descriptive only - NOT an overfit measure]",
            f"Prob[OOS < 0] for the IS pick  {self.prob_oos_loss:.4f}",
            f"IS positive / OOS negative     {self.frac_is_positive:.2%} / {self.frac_oos_negative:.2%}",
            f"stochastic dominance 1st / 2nd {self.first_order_dominance} / {self.second_order_dominance}"
            f"   (min SD2 integral {self.sd2_min:+.6g})",
            "NOTE: phi has no usable null at small N - calibrate with pbo_null_distribution().",
        ]
        return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #


def _sharpe_columns(block: np.ndarray) -> np.ndarray:
    """Per-observation Sharpe of every column. ``ddof=0``, consistent everywhere."""
    mean = block.mean(axis=0)
    sd = block.std(axis=0, ddof=0)
    out = np.zeros_like(mean)
    ok = sd > 0
    out[ok] = mean[ok] / sd[ok]
    return out


# --------------------------------------------------------------------------- #
# CSCV
# --------------------------------------------------------------------------- #


def cscv(
    performance: np.ndarray,
    *,
    n_groups: int = 16,
    metric: str | Callable[[np.ndarray], np.ndarray] = "sharpe",
    max_combinations: int = 200_000,
) -> PBOResult:
    """Combinatorially Symmetric Cross-Validation.

    Parameters
    ----------
    performance
        ``(T, N)`` matrix. Column *n* is the per-period performance series
        (typically net-of-fee returns) of configuration *n*. Rows must be
        synchronous across columns — the same period in every column.
    n_groups
        ``S``, even. The paper recommends 16 for ~4 years of daily data (it
        preserves quarterly structure) and 24 beyond 6 years. Cost is
        ``C(S, S/2)`` combinations.
    metric
        ``"sharpe"`` uses an exact moment-accumulation fast path: per-group sums and
        sums of squares are computed once, so evaluating a combination is O(S/2)
        rather than O(T). A callable takes a ``(rows, N)`` block and returns ``N``
        statistics — use it for order-dependent metrics such as return-over-maximum-
        drawdown, which the paper explicitly warns are sensitive to how J and J̄ are
        assembled.
    max_combinations
        A guard, not a preference. ``S=20`` is 184,756 combinations and ``S=24`` is
        2.7 million; raise this deliberately if you mean it.

    Notes
    -----
    Rows that do not divide evenly into ``S`` groups are dropped from the **end** and
    reported in ``n_obs_dropped``. Dropping from the end preserves the oldest data,
    which is the conservative choice for a walk-forward-shaped sample.
    """
    M = np.asarray(performance, dtype=float)
    if M.ndim != 2:
        raise ValueError("performance must be a 2-D (T, N) matrix")
    T, N = M.shape
    if N < 2:
        raise ValueError("CSCV needs at least 2 configurations")
    if N > T:
        # Orientation guard. This module follows the paper's Algorithm 2.3, where M
        # is (T x N) and column n is trial n's PnL series. `purgedcv` takes the
        # transpose, (n_configs x n_obs), and neither library can tell a transposed
        # matrix from a legitimate one — it just returns a plausible phi. Since CSCV
        # ranks N configurations on T/2 rows, more configurations than observations
        # is never informative, so refusing here costs nothing and catches the swap.
        raise ValueError(
            f"performance is ({T}, {N}): more configurations than observations. "
            "This module expects (n_obs, n_configs) — column n is trial n's series, "
            "per Algorithm 2.3. Note that purgedcv expects the transpose."
        )
    if not np.all(np.isfinite(M)):
        raise ValueError("performance contains NaN or inf")
    if n_groups % 2 or n_groups < 4:
        raise ValueError("n_groups must be an even integer >= 4")
    group_size = T // n_groups
    if group_size < 2:
        raise ValueError(
            f"{T} observations over {n_groups} groups gives {group_size} rows per group; "
            "a dispersion statistic needs at least 2"
        )
    n_combos = n_combinations(n_groups)
    if n_combos > max_combinations:
        raise ValueError(
            f"S={n_groups} gives {n_combos} combinations, above max_combinations="
            f"{max_combinations}. Use a smaller S or raise the cap deliberately."
        )

    used = group_size * n_groups
    dropped = T - used
    M = M[:used]
    groups = [np.arange(g * group_size, (g + 1) * group_size) for g in range(n_groups)]
    half = n_groups // 2

    use_fast = isinstance(metric, str) and metric == "sharpe"
    if isinstance(metric, str) and not use_fast:
        raise ValueError(f"unknown metric {metric!r}; pass 'sharpe' or a callable")

    if use_fast:
        # Exact moment accumulation. mean and var over a union of equal-size groups
        # are recoverable from per-group sums and sums of squares, so a combination
        # costs O(S) instead of O(T).
        g_sum = np.stack([M[idx].sum(axis=0) for idx in groups])       # (S, N)
        g_sumsq = np.stack([(M[idx] ** 2).sum(axis=0) for idx in groups])

        def evaluate(sel: tuple[int, ...]) -> np.ndarray:
            n = group_size * len(sel)
            s = g_sum[list(sel)].sum(axis=0)
            ss = g_sumsq[list(sel)].sum(axis=0)
            mean = s / n
            var = ss / n - mean * mean
            var = np.maximum(var, 0.0)
            out = np.zeros_like(mean)
            ok = var > 0
            out[ok] = mean[ok] / np.sqrt(var[ok])
            return out

    else:
        fn: Callable[[np.ndarray], np.ndarray] = metric  # type: ignore[assignment]

        def evaluate(sel: tuple[int, ...]) -> np.ndarray:
            rows = np.concatenate([groups[g] for g in sorted(sel)])
            return np.asarray(fn(M[rows]), dtype=float)

    all_groups = set(range(n_groups))
    logits = np.empty(n_combos)
    rel_ranks = np.empty(n_combos)
    best_cfg = np.empty(n_combos, dtype=np.int64)
    is_perf = np.empty(n_combos)
    oos_perf = np.empty(n_combos)
    oos_random = np.empty(n_combos)

    for i, train_groups in enumerate(combinations(range(n_groups), half)):
        test_groups = tuple(sorted(all_groups - set(train_groups)))
        R = evaluate(train_groups)
        R_bar = evaluate(test_groups)

        n_star = int(np.argmax(R))
        # Average ranks so ties cannot be resolved in the strategy's favour.
        oos_rank = stats.rankdata(R_bar)[n_star]           # 1 .. N, higher is better
        omega = float(oos_rank) / (N + 1.0)                # in (0, 1) by construction

        rel_ranks[i] = omega
        logits[i] = math.log(omega / (1.0 - omega))
        best_cfg[i] = n_star
        is_perf[i] = R[n_star]
        oos_perf[i] = R_bar[n_star]
        oos_random[i] = float(np.mean(R_bar))              # "pick a config at random"

    phi = float(np.mean(logits < 0.0))

    reg = stats.linregress(is_perf, oos_perf)
    first, second, sd2_min = _stochastic_dominance(oos_perf, oos_random)

    return PBOResult(
        pbo=phi,
        n_configs=N,
        n_groups=n_groups,
        n_combinations=n_combos,
        n_obs_used=used,
        n_obs_dropped=dropped,
        logits=logits,
        relative_ranks=rel_ranks,
        is_best_config=best_cfg,
        is_performance=is_perf,
        oos_performance=oos_perf,
        oos_performance_random_pick=oos_random,
        degradation_slope=float(reg.slope),
        degradation_intercept=float(reg.intercept),
        degradation_r2=float(reg.rvalue**2),
        prob_oos_loss=float(np.mean(oos_perf < 0.0)),
        first_order_dominance=first,
        second_order_dominance=second,
        sd2_min=sd2_min,
        frac_is_positive=float(np.mean(is_perf > 0.0)),
        frac_oos_negative=float(np.mean(oos_perf < 0.0)),
        granularity_ok=bool(N >= 10),
    )


def _stochastic_dominance(
    selected: np.ndarray, baseline: np.ndarray
) -> tuple[bool, bool, float]:
    """Does the IS-selected config dominate a random pick, out of sample?

    First order: ``P(selected >= x) >= P(baseline >= x)`` for all x, strict somewhere.
    Second order: ``SD2(x) = ∫_{-∞}^{x} (F_base(u) − F_sel(u)) du >= 0`` for all x.

    Returns ``(first_order, second_order, min SD2 integral)``. The SD2 minimum is
    reported because the boolean alone hides how close the call was.
    """
    grid = np.unique(np.concatenate([selected, baseline]))
    if grid.size < 2:
        return False, False, 0.0
    f_sel = np.searchsorted(np.sort(selected), grid, side="right") / selected.size
    f_base = np.searchsorted(np.sort(baseline), grid, side="right") / baseline.size

    first = bool(np.all(f_sel <= f_base + 1e-12) and np.any(f_sel < f_base - 1e-12))

    diff = f_base - f_sel
    widths = np.diff(grid)
    # Trapezoidal cumulative integral of (F_base - F_sel).
    increments = 0.5 * (diff[:-1] + diff[1:]) * widths
    sd2 = np.concatenate([[0.0], np.cumsum(increments)])
    sd2_min = float(np.min(sd2))
    second = bool(sd2_min >= -1e-12 and np.any(sd2 > 1e-12))
    return first, second, sd2_min


# --------------------------------------------------------------------------- #
# Null calibration — mandatory before quoting a phi
# --------------------------------------------------------------------------- #


def pbo_null_distribution(
    *,
    n_obs: int,
    n_configs: int,
    n_groups: int = 10,
    n_reps: int = 8,
    seed: int = 0,
    correlation: float = 0.0,
) -> np.ndarray:
    """φ under the null: configurations that are pure noise.

    Returns one φ per replication. **Quote your observed φ against these
    percentiles, not against the paper's 0.05 line**, which is unreachable at
    realistic config counts. Note 20 measured the band at 0.26-0.90 (median 0.56) on
    20 noise configs and n=480; at n=20,000 it narrows only to 0.44-0.78.

    ``correlation`` induces an equicorrelated common factor across configurations,
    which is the realistic case — a parameter sweep produces highly correlated
    columns, and correlated noise columns behave differently from independent ones.
    """
    if not 0.0 <= correlation < 1.0:
        raise ValueError("correlation must be in [0, 1)")
    rng = np.random.default_rng(seed)
    out = np.empty(n_reps)
    for i in range(n_reps):
        idio = rng.standard_normal((n_obs, n_configs))
        if correlation > 0.0:
            common = rng.standard_normal((n_obs, 1))
            M = math.sqrt(correlation) * common + math.sqrt(1.0 - correlation) * idio
        else:
            M = idio
        out[i] = cscv(M, n_groups=n_groups).pbo
    return out
