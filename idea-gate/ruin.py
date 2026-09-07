"""Halt tempo: how long does this strategy run before *this operator's* policy stops it?

Written for this submission — unlike ``vendor/``, this is not carried in from the research
library, and it is deliberately kept out of ``vendor/`` so the provenance claim stays clean.

The question exists only because this project has both gates in one process. The idea gate
knows a strategy's return distribution. The order gate knows the operator's own halt
thresholds (``maxDailyLossPct``, ``maxDrawdownPct``, enforced by gates 09 and 10). Between
them sits a question neither asks alone:

    given this strategy's own realised behaviour, how long does it run before it trips the
    halt the operator already configured — and how often does that happen?

Why "how long", not "whether"
-----------------------------
The first version of this module asked whether the strategy would *ever* breach the halt.
That number came back 100.0% for everything, which is correct and useless: over 1,460 daily
bars, essentially any strategy touches a 5% drawdown at some point. A check that cannot come
back anything but 1.0 is not a check.

The halts in ``policy.json`` are circuit breakers, not lifetime drawdown budgets. The
operationally meaningful quantity is therefore the *tempo* — the distribution of time until
the first halt, and the chance of getting through a working month without one. That number
does discriminate: a strategy the policy stops every nine days is a different proposition
from one it stops twice a year, and neither fact is visible anywhere else in this product.

Why this does not decide the verdict
------------------------------------
It is reported, never gated — deliberately, and for the same reason effective breadth is
not gated. Whether a halt every N days is acceptable is genuinely the operator's call:
some operators want a tight leash and expect frequent halts. Inventing a pass line here
would be dressing a convention up as a statistic, and no published threshold exists. The
gate reports the tempo and lets the operator decide whether it is the one they wanted.

Method
------
Stationary bootstrap (Politis & Romano, 1994): geometric block lengths with mean L,
circular wrap. Blocks, not iid draws, because drawdown is driven almost entirely by serial
correlation — an iid bootstrap breaks the losing streaks apart and systematically
*understates* the very quantity being measured. L defaults to the standard T^(1/3) rule.
The resample draws from the strategy's own returns, so its fat tails and autocorrelation
survive; no distributional assumption is made about the input.

Every reported probability carries its Monte Carlo standard error. One reported quantity —
first passage below a fixed loss level — has a closed form under Gaussian iid returns
(reflection principle, with the Broadie/Glasserman/Kou discrete-monitoring correction), and
``first_passage_analytic_discrete`` implements it purely so the test suite can prove this
engine reproduces a known answer rather than merely being self-consistent.
"""

from __future__ import annotations

import math

import numpy as np

# Chunk size for path simulation. 20,000 paths x 1,459 bars x 8 bytes is 233 MB per
# intermediate array and several are live at once; 2,000 keeps the working set ~23 MB.
_CHUNK = 2_000

# Broadie, Glasserman & Kou (1997): a barrier monitored only at discrete times is breached
# less often than a continuous one, because the path can dip below and recover between two
# observations. The correction shifts the barrier out by beta * sigma * sqrt(dt), with
# beta = -zeta(1/2)/sqrt(2*pi). Without it the continuous closed form sits ~4 percentage
# points above any per-bar simulation, and the two look like they disagree when they do not.
BGK_BETA = 0.5826


def default_mean_block(n_obs: int) -> float:
    """Politis and Romano's usual rule of thumb for the expected block length."""
    return max(2.0, float(round(n_obs ** (1.0 / 3.0))))


def _stationary_bootstrap_indices(
    n_obs: int, n_paths: int, horizon: int, mean_block: float, rng: np.random.Generator
) -> np.ndarray:
    """Index matrix (n_paths, horizon) drawn by the stationary bootstrap.

    At each step the previous index advances by one (wrapping circularly) unless a new
    block starts, which happens with probability 1/L. That geometric block length is what
    makes the resampled series stationary — fixed-length blocks are not.
    """
    p_new_block = 1.0 / mean_block
    idx = np.empty((n_paths, horizon), dtype=np.int64)
    idx[:, 0] = rng.integers(0, n_obs, size=n_paths)
    if horizon > 1:
        starts_new = rng.random((n_paths, horizon - 1)) < p_new_block
        fresh = rng.integers(0, n_obs, size=(n_paths, horizon - 1))
        for t in range(1, horizon):
            continued = (idx[:, t - 1] + 1) % n_obs
            idx[:, t] = np.where(starts_new[:, t - 1], fresh[:, t - 1], continued)
    return idx


