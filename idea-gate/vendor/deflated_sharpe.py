"""Deflated Sharpe Ratio, the expected-maximum-Sharpe-from-noise baseline, and
Minimum Backtest Length.

WHAT THIS IS FOR
================

A Sharpe ratio computed on the winner of a search is not an estimate of that
strategy's Sharpe. It is an estimate of *the maximum of N draws*, and the maximum of
N draws from a zero-mean distribution is positive and grows with N. Bailey &
López de Prado's Deflated Sharpe Ratio subtracts that growth: it asks whether the
observed Sharpe beats the Sharpe the search would have produced from pure noise.

The single number this module exists to keep in front of us, from our own panel
(``best-of-the-best/IDEAS.md``, ``notes/27-SYNTHESIS.md`` §1.5):

    expected-max-Sharpe-from-noise at 200 trials = +2.766
    best Sharpe we have ever observed             = +0.229
    minimum_backtest_length(200, 0.229)           = 145.8 years
    years of data we hold                         = 3.9

Sources, read as primary text (``best-of-the-best/papers/01-validation-canon.md``):

* Bailey & López de Prado (2014), *The Deflated Sharpe Ratio: Correcting for
  Selection Bias, Backtest Overfitting and Non-Normality*, J. Portfolio Management
  40(5). Eq. 2 (DSR = PSR at the deflated benchmark), Eq. 5 (expected maximum of N
  standard normals), Eq. 6 (scaled to Sharpe ratios), Appendix A.3 (the
  correlated-trials deflation).
* Bailey & López de Prado (2012), *The Sharpe Ratio Efficient Frontier*, J. Risk
  15(2). Eq. 7 (the PSR denominator), Eq. 11 (Minimum Track Record Length).
* Bailey, Borwein, López de Prado & Zhu (2014), *Pseudo-Mathematics and Financial
  Charlatanism*, Notices of the AMS 61(5) 458-471. **Theorem 3.1 is where Minimum
  Backtest Length lives** — it is not in the DSR paper at all.

THE TWO TRAPS, AND HOW THIS MODULE MAKES THEM UNREACHABLE
=========================================================

**Trap 1 — annualised vs per-observation Sharpe.** The DSR is defined on
per-observation Sharpe. Feed it an annualised observed Sharpe against a
per-observation threshold and, on our numbers (T=1440, N=200, V=0.25, SR=0.229),
you get **DSR = 1.000000 — a guaranteed false accept**. Feed both annualised and you
get **0.000000 — a guaranteed false reject**. The correct answer is **0.0110**
(``papers/01`` §2.2, verified by re-implementation). ``purgedcv`` exposes this trap
through ``min_track_record_length``, where a 214× understatement of the required
sample passes with no error.

The fix here is structural, not documentary. **No public function in this module
accepts a bare "sharpe".** Functions take *returns* plus a mandatory keyword-only
``bars_per_year``, and compute the Sharpe themselves. The two places a scalar Sharpe
is unavoidable name their unit in the parameter itself
(``target_sharpe_annual``, ``var_trial_sharpe_annual``) and still require
``bars_per_year`` alongside. There is no positional path into a unit mistake.

**Trap 2 — kurtosis is raw, not excess.** The PSR denominator carries
``(γ₄ − 1)/4``, and the paper settles the convention in its own words: *"If the
strategy had exhibited Normal returns (γ̂₃ = 0, γ̂₄ = 3)."* So a Gaussian gives
``(3−1)/4 = ½``, not ``−¼``. Honest calibration, because it is over-quoted: at
daily frequency and our Sharpe this term moves the DSR by **< 1e-4**
(``papers/01`` §2.2). Get it right; do not expect it to change a verdict.

**And the input nobody gets right: N.** The deflation is driven by the trial count.
Undercount it and every number below is a lie in the flattering direction. That is
why :func:`deflated_sharpe_from_ledger` exists and why :class:`DSRResult` carries a
``trials_source`` field that says, in the report, whether N was counted or asserted.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Sequence

import numpy as np
from scipy import optimize, stats
from scipy.special import ndtri

__all__ = [
    "EULER_MASCHERONI",
    "SharpeMoments",
    "DSRResult",
    "expected_max_z",
    "expected_max_sharpe",
    "sharpe_moments",
    "probabilistic_sharpe_ratio",
    "deflated_sharpe_ratio",
    "deflated_sharpe_from_ledger",
    "required_sharpe_annual",
    "minimum_track_record_length",
    "minimum_backtest_length",
    "effective_n_trials",
    "deflation_curve",
]

#: Euler-Mascheroni constant. ``ml-for-asset-managers`` ships the book's typo here;
#: ``purgedcv/_metrics.py:36`` and ``Auto-Quant-V2/selection.py`` both have it right.
EULER_MASCHERONI = 0.5772156649015329

#: DSR acceptance threshold used by the paper and by every implementation in the
#: corpus. Reported, never used to search — see ``pbo.py`` on Strathern's law.
DSR_ACCEPT = 0.95


# --------------------------------------------------------------------------- #
# Moments
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class SharpeMoments:
    """The four quantities the PSR needs, all on a per-observation basis."""

    sr_per_bar: float
    skew: float
    kurtosis_non_excess: float
    n_obs: int

    @property
    def psr_denominator(self) -> float:
        """``1 − γ₃·SR + ((γ₄ − 1)/4)·SR²`` — Bailey & López de Prado 2012 Eq. 7."""
        sr = self.sr_per_bar
        return 1.0 - self.skew * sr + ((self.kurtosis_non_excess - 1.0) / 4.0) * sr * sr


def _clean_returns(returns: Sequence[float] | np.ndarray) -> np.ndarray:
    r = np.asarray(returns, dtype=float).ravel()
    if r.size == 0:
        raise ValueError("returns is empty")
    if not np.all(np.isfinite(r)):
        raise ValueError("returns contains NaN or inf; clean them explicitly, never silently")
    return r


def sharpe_moments(returns: Sequence[float] | np.ndarray) -> SharpeMoments:
    """Per-observation Sharpe, skew and **non-excess** kurtosis.

    ``std`` uses ``ddof=0`` (population), matching ``purgedcv/_metrics.py:68`` and
    the paper's own worked example. Skew and kurtosis use the bias-corrected
    estimators, and kurtosis is Pearson (Gaussian = 3.0), not Fisher.
    """
    r = _clean_returns(returns)
    if r.size < 2:
        raise ValueError("need at least 2 observations")
    sd = float(np.std(r, ddof=0))
    if sd <= 0.0:
        raise ValueError("returns have zero dispersion; Sharpe is undefined")
    return SharpeMoments(
        sr_per_bar=float(np.mean(r)) / sd,
        skew=float(stats.skew(r, bias=False)),
        kurtosis_non_excess=float(stats.kurtosis(r, bias=False, fisher=False)),
        n_obs=int(r.size),
    )


# --------------------------------------------------------------------------- #
# Expected maximum from noise
# --------------------------------------------------------------------------- #


def expected_max_z(n_trials: int) -> float:
    """Expected maximum of ``n_trials`` IID standard normals.

    Bailey & López de Prado 2014 Eq. 5::

        E[max_N] ≈ (1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))

    An upper bound is ``√(2·ln N)``. The approximation is for ``N ≫ 1``; it runs
    +0.5…+1% optimistic against a 20k-path Monte Carlo in the 100-1000 range and is
    unreliable below ~10 trials (``notes/per-repo/purged-cross-validation.md`` §3.4).

    ``n_trials == 1`` returns exactly 0.0, which makes the DSR reduce to PSR(0) —
    the no-selection case, and a useful invariant to test.

    Reference values reproduced from the papers: ``E[max_10] = 1.5746``,
    ``E[max_128] = 2.6163``, ``E[max_200] = 2.7655``.
    """
    n = int(n_trials)
    if n < 1:
        raise ValueError("n_trials must be >= 1")
    if n == 1:
        return 0.0
    return float(
        (1.0 - EULER_MASCHERONI) * ndtri(1.0 - 1.0 / n)
        + EULER_MASCHERONI * ndtri(1.0 - 1.0 / (n * math.e))
    )


def expected_max_sharpe(
    n_trials: int,
    *,
    var_trial_sharpe_annual: float,
    bars_per_year: int,
    mean_trial_sharpe_annual: float = 0.0,
) -> float:
    """Expected best **annualised** Sharpe a search of ``n_trials`` yields from noise.

    Bailey & López de Prado 2014 Eq. 6::

        E[max ŜR] ≈ E[ŜR] + √V[ŜR] · E[max_N]

    Under H₀ (true Sharpe zero) the first term drops, which is the rejection
    threshold the DSR deflates against. ``bars_per_year`` is required even though it
    cancels here, so that no call site can drift into mixing units between this
    function and :func:`deflated_sharpe_ratio`.
    """
    if var_trial_sharpe_annual < 0:
        raise ValueError("var_trial_sharpe_annual must be >= 0")
    if bars_per_year <= 0:
        raise ValueError("bars_per_year must be > 0")
    return float(
        mean_trial_sharpe_annual
        + math.sqrt(var_trial_sharpe_annual) * expected_max_z(n_trials)
    )


# --------------------------------------------------------------------------- #
# PSR / DSR
# --------------------------------------------------------------------------- #


def _psr_from_moments(moments: SharpeMoments, sr_star_per_bar: float) -> float:
    denom = moments.psr_denominator
    if denom <= 0.0:
        raise ValueError(
            f"PSR denominator is non-positive ({denom:.6g}); the moment estimates are "
            "outside the statistic's domain"
        )
    z = (moments.sr_per_bar - sr_star_per_bar) * math.sqrt(moments.n_obs - 1) / math.sqrt(denom)
    return float(stats.norm.cdf(z))


def probabilistic_sharpe_ratio(
    returns: Sequence[float] | np.ndarray,
    *,
    bars_per_year: int,
    benchmark_sharpe_annual: float = 0.0,
) -> float:
    """P(true Sharpe > benchmark), correcting for skew, kurtosis and sample length.

    Bailey & López de Prado 2012 Eq. 9. Takes *returns*, never a Sharpe.
    """
    if bars_per_year <= 0:
        raise ValueError("bars_per_year must be > 0")
    m = sharpe_moments(returns)
    return _psr_from_moments(m, benchmark_sharpe_annual / math.sqrt(bars_per_year))


@dataclass(frozen=True)
class DSRResult:
    """Everything needed to re-derive the verdict, plus where N came from.

    ``status`` is ``"ok"`` or ``"unsupported"``. An ``"unsupported"`` result carries
    a machine-readable ``reason`` and ``passes=None`` — a first-class "the evidence
    does not justify a statistic" state, rather than the plausible float that
    ``FinceptTerminal``/``octobot`` return or the bare ``null`` that
    ``agent-backtest-lab`` emits.
    """

    status: str
    reason: str | None
    dsr: float | None
    psr_zero: float | None
    sr_per_bar: float | None
    sr_annual: float | None
    sr_star_per_bar: float | None
    sr_star_annual: float | None
    expected_max_z: float | None
    var_trial_sharpe_annual: float
    n_trials: int
    n_obs: int
    bars_per_year: int
    skew: float | None
    kurtosis_non_excess: float | None
    trials_source: str
    years_held: float
    min_track_record_obs: float | None
    min_backtest_years: float | None
    required_sharpe_annual: float | None
    record_sufficient: bool | None
    backtest_long_enough: bool | None
    passes: bool | None

    def as_dict(self) -> dict[str, object]:
        return asdict(self)

    def report(self) -> str:
        """A block fit to paste next to a headline number."""
        if self.status != "ok":
            return f"DSR UNSUPPORTED — {self.reason}\n  n_trials={self.n_trials} n_obs={self.n_obs}"
        provenance = (
            "counted" if self.trials_source.startswith("ledger:") else "DECLARED, NOT COUNTED"
        )
        lines = [
            f"DSR                    {self.dsr:.6f}   (accept >= {DSR_ACCEPT})",
            f"PSR(0)                 {self.psr_zero:.6f}   <- what you would quote without deflation",
            f"observed SR (annual)   {self.sr_annual:.6f}",
            f"threshold SR (annual)  {self.sr_star_annual:.6f}   <- the hurdle {self.n_trials} trials create",
            f"E[max z]               {self.expected_max_z:.6f}",
            f"n_trials               {self.n_trials}   [{provenance}: {self.trials_source}]",
            f"V[trial SR] (annual)   {self.var_trial_sharpe_annual:.6f}",
            f"n_obs                  {self.n_obs}   = {self.years_held:.4f} years",
            f"skew / kurtosis        {self.skew:.6f} / {self.kurtosis_non_excess:.6f}  (Gaussian kurtosis = 3)",
            f"SR needed for DSR>=.95 {self.required_sharpe_annual:.6f} annual",
            f"min track record       {self.min_track_record_obs} observations"
            f"   [n_obs sufficient: {self.record_sufficient}]",
            f"min backtest length    {self.min_backtest_years} years   <- against "
            f"{self.years_held:.4f} held   [sufficient: {self.backtest_long_enough}]",
            f"PASSES                 {self.passes}"
            "   (DSR >= 0.95 AND track record AND backtest length)",
        ]
        return "\n".join(lines)


def deflated_sharpe_ratio(
    returns: Sequence[float] | np.ndarray,
    *,
    n_trials: int,
    var_trial_sharpe_annual: float,
    bars_per_year: int,
    trials_source: str = "declared",
    mean_trial_sharpe_annual: float = 0.0,
) -> DSRResult:
    """Deflated Sharpe Ratio — Bailey & López de Prado 2014 Eq. 2.

    Parameters
    ----------
    returns
        Net-of-fee per-bar returns of the **selected** strategy.
    n_trials
        Number of configurations evaluated to arrive at this one. **This is the
        input everybody fudges.** Prefer :func:`deflated_sharpe_from_ledger`, which
        takes it from a hash-chained ledger instead of from memory.
    var_trial_sharpe_annual
        Variance of the *annualised* Sharpe ratios across those trials.
    bars_per_year
        365 for crypto perpetuals — the tape trades every day. Keyword-only and
        mandatory; it is what de-annualises the threshold.
    trials_source
        Free text recorded in the result and echoed in :meth:`DSRResult.report`, so
        a reader can see whether N was counted or asserted.

    Returns
    -------
    DSRResult
        ``status="unsupported"`` with a typed ``reason`` when the statistic is not
        estimable, rather than a plausible float.
    """
    if bars_per_year <= 0:
        raise ValueError("bars_per_year must be > 0")
    if n_trials < 1:
        raise ValueError("n_trials must be >= 1")
    if var_trial_sharpe_annual < 0:
        raise ValueError("var_trial_sharpe_annual must be >= 0")

    r = np.asarray(returns, dtype=float).ravel()
    base = dict(
        var_trial_sharpe_annual=float(var_trial_sharpe_annual),
        n_trials=int(n_trials),
        n_obs=int(r.size),
        bars_per_year=int(bars_per_year),
        trials_source=trials_source,
        years_held=float(r.size) / bars_per_year,
    )

    def unsupported(reason: str) -> DSRResult:
        return DSRResult(
            status="unsupported",
            reason=reason,
            dsr=None,
            psr_zero=None,
            sr_per_bar=None,
            sr_annual=None,
            sr_star_per_bar=None,
            sr_star_annual=None,
            expected_max_z=None,
            skew=None,
            kurtosis_non_excess=None,
            min_track_record_obs=None,
            min_backtest_years=None,
            required_sharpe_annual=None,
            record_sufficient=None,
            backtest_long_enough=None,
            passes=None,
            **base,
        )

    if r.size < 2:
        return unsupported("insufficient-observations")
    if not np.all(np.isfinite(r)):
        return unsupported("non-finite-returns")
    # `std > 0` is not enough. An array of identical values has a std of ~1e-18
    # rather than exactly 0 (the mean is not exactly representable), which is
    # enough to pass a naive check and then produce NaN skew and kurtosis through
    # catastrophic cancellation. Test the range, which is exact.
    if float(np.std(r, ddof=0)) <= 0.0 or float(np.ptp(r)) == 0.0:
        return unsupported("zero-dispersion-returns")

    m = sharpe_moments(r)
    if not all(
        math.isfinite(v) for v in (m.sr_per_bar, m.skew, m.kurtosis_non_excess, m.psr_denominator)
    ):
        return unsupported("invalid-portfolio-return-moments")
    if m.psr_denominator <= 0.0:
        return unsupported("invalid-probabilistic-sharpe-domain")

    emax_z = expected_max_z(n_trials)
    sr_star_annual = mean_trial_sharpe_annual + math.sqrt(var_trial_sharpe_annual) * emax_z
    sr_star_per_bar = sr_star_annual / math.sqrt(bars_per_year)

    dsr = _psr_from_moments(m, sr_star_per_bar)
    psr0 = _psr_from_moments(m, 0.0)
    sr_annual = m.sr_per_bar * math.sqrt(bars_per_year)

    mintrl = minimum_track_record_length(
        returns=r,
        bars_per_year=bars_per_year,
        benchmark_sharpe_annual=sr_star_annual,
        confidence=DSR_ACCEPT,
    )
    minbtl = (
        minimum_backtest_length(n_trials, target_sharpe_annual=sr_annual)
        if sr_annual > 0
        else float("inf")
    )
    required = required_sharpe_annual(
        n_obs=m.n_obs,
        n_trials=n_trials,
        var_trial_sharpe_annual=var_trial_sharpe_annual,
        bars_per_year=bars_per_year,
        confidence=DSR_ACCEPT,
        skew=m.skew,
        kurtosis_non_excess=m.kurtosis_non_excess,
        mean_trial_sharpe_annual=mean_trial_sharpe_annual,
    )

    # The conjunction, not the DSR alone.
    #
    # Auto-Quant-V2/selection.py:369-392 gates on `dsr >= 0.95 AND observations >=
    # minimum_observations`, and it is the only implementation in the corpus that
    # gates on both. Deriving it here showed something that note is worth recording:
    # **MinTRL against the deflated benchmark is algebraically the same condition as
    # DSR >= 0.95 at the same confidence.** Both reduce to
    # `(n-1) >= (z*sqrt(denom)/(SR - SR*))^2`. So that half of the conjunction adds
    # only rounding robustness, not an independent test. It is kept for exactly that,
    # and reported separately so nobody mistakes it for a second opinion.
    #
    # The gate that *is* independent — and the one that actually binds for us — is
    # Minimum Backtest Length: can a sample this long support a search this wide at
    # the observed Sharpe at all? At n_trials=200 and SR=0.229 the answer is 145.8
    # years against 3.9 held, and no DSR value rescues that.
    record_sufficient = math.isfinite(mintrl) and m.n_obs >= mintrl
    backtest_long_enough = math.isfinite(minbtl) and (m.n_obs / bars_per_year) >= minbtl
    passes = bool(dsr >= DSR_ACCEPT and record_sufficient and backtest_long_enough)

    return DSRResult(
        status="ok",
        reason=None,
        dsr=float(dsr),
        psr_zero=float(psr0),
        sr_per_bar=float(m.sr_per_bar),
        sr_annual=float(sr_annual),
        sr_star_per_bar=float(sr_star_per_bar),
        sr_star_annual=float(sr_star_annual),
        expected_max_z=float(emax_z),
        skew=float(m.skew),
        kurtosis_non_excess=float(m.kurtosis_non_excess),
        min_track_record_obs=float(mintrl),
        min_backtest_years=float(minbtl),
        required_sharpe_annual=float(required),
        record_sufficient=record_sufficient,
        backtest_long_enough=backtest_long_enough,
        passes=passes,
        **base,
    )


def deflated_sharpe_from_ledger(
    returns: Sequence[float] | np.ndarray,
    ledger: "object",
    *,
    bars_per_year: int,
    family_hash: str | None = None,
) -> DSRResult:
    """DSR whose ``n_trials`` and trial variance come from a :class:`TrialLedger`.

    This is the entry point to prefer. ``n_trials`` becomes a ``COUNT`` over an
    append-only hash-chained record rather than a number somebody remembers, and the
    ledger's own hash is stamped into ``trials_source`` so the count is auditable
    after the fact.
    """
    from .trial_ledger import TrialLedger  # local import: avoids a cycle

    if not isinstance(ledger, TrialLedger):
        raise TypeError("ledger must be a TrialLedger")
    ledger.verify()
    n_trials, var_annual, source = ledger.dsr_inputs(family_hash=family_hash)
    return deflated_sharpe_ratio(
        returns,
        n_trials=n_trials,
        var_trial_sharpe_annual=var_annual,
        bars_per_year=bars_per_year,
        trials_source=source,
    )


# --------------------------------------------------------------------------- #
# Inversions: what would it take to pass?
# --------------------------------------------------------------------------- #


def required_sharpe_annual(
    *,
    n_obs: int,
    n_trials: int,
    var_trial_sharpe_annual: float,
    bars_per_year: int,
    confidence: float = DSR_ACCEPT,
    skew: float = 0.0,
    kurtosis_non_excess: float = 3.0,
    mean_trial_sharpe_annual: float = 0.0,
) -> float:
    """The annualised Sharpe that would clear ``DSR >= confidence`` at this N and T.

    Inverts the DSR numerically. Defaults are Gaussian, which is the *generous*
    assumption: real fat tails raise the bar.

    On our numbers (T=1440, bars_per_year=365, V=0.25, Gaussian) this returns
    **0.829 at N=1** and **≈2.21 at N=200**, reproducing ``papers/01`` §2.4.
    """
    if n_obs < 2:
        raise ValueError("n_obs must be >= 2")
    if not 0.0 < confidence < 1.0:
        raise ValueError("confidence must be in (0, 1)")
    sr_star = (
        mean_trial_sharpe_annual + math.sqrt(var_trial_sharpe_annual) * expected_max_z(n_trials)
    ) / math.sqrt(bars_per_year)
    z_target = ndtri(confidence)

    def gap(sr: float) -> float:
        denom = 1.0 - skew * sr + ((kurtosis_non_excess - 1.0) / 4.0) * sr * sr
        if denom <= 0.0:
            return math.inf
        return (sr - sr_star) * math.sqrt(n_obs - 1) / math.sqrt(denom) - z_target

    lo, hi = sr_star, sr_star + 1.0
    for _ in range(60):
        if gap(hi) > 0:
            break
        hi += 1.0
    else:  # pragma: no cover - defensive
        raise RuntimeError("could not bracket the required Sharpe")
    root = optimize.brentq(gap, lo, hi, xtol=1e-14, rtol=1e-14, maxiter=500)
    return float(root * math.sqrt(bars_per_year))


def minimum_track_record_length(
    *,
    returns: Sequence[float] | np.ndarray,
    bars_per_year: int,
    benchmark_sharpe_annual: float = 0.0,
    confidence: float = DSR_ACCEPT,
) -> float:
    """Observations needed for the observed Sharpe to clear the benchmark.

    Bailey & López de Prado 2012 Eq. 11::

        MinTRL = ((z_α · √denominator) / (ŜR − ŜR*))² + 1

    Takes returns, never a scalar Sharpe. That is deliberate: ``purgedcv``'s
    ``min_track_record_length`` accepts a scalar and, fed an annualised Sharpe where
    a per-bar one belongs, **understates the required sample by 214× with no error
    and no warning** (``notes/per-repo/purged-cross-validation.md`` §5f).

    Returns ``inf`` when the observed Sharpe does not exceed the benchmark, which is
    the honest answer: no amount of further data makes that track record sufficient
    at the observed rate.
    """
    if bars_per_year <= 0:
        raise ValueError("bars_per_year must be > 0")
    m = sharpe_moments(returns)
    sr_star = benchmark_sharpe_annual / math.sqrt(bars_per_year)
    denom = m.psr_denominator
    if not (math.isfinite(m.sr_per_bar) and math.isfinite(denom)):
        return math.inf
    if m.sr_per_bar <= sr_star or denom <= 0.0:
        return math.inf
    z = ndtri(confidence)
    return math.ceil((z * math.sqrt(denom) / (m.sr_per_bar - sr_star)) ** 2) + 1.0


def minimum_backtest_length(n_trials: int, *, target_sharpe_annual: float) -> float:
    """Years of data required before ``n_trials`` can support ``target_sharpe_annual``.

    Bailey, Borwein, López de Prado & Zhu (2014) Theorem 3.1::

        MinBTL (years) ≈ ( E[max_N] / SR_annual )²          bounded above by 2·ln(N)/SR²

    The parameter name carries the unit because this is one of the two places a
    scalar Sharpe is unavoidable.

    Reproduces the paper's own statements: ``MinBTL(45, 1.0) = 5.00 y`` ("if only 5
    years of data are available, no more than 45 independent configurations should
    be tried") and ``MinBTL(7, 1.0) = 1.92 y``. **On our numbers,
    ``MinBTL(200, 0.229) = 145.84 years`` against 3.9 held.**

    It is a *lower* bound: the derivation assumes ``V[SR_annual] = 1/years``, i.e.
    IID Gaussian returns. Autocorrelation and fat tails inflate ``V[SR]`` and push
    the requirement up.
    """
    if n_trials < 1:
        raise ValueError("n_trials must be >= 1")
    if target_sharpe_annual <= 0:
        raise ValueError("target_sharpe_annual must be > 0")
    return float((expected_max_z(n_trials) / target_sharpe_annual) ** 2)


def effective_n_trials(n_trials: int, *, mean_correlation: float) -> float:
    """Independent-trial count implied by an average cross-trial correlation.

    Bailey & López de Prado 2014 Appendix A.3::

        N̄ = ρ̂ + (1 − ρ̂)·M

    The only route by which a large M becomes a small N. **It does not open at our
    size**: even 50 trials that are 95% correlated with one another need 17.3 years,
    and 200 trials at ρ̂=0.95 still need 50.0 years against 3.9 held
    (``papers/01`` §2.5).

    Two caveats the paper states and everyone drops: correlation is a limited notion
    of dependence, and when ``T < ½·M(M−1)`` the trial correlation matrix is
    ill-conditioned, at which point *"estimating an average correlation is then
    pointless."* This is the single most abusable knob in the whole framework —
    ``purgedcv``'s heuristic version moves a DSR from 0.047 to 0.915 on the same
    data. **If you use it, publish both DSRs.**
    """
    m = int(n_trials)
    if m < 1:
        raise ValueError("n_trials must be >= 1")
    if m == 1:
        return 1.0
    lo = -1.0 / (m - 1)
    if not lo < mean_correlation <= 1.0:
        raise ValueError(f"mean_correlation must be in ({lo:.6g}, 1]")
    return float(mean_correlation + (1.0 - mean_correlation) * m)


def deflation_curve(
    n_trials_grid: Sequence[int],
    *,
    n_obs: int,
    var_trial_sharpe_annual: float,
    bars_per_year: int,
    observed_sharpe_annual: float | None = None,
    skew: float = 0.0,
    kurtosis_non_excess: float = 3.0,
) -> list[dict[str, float]]:
    """How the correction grows with the trial count.

    One row per N: the noise threshold, the Sharpe needed to pass, the DSR an
    ``observed_sharpe_annual`` would score, and the backtest length that N demands.
    This is the table to put next to any headline — it shows the reader that the
    hurdle is a function of how hard we searched, not of how good the idea is.
    """
    rows: list[dict[str, float]] = []
    for n in n_trials_grid:
        emax = expected_max_z(int(n))
        sr_star_annual = math.sqrt(var_trial_sharpe_annual) * emax
        req = required_sharpe_annual(
            n_obs=n_obs,
            n_trials=int(n),
            var_trial_sharpe_annual=var_trial_sharpe_annual,
            bars_per_year=bars_per_year,
            skew=skew,
            kurtosis_non_excess=kurtosis_non_excess,
        )
        row: dict[str, float] = {
            "n_trials": float(int(n)),
            "expected_max_z": emax,
            "sr_star_annual": sr_star_annual,
            "required_sharpe_annual": req,
        }
        if observed_sharpe_annual is not None:
            sr = observed_sharpe_annual / math.sqrt(bars_per_year)
            sr_star = sr_star_annual / math.sqrt(bars_per_year)
            denom = 1.0 - skew * sr + ((kurtosis_non_excess - 1.0) / 4.0) * sr * sr
            z = (sr - sr_star) * math.sqrt(n_obs - 1) / math.sqrt(denom)
            row["dsr_at_observed"] = float(stats.norm.cdf(z))
            row["min_backtest_years"] = (
                minimum_backtest_length(int(n), target_sharpe_annual=observed_sharpe_annual)
                if observed_sharpe_annual > 0
                else math.inf
            )
        rows.append(row)
    return rows
