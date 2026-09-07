"""Two questions the existing statistics do not ask.

Written for this submission, like ``ruin.py`` and for the same reason: neither belongs in
``vendor/``, which is carried in unmodified from the research library.

DSR, MinBTL and PBO all ask variants of "could this Sharpe have come from noise?" Walk-forward
asks "does it survive going forward?" Both leave two specific ways a backtest lies untouched.

1. Parameter plateau
--------------------
A strategy whose entire edge sits at one point of the parameter grid is fitting noise, even when
its Sharpe is real and its out-of-sample holds. The tell is the neighbourhood: if SMA(5,40) scores
1.8 while SMA(6,40) and SMA(5,50) collapse to 0.2, the peak is a spike, not a region. A genuine
effect degrades smoothly, because nothing about markets makes 5 special and 6 worthless.

Reported, never gated. There is no published threshold for "how much of a plateau is enough", and
inventing one would be a convention wearing a statistic's clothes — the same call made for halt
tempo and effective breadth.

2. Position-timing permutation
------------------------------
The sharpest question in this file, and the one a Sharpe ratio cannot answer: *does the timing
carry information, or is this just market exposure?*

A long-only strategy on an asset that rose over the sample makes money by being long. That is not
an edge; it is beta with extra steps. The null here holds the market fixed and the position series
fixed, and only breaks the alignment between them — so a permuted strategy keeps the exact same
number of long days, in the exact same run-length pattern, placed at the wrong times. If the real
alignment does no better than random alignment, the timing is worthless however good the Sharpe is.

Alignment is broken by **circular rotation**, not by an iid shuffle. A shuffle destroys the run
structure as well as the timing, so a strategy that holds for weeks would be compared against a
null that flips daily — the comparison would then be measuring position persistence, not timing,
and would report significance that is not there. Rotation preserves every property of the position
series except when it happens.

This one IS gated: it is a genuine hypothesis test with a null, a p-value, and the conventional
0.05 line, unlike everything else added here.
"""

from __future__ import annotations

import numpy as np


def parameter_plateau(
    grid: list[dict],
    *,
    winner_index: int,
) -> dict:
    """Is the winning configuration a region or a spike?

    ``grid`` is one entry per configuration: ``{"i": <row index>, "j": <col index>,
    "score": <annualised Sharpe>}``. Row/column indices rather than raw parameter values, because
    adjacency is what matters and the parameter axes are not evenly spaced (5, 8, 10, 12, 15…).

    The grid is allowed to be irregular. A fast/slow sweep only contains pairs with fast < slow, so
    it is triangular and the winner may have fewer than the full complement of neighbours. The
    count that actually existed is reported rather than assumed.
    """
    if not grid or not (0 <= winner_index < len(grid)):
        return {"status": "unsupported", "reason": "empty grid or winner index out of range"}

    scores = np.array([g["score"] for g in grid], dtype=float)
    coords = {(int(g["i"]), int(g["j"])): idx for idx, g in enumerate(grid)}
    wi, wj = int(grid[winner_index]["i"]), int(grid[winner_index]["j"])

    neighbours = [
        coords[(wi + di, wj + dj)]
        for di in (-1, 0, 1)
        for dj in (-1, 0, 1)
        if (di, dj) != (0, 0) and (wi + di, wj + dj) in coords
    ]
    if len(neighbours) < 2:
        return {"status": "unsupported", "reason": f"winner has only {len(neighbours)} neighbour(s) in the grid — too few to judge a plateau"}

    winner_score = float(scores[winner_index])
    neighbour_scores = scores[neighbours]
    sweep_sd = float(scores.std(ddof=1)) if scores.size > 1 else 0.0

    # Measured in sweep standard deviations, not as a ratio. A ratio is undefined when a Sharpe is
    # negative and unstable when it is near zero, which happens constantly in a real sweep.
    isolation = (winner_score - float(neighbour_scores.mean())) / sweep_sd if sweep_sd > 0 else float("nan")

    # How much of the neighbourhood is itself near the top of the sweep. A genuine plateau has
    # company up there; a spike stands alone.
    top_quartile = float(np.quantile(scores, 0.75))
    neighbours_in_top_quartile = int(np.count_nonzero(neighbour_scores >= top_quartile))

    return {
        "status": "ok",
        "winner_score": winner_score,
        "n_neighbours": len(neighbours),
        "neighbour_mean_score": float(neighbour_scores.mean()),
        "neighbour_min_score": float(neighbour_scores.min()),
        "neighbour_max_score": float(neighbour_scores.max()),
        "sweep_sd": sweep_sd,
        "isolation_sds": isolation,
        "neighbours_in_top_quartile": neighbours_in_top_quartile,
        "detail": (
            f"the winner scores {winner_score:.3f} against a neighbourhood mean of "
            f"{neighbour_scores.mean():.3f} across {len(neighbours)} adjacent configurations "
            f"({isolation:+.2f} sweep SDs above its own neighbours; "
            f"{neighbours_in_top_quartile}/{len(neighbours)} of them are themselves in the sweep's top quartile)"
        ),
        "reporting_note": (
            "Reported, not gated. A high isolation means the edge lives at one point of the grid and "
            "is more likely fitted than real, but no published threshold says where the line is, so "
            "this never changes the verdict."
        ),
        "caveat": (
            "Smoothness is necessary, not sufficient. Adjacent configurations share most of their "
            "trading history, so a surface can look like a plateau because neighbours are correlated "
            "rather than because the edge is real — which is why PBO, not this, is the check that "
            "asks whether the winner holds up out of sample. Near the edge of a triangular grid the "
            "neighbour count falls, so read n_neighbours before reading the number."
        ),
    }