def _mc_stderr(p: float, n: int) -> float:
    """Standard error of a Monte Carlo proportion. Quoted with every probability below,
    because an unqualified "0.34" from 20,000 paths invites more confidence than it earns.
    """
    return math.sqrt(max(p * (1.0 - p), 0.0) / n)


def halt_tempo(
    returns,
    *,
    max_drawdown_pct: float,
    max_daily_loss_pct: float,
    bars_per_year: int = 365,
    horizon: int | None = None,
    n_paths: int = 20_000,
    mean_block: float | None = None,
    seed: int = 20260907,
) -> dict:
    """How long this strategy runs before the operator's own halts stop it.

    ``horizon`` defaults to the length of the observed record: simulate a stretch as long as
    the one actually backtested, and see how far in the first halt lands.
    """
    r = np.asarray(returns, dtype=float)
    r = r[np.isfinite(r)]
    n_obs = int(r.size)
    if n_obs < 30:
        return {"status": "unsupported", "reason": f"need at least 30 finite returns, got {n_obs}"}
    if np.any(r <= -1.0):
        return {"status": "unsupported", "reason": "a return of -100% or worse makes the equity path undefined"}

    horizon = int(horizon or n_obs)
    block = float(mean_block if mean_block is not None else default_mean_block(n_obs))
    rng = np.random.default_rng(seed)

    log_r = np.log1p(r)
    dd_thr = max_drawdown_pct / 100.0
    day_thr = max_daily_loss_pct / 100.0
    # One bar is one day on a 365-bar year; on finer bars the daily halt is a rolling
    # window. Computing it any other way compares a bar to a day-sized threshold.
    bars_per_day = max(1, int(round(bars_per_year / 365.0)))

    first_halt: list[np.ndarray] = []
    cause_drawdown = 0
    passage_hits = 0

    remaining = n_paths
    while remaining > 0:
        chunk = min(_CHUNK, remaining)
        idx = _stationary_bootstrap_indices(n_obs, chunk, horizon, block, rng)
        path_log_r = log_r[idx]
        cum = np.cumsum(path_log_r, axis=1)

        # Gate 10: drawdown from the running peak, not from starting equity.
        running_max = np.maximum.accumulate(cum, axis=1)
        dd_breach = (1.0 - np.exp(cum - running_max)) >= dd_thr

        # Gate 09: worst day. With bars_per_day == 1 that is simply the bar itself.
        if bars_per_day == 1:
            day_breach = np.expm1(path_log_r) <= -day_thr
        else:
            padded = np.concatenate([np.zeros((chunk, 1)), cum], axis=1)
            windows = np.expm1(padded[:, bars_per_day:] - padded[:, :-bars_per_day])
            # A window ending at bar t is only observable at bar t; the first
            # bars_per_day-1 bars cannot yet have a full day behind them.
            day_breach = np.zeros_like(dd_breach)
            day_breach[:, bars_per_day - 1 :] = windows <= -day_thr

        any_breach = dd_breach | day_breach
        halted = any_breach.any(axis=1)
        # argmax on a boolean row gives the first True; rows that never breach are marked
        # with the horizon itself, i.e. right-censored at "still running when time ran out".
        first = np.where(halted, any_breach.argmax(axis=1) + 1, horizon + 1)
        first_halt.append(first)

        # Which halt fired first, among the paths that halted at all.
        dd_first = np.where(dd_breach.any(axis=1), dd_breach.argmax(axis=1), horizon + 1)
        day_first = np.where(day_breach.any(axis=1), day_breach.argmax(axis=1), horizon + 1)
        cause_drawdown += int(np.count_nonzero(halted & (dd_first <= day_first)))

        # First passage below the STARTING equity by the drawdown threshold. Kept because
        # it is the one quantity here with a closed form for the test suite to check.
        passage_hits += int(np.count_nonzero(1.0 - np.exp(cum.min(axis=1)) >= dd_thr))

        remaining -= chunk

    times = np.concatenate(first_halt)
    censored = int(np.count_nonzero(times > horizon))
    p_halt = float(np.count_nonzero(times <= horizon) / n_paths)

    def survival(days: int) -> float:
        bars = days * bars_per_day
        return float(np.count_nonzero(times > bars) / n_paths) if bars <= horizon else float("nan")

    # Percentiles are read off the censored sample directly. Anything at or beyond the
    # horizon is a lower bound, not a value, and is flagged rather than quietly reported.
    def pct(q: float) -> dict:
        v = float(np.percentile(times, q))
        return {"bars": min(v, float(horizon)), "censored": v > horizon}

    p_passage = passage_hits / n_paths
    med = pct(50)

    return {
        "status": "ok",
        "n_paths": n_paths,
        "horizon_bars": horizon,
        "mean_block": block,
        "bars_per_day": bars_per_day,
        "max_drawdown_pct": max_drawdown_pct,
        "max_daily_loss_pct": max_daily_loss_pct,
        "p_halt_within_horizon": p_halt,
        "p_halt_within_horizon_stderr": _mc_stderr(p_halt, n_paths),
        "bars_to_first_halt": {"p05": pct(5), "p25": pct(25), "median": med, "p75": pct(75)},
        "survives_30_days": survival(30),
        "survives_90_days": survival(90),
        "share_of_halts_caused_by_drawdown": (cause_drawdown / max(1, n_paths - censored)),
        "p_first_passage": p_passage,
        "p_first_passage_stderr": _mc_stderr(p_passage, n_paths),
        "detail": (
            f"under this operator's own {max_drawdown_pct:.1f}% drawdown / {max_daily_loss_pct:.1f}% daily halts, "
            f"the median run before the first halt is "
            f"{'>' if med['censored'] else ''}{med['bars']:.0f} bars"
            f"; {survival(30) * 100:.1f}% of {n_paths:,} bootstrapped paths get through 30 days without one"
        ),
        "reporting_note": (
            "Reported, not gated. Whether a halt every N days is acceptable is the operator's "
            "call, not a statistic — some operators want a tight leash and expect frequent "
            "halts. No published threshold exists, so this check never changes the verdict."
        ),
        "method": (
            "Stationary bootstrap (Politis and Romano 1994), geometric blocks of mean "
            f"{block:.0f} bars, resampled from the strategy's own returns so its fat tails and "
            "serial correlation are preserved. Monte Carlo estimate; standard errors quoted. "
            "Times at the horizon are right-censored and flagged, never reported as values."
        ),
    }