def timing_permutation(
    positions,
    market_returns,
    *,
    bars_per_year: int = 365,
    n_permutations: int = 2_000,
    seed: int = 20260907,
) -> dict:
    """Does the position timing carry information, or is this just exposure?

    Null hypothesis: the strategy's positions are unrelated to when the market moves. Realised by
    circularly rotating the position series against a fixed market series — preserving the number
    of days held, the run-length structure, and the market path exactly, and destroying only the
    alignment.

    Rotation gives at most ``T`` distinct permutations, which is the honest ceiling on resolution
    here; ``n_permutations`` is capped at it rather than resampling the same rotations repeatedly
    and reporting a p-value finer than the test can support.
    """
    pos = np.asarray(positions, dtype=float)
    mkt = np.asarray(market_returns, dtype=float)
    if pos.size != mkt.size:
        return {"status": "unsupported", "reason": f"positions ({pos.size}) and market returns ({mkt.size}) must be the same length"}
    n = pos.size
    if n < 60:
        return {"status": "unsupported", "reason": f"need at least 60 bars, got {n}"}
    if np.allclose(pos, pos[0]):
        return {"status": "unsupported", "reason": "the position never changes — there is no timing to test"}

    def sharpe(r: np.ndarray) -> float:
        sd = r.std()
        return float(r.mean() / sd * np.sqrt(bars_per_year)) if sd > 0 else 0.0

    actual = sharpe(pos * mkt)

    # All rotations except the identity. Sampled without replacement when the cap bites.
    rng = np.random.default_rng(seed)
    max_rotations = n - 1
    k = min(n_permutations, max_rotations)
    offsets = rng.choice(np.arange(1, n), size=k, replace=False)
    null = np.array([sharpe(np.roll(pos, int(o)) * mkt) for o in offsets], dtype=float)

    # One-sided: the question is whether the real timing beats random timing, not whether it differs.
    # The +1 in both terms is Davison & Hinkley's correction — it keeps the p-value from ever being
    # exactly zero, which no finite permutation test can honestly report.
    p_value = (int(np.count_nonzero(null >= actual)) + 1) / (k + 1)

    exposure = float(np.mean(pos != 0))
    return {
        "status": "ok",
        "actual_sharpe_annual": actual,
        "null_mean_sharpe": float(null.mean()),
        "null_p95_sharpe": float(np.quantile(null, 0.95)),
        "n_permutations": k,
        "max_available_rotations": max_rotations,
        "p_value": p_value,
        "exposure_fraction": exposure,
        "passes": bool(p_value < 0.05),
        "detail": (
            f"the strategy's real timing scores {actual:.3f} annualised Sharpe; the same positions "
            f"rotated to random times score {null.mean():.3f} on average ({np.quantile(null, 0.95):.3f} "
            f"at the 95th percentile). p = {p_value:.4f} across {k} rotations"
            + ("" if p_value < 0.05 else " — the timing is not distinguishable from holding the same exposure at random times")
        ),
        "method": (
            "Circular rotation of the position series against a fixed market series. Preserves days "
            f"held ({exposure * 100:.1f}% of bars), run-length structure and the market path; breaks only "
            "the alignment. An iid shuffle would also destroy position persistence and would therefore "
            "measure the wrong thing."
        ),
    }


def family_wise_timing_permutation(
    positions_matrix,
    market_returns,
    *,
    winner_index: int,
    bars_per_year: int = 365,
    n_permutations: int = 1_000,
    seed: int = 20260907,
) -> dict:
    """The timing permutation, corrected for having searched the whole sweep.

    ``timing_permutation`` above answers "is THIS configuration's timing better than chance?" — a
    marginal p-value. But the configuration under test was not chosen a priori; it is the best of 71,
    and the best of 71 noise draws looks good by construction. The marginal p is therefore optimistic
    in exactly the way an undeflated Sharpe is optimistic, and for exactly the same reason.

    The correction is the max-statistic null: on every rotation, score *every* configuration and keep
    only the best. Comparing the observed best against that distribution of bests controls the
    family-wise error rate over the whole search, which is what the search actually did.

    This is the permutation-test analogue of what the Deflated Sharpe Ratio does for Sharpe, and it
    is reported alongside the marginal p rather than instead of it — the gap between the two is the
    cost of the search, and it is worth seeing.
    """
    P = np.asarray(positions_matrix, dtype=float)
    mkt = np.asarray(market_returns, dtype=float)
    if P.ndim != 2:
        return {"status": "unsupported", "reason": "positions_matrix must be (T, N)"}
    T, N = P.shape
    if mkt.size != T:
        return {"status": "unsupported", "reason": f"market returns ({mkt.size}) must match the position matrix rows ({T})"}
    if T < 60 or N < 2:
        return {"status": "unsupported", "reason": f"need at least 60 bars and 2 configurations, got {T} and {N}"}

    root = np.sqrt(bars_per_year)

    def sharpes(pos: np.ndarray) -> np.ndarray:
        r = pos * mkt[:, None]
        sd = r.std(axis=0)
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(sd > 0, r.mean(axis=0) / sd * root, 0.0)

    observed_all = sharpes(P)
    observed_best = float(observed_all.max())
    observed_winner = float(observed_all[winner_index])

    rng = np.random.default_rng(seed)
    k = min(n_permutations, T - 1)
    offsets = rng.choice(np.arange(1, T), size=k, replace=False)
    null_max = np.array([sharpes(np.roll(P, int(o), axis=0)).max() for o in offsets], dtype=float)

    p_family = (int(np.count_nonzero(null_max >= observed_best)) + 1) / (k + 1)

    return {
        "status": "ok",
        "n_configs": N,
        "n_permutations": k,
        "observed_best_sharpe": observed_best,
        "observed_winner_sharpe": observed_winner,
        "null_max_mean": float(null_max.mean()),
        "null_max_p95": float(np.quantile(null_max, 0.95)),
        "p_value_family_wise": p_family,
        "passes": bool(p_family < 0.05),
        "detail": (
            f"across all {N} configurations, the best real timing scores {observed_best:.3f}; rotating "
            f"the whole sweep to random times, the best of {N} still scores {null_max.mean():.3f} on "
            f"average and {np.quantile(null_max, 0.95):.3f} at the 95th percentile. Family-wise p = {p_family:.4f}"
        ),
        "method": (
            "Max-statistic permutation null over the entire search, the permutation analogue of "
            "deflating a Sharpe for the number of trials. Controls family-wise error across all "
            f"{N} configurations rather than reporting one configuration's marginal p."
        ),
    }