def first_passage_analytic(mu: float, sigma: float, barrier: float, horizon: int) -> float:
    """P(the running minimum of an arithmetic Brownian motion reaches -barrier by T).

    Closed form via the reflection principle, for drift ``mu`` and volatility ``sigma`` per
    bar over ``horizon`` bars, with ``barrier`` > 0 expressed in log units::

        P = Phi((-b - mu*T)/(sigma*sqrt(T))) + exp(-2*mu*b/sigma^2) * Phi((-b + mu*T)/(sigma*sqrt(T)))

    Exists here only as a known answer for the test suite to hold the Monte Carlo engine
    against. It is never used to produce a reported number: real strategy returns are
    neither Gaussian nor independent, which is the whole reason the engine bootstraps.
    """
    if sigma <= 0 or horizon <= 0 or barrier <= 0:
        raise ValueError("sigma, horizon and barrier must all be positive")
    t = float(horizon)
    root = sigma * math.sqrt(t)

    def phi(x: float) -> float:  # standard normal CDF
        return 0.5 * math.erfc(-x / math.sqrt(2.0))

    return phi((-barrier - mu * t) / root) + math.exp(-2.0 * mu * barrier / sigma**2) * phi(
        (-barrier + mu * t) / root
    )


def first_passage_analytic_discrete(mu: float, sigma: float, barrier: float, horizon: int) -> float:
    """``first_passage_analytic`` with the discrete-monitoring continuity correction applied.

    This is the value a per-bar simulation should actually reproduce, and the one the test
    suite compares against.
    """
    return first_passage_analytic(mu, sigma, barrier + BGK_BETA * sigma, horizon)
