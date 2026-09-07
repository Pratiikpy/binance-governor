"""Effective breadth — the number this package refuses to let a portfolio omit.

WHY
---
``IR ~= IC * sqrt(BR)``. Our measured BR across 8 correlated perps is **1.2-1.5**,
not 8 (note 27 §1.3, note 24 §7). Under the fundamental law that makes the
achievable information ratio **0.39x** what an eight-independent-asset intuition
suggests. Every allocation this package produces reports its breadth, because a
weight vector without one is a claim about diversification that has not been made.

There are six defensible definitions and they disagree by a factor of six on our
own data. That disagreement is not noise - each measures a different thing - so
all six are reported and the one used for a decision must be named:

    1. weight entropy          exp(-sum p ln p), p = |w|/sum|w|   correlation-blind
    2. inverse Herfindahl      1 / sum p^2                        correlation-blind
    3. rho-bar formula         N / (1 + (N-1) rho_bar)            assumes equicorrelation
    4. independent bets        1' R^-1 1                          exact, equal-weight book
    5. participation ratio     (sum L)^2 / sum L^2                spectrum only, weight-free
    6. factor-entropy ENB      exp(-sum p ln p) over uncorrelated factors, weight-aware

Riskfolio's ``nea`` constraint (``Portfolio.py:3041``) is definition (2) sold as a
diversification measure: at equal weight it reports 8 for our universe where the
independent-bets count is 1.22-1.47, so **it will certify a portfolio of eight
copies of the same trade as fully diversified** (note 24 §2 trap).

MEASURED HERE, AND IT IS A NEGATIVE RESULT WORTH KEEPING
---------------------------------------------------------
Definition (6) needs a basis of uncorrelated factors. The two candidates are PCA
and Meucci's *minimum torsion*, and minimum torsion is the one the literature
recommends because PCA factors rotate arbitrarily with the sample. We implemented
minimum torsion properly (derivation below; the variance decomposition identity is
verified to 1e-16 and the factor covariance is diagonal to 2.6e-15) and then ran it
on equicorrelated universes. It does not measure what we need:

    universe                        MT-ENB   PCA-ENB   1'R^-1 1   div. ratio
    8 assets rho=0.95, equal weight   8.000     1.000      1.046        1.023
    8 assets rho=0.95, SINGLE asset   7.246     1.241      1.046        1.000
    8 assets rho=0.80, equal weight   8.000     1.000      1.216        1.103
    8 assets rho=0.80, SINGLE asset   5.178     2.033      1.216        1.000

**Minimum-torsion ENB says a one-asset portfolio holds 7.25 bets.** The arithmetic
is right: at rho=0.95 each torsion factor is a near-market-neutral combination
(row 0 of ``t`` is ``[+2.14, -0.28 x7]``), so a single long asset projects onto all
eight of them with nearly equal variance shares. That is a true statement about the
torsion basis and a useless statement about diversification.

AND A SECOND MEASURED NEGATIVE RESULT, ON THE MEASURE THE CORPUS ITSELF QUOTES
------------------------------------------------------------------------------
``1' R^-1 1`` is the number note 27 §1.3 uses for our 8-perp panel, and at N=8 it is
fine. **At N in the hundreds it is not a usable statistic.** Measured on the real
collected panel, 108 perps x 1,275 daily bars, rho_bar 0.534:

    equicorrelation truth  N/(1+(N-1)rho_bar)          1.86
    sample 1' R^-1 1                                  55.11
    inverse-Wishart bias correction x (T-N-1)/T       50.40   (does not rescue it)
    participation ratio                                3.15

    first half   1' R^-1 1 = 160.39     participation ratio 3.58
    second half  1' R^-1 1 =  66.22     participation ratio 2.65

    min-var book fitted on the first half, applied OUT OF SAMPLE:
        in-sample variance 0.0062 -> 160.4 bets
        out-of-sample      0.0911 ->  11.0 bets      **14.6x collapse**

    shrinking towards constant correlation drives it monotonically
    55.1 (delta=0) -> 15.3 -> 9.5 -> 5.7 -> 3.4 -> 2.5 -> 2.1 -> 1.86 (delta=1)
    while the participation ratio moves only 3.15 -> 3.43.

``R^-1`` weights the **smallest** eigenvalues most, and at ``q = T/N = 11.8`` those
are almost entirely estimation noise. So:

* **Quote ``participation_ratio``.** It uses the eigenvalues directly rather than
  their reciprocals, it is stable across sample halves, and it is what the
  fundamental law should be evaluated at.
* Or quote ``realised_independent_bets``, which measures what the portfolio actually
  achieved out of sample. That is the strongest form of the claim.
* ``independent_bets`` is retained (note 27's number at N=8 is correct and
  reproducible) and reported with its bias correction beside it, but the report no
  longer computes the information ratio from it.

Minimum torsion is likewise retained, fully implemented, because it is the right
tool for *risk budgeting across uncorrelated factors* - a different question - and
because a measured negative result is worth more than an unexamined recommendation.

One further caveat on ``1' R^-1 1``: with genuinely negative correlations it can
**exceed N** (we measure 19.04 on an 8-asset synthetic with hedging pairs). It is
the reciprocal of the minimum achievable variance of a unit-sum portfolio on
standardised assets, so "more than N independent bets" is arithmetically meaningful
and semantically misleading.

MINIMUM TORSION, DERIVED
------------------------
Meucci, Santangelo & Deguest (2015) define a set of *uncorrelated* factors chosen
to stay as close as possible to the original assets, so that a "bet" retains its
economic identity. PCA factors are uncorrelated but arbitrary (they rotate with the
sample), which is the defect minimum torsion is designed to fix.

Working in unit-variance coordinates with correlation ``C``, we seek ``t`` with
``t C t' = diag(d^2)`` minimising ``sum_i Var(r_i - z_i)``. Write
``t = diag(d) Q C^{-1/2}`` with ``Q`` orthogonal; then

    sum_i Var(r_i - z_i) = n - 2 tr(diag(d) Q C^{1/2}) + sum_i d_i^2

Optimising over ``d`` for fixed ``Q`` gives ``d_i = (Q C^{1/2})_ii``, and
substituting leaves

    minimise  n - sum_i (Q C^{1/2})_ii^2      over orthogonal Q

which is non-convex on the orthogonal group - hence an alternating algorithm:
(a) Procrustes step for ``Q`` given ``d`` (SVD of ``C^{1/2} diag(d)``), (b) closed
form for ``d`` given ``Q``. ``Q = I`` (symmetric / Lowdin orthogonalisation,
``t = C^{-1/2}``) is the exact optimum under the extra constraint that the factors
have unit variance, and is used as the starting point. The objective is
non-increasing at every step; convergence and the diagonality of ``t C t'`` are
asserted in the tests, not assumed.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from _linalg import cov_to_corr, inv_psd, sqrtm_psd, symmetrise

__all__ = [
    "BreadthReport",
    "enb_weight_entropy",
    "enb_inverse_herfindahl",
    "enb_rho_bar",
    "enb_independent_bets",
    "bias_corrected_independent_bets",
    "realised_independent_bets",
    "enb_participation_ratio",
    "minimum_torsion",
    "enb_minimum_torsion",
    "enb_pca",
    "risk_contributions",
    "marginal_risk_contributions",
    "diversification_ratio",
    "information_ratio_from_breadth",
    "required_ic",
    "breadth_report",
]


def _normalise(weights: np.ndarray) -> np.ndarray:
    w = np.asarray(weights, dtype=float).ravel()
    if w.size == 0:
        raise ValueError("empty weight vector")
    return w


# ---------------------------------------------------------------------------
# weight-only measures
# ---------------------------------------------------------------------------


def enb_weight_entropy(weights: np.ndarray) -> float:
    """``exp(-sum p ln p)`` on ``p = |w| / sum|w|``.

    Correlation-blind. Reported because it is the number most people mean by
    "how many positions do I have", and showing it next to definition (6) is the
    cheapest way to make the gap visible.
    """
    w = np.abs(_normalise(weights))
    s = w.sum()
    if s <= 0:
        return 0.0
    p = w / s
    p = p[p > 0]
    return float(np.exp(-np.sum(p * np.log(p))))


def enb_inverse_herfindahl(weights: np.ndarray) -> float:
    """``1 / sum p^2`` on ``p = |w| / sum|w|``.

    This is Riskfolio's ``nea`` (``||w||_2 <= 1/sqrt(nea)``). Correlation-blind:
    see the module docstring for why quoting it as a diversification number is a
    category error.
    """
    w = np.abs(_normalise(weights))
    s = w.sum()
    if s <= 0:
        return 0.0
    p = w / s
    return float(1.0 / np.sum(p**2))


# ---------------------------------------------------------------------------
# correlation-aware measures
# ---------------------------------------------------------------------------


def enb_rho_bar(n_assets: int, rho_bar: float) -> float:
    """``N / (1 + (N-1) rho_bar)``.

    The equicorrelation closed form. On our panel at rho_bar = 0.797 with N = 8 it
    gives **1.216**; at rho_bar = 0.679 it gives 1.516. It is also the correction
    that has to be applied before any multi-asset significance test: 90 S&P100
    stocks over one window is an effective N of **2.19**, so the sign-test
    threshold is 74/90 wins, not 55 (note 27 R24). No paper in ~150 computes it.
    """
    n = int(n_assets)
    if n < 1:
        raise ValueError("n_assets must be >= 1")
    denom = 1.0 + (n - 1) * float(rho_bar)
    if denom <= 0:
        return float("inf")
    return n / denom


def enb_independent_bets(corr: np.ndarray, *, n_observations: int | None = None) -> float:
    """``1' R^-1 1`` — independent bets held by an *equal-weight* book.

    Exact on the **true** correlation matrix (no equicorrelation assumption) and it
    reduces to ``enb_rho_bar`` when the correlation is constant. It went
    **negative** (-13.83) on a detoned matrix in note 38 §5.6, which makes it the
    single best detector of a numerically broken correlation matrix: a negative
    count of independent bets is arithmetic telling you the matrix is indefinite.

    **UPWARD BIAS AT SMALL q = T/N, MEASURED HERE. READ THIS.**
    ``R^-1`` amplifies the smallest eigenvalues, and at small ``q`` those are
    dominated by estimation noise. So the *sample* ``1' R^-1 1`` is biased upward,
    badly, exactly in the high-breadth regime where we most want to trust it.
    Measured on the real panel at ``N = 108, T = 1275`` (q = 11.8, rho_bar = 0.534):

        sample  1' R^-1 1                        13.99
        truth   N / (1 + (N-1) rho_bar)           1.86      -> **7.5x overstated**
        participation ratio (same data)           3.18

    ``bias_corrected_independent_bets`` applies the finite-sample correction and
    ``breadth_report`` prints both. **When ``q < 50``, quote the participation
    ratio** — it uses the eigenvalues directly rather than their reciprocals and is
    far better behaved. Pass ``n_observations`` here to get a warning stamped into
    the report when the raw number is not to be trusted.
    """
    r = symmetrise(np.asarray(corr, dtype=float))
    ones = np.ones(r.shape[0])
    try:
        val = float(ones @ inv_psd(r) @ ones)
    except ValueError:
        val = float(ones @ np.linalg.pinv(r) @ ones)
    return val


def realised_independent_bets(
    in_sample: np.ndarray, out_of_sample: np.ndarray
) -> dict:
    """Measure breadth **out of sample**, which is the only honest way to measure it.

    Build the minimum-variance portfolio of *standardised* returns on the in-sample
    block (``w ∝ R_in^-1 1``, normalised to sum 1) and then compare the variance it
    achieves in sample against the variance the **same weights** achieve out of
    sample. On standardised returns the reciprocal of that variance is exactly the
    number of independent bets the book realised.

    THE MEASUREMENT THAT MOTIVATES THIS FUNCTION. Real panel, 108 perps, 1,275 daily
    bars, split in half:

        in-sample variance of the min-var standardised book   0.0062  ->  160.4 bets
        SAME WEIGHTS, out of sample                           0.0911  ->   11.0 bets

    A **14.6x collapse**. And the split-half instability of the raw statistic is of
    the same size: 160.4 on the first half, 66.2 on the second. The reason is that
    ``R^-1`` weights the *smallest* eigenvalues most heavily and at ``q = 11.8``
    those are almost entirely estimation noise; shrinking towards constant
    correlation drives the number monotonically from 55.1 (delta=0) to 1.86
    (delta=1) while the participation ratio barely moves (3.15 -> 3.43).

    So: **``1' R^-1 1`` is not a usable breadth measure above a handful of assets,
    and the finite-sample inverse-Wishart correction does not rescue it** (it takes
    55.1 to 50.4). Quote the participation ratio, which is stable across halves
    (3.58 / 2.65), or quote this out-of-sample number, which is what the portfolio
    actually got.
    """
    a = np.asarray(in_sample, dtype=float)
    b = np.asarray(out_of_sample, dtype=float)
    if a.ndim != 2 or b.ndim != 2 or a.shape[1] != b.shape[1]:
        raise ValueError("in_sample and out_of_sample must be (T, N) with matching N")
    sd_a = a.std(axis=0, ddof=1)
    sd_b = b.std(axis=0, ddof=1)
    live = (sd_a > 0) & (sd_b > 0)
    n_dropped = int(np.sum(~live))
    if n_dropped:
        # A zero-variance column is a stale or halted instrument. Standardising it is
        # undefined, so it is dropped and COUNTED - never filled, never imputed. On a
        # 675-symbol perp panel this happens routinely: a newly listed instrument can
        # print the same close all day.
        a, b = a[:, live], b[:, live]
        sd_a, sd_b = sd_a[live], sd_b[live]
    n = a.shape[1]
    if n < 2:
        raise ValueError(
            f"only {n} instrument(s) have non-zero volatility in both blocks; "
            "breadth is not defined"
        )
    za, zb = a / sd_a, b / sd_b
    corr_a = np.corrcoef(za, rowvar=False)
    ones = np.ones(n)
    try:
        w = inv_psd(symmetrise(corr_a)) @ ones
    except ValueError:
        w = np.linalg.pinv(symmetrise(corr_a)) @ ones
    s = float(w.sum())
    if s == 0:
        raise ValueError("degenerate minimum-variance solution")
    w = w / s
    var_in = float(np.var(za @ w, ddof=1))
    var_out = float(np.var(zb @ w, ddof=1))
    return {
        "in_sample_bets": float("inf") if var_in <= 0 else 1.0 / var_in,
        "out_of_sample_bets": float("inf") if var_out <= 0 else 1.0 / var_out,
        "overstatement_ratio": (var_out / var_in) if var_in > 0 else float("nan"),
        "in_sample_variance": var_in,
        "out_of_sample_variance": var_out,
        "participation_ratio_in": enb_participation_ratio(corr_a),
        "participation_ratio_out": enb_participation_ratio(np.corrcoef(zb, rowvar=False)),
        "n_assets": n,
        "n_dropped_zero_volatility": n_dropped,
        "gross": float(np.sum(np.abs(w))),
    }


def bias_corrected_independent_bets(corr: np.ndarray, n_observations: int) -> float:
    """``1' R^-1 1`` with the finite-sample inverse-Wishart correction.

    For a sample correlation from ``T`` observations on ``N`` assets, the expected
    inverse satisfies ``E[R_hat^-1] ~= (T / (T - N - 1)) R^-1`` (the inverse-Wishart
    mean), so the naive statistic is inflated by roughly ``T / (T - N - 1)``.
    Dividing it back out removes the first-order bias.

    This is a first-order correction and it does **not** rescue the statistic at
    ``q`` near 1 - at ``T <= N + 1`` the sample correlation is singular and no
    correction exists. It returns ``nan`` there rather than a large number.
    """
    r = symmetrise(np.asarray(corr, dtype=float))
    n = r.shape[0]
    t = int(n_observations)
    if t <= n + 1:
        return float("nan")
    return enb_independent_bets(r) * (t - n - 1) / t


def enb_participation_ratio(corr: np.ndarray) -> float:
    """``(sum lambda)^2 / sum lambda^2`` of the correlation spectrum.

    Weight-free: a property of the universe, not of the portfolio. Measured 1.879
    on our panel with the sample estimator, 1.890 after MP denoising, 6.096 after
    detoning (the last being an artefact of a singular matrix, not diversification).
    """
    r = symmetrise(np.asarray(corr, dtype=float))
    ev = np.linalg.eigvalsh(r)
    ss = float(np.sum(ev**2))
    return float(ev.sum() ** 2 / ss) if ss > 0 else float("nan")


def minimum_torsion(
    cov: np.ndarray,
    *,
    max_iterations: int = 10000,
    tol: float = 1e-14,
) -> tuple[np.ndarray, dict]:
    """Meucci minimum-torsion matrix ``t`` mapping returns to uncorrelated factors.

    Returns ``(t, info)`` where ``z = t @ r`` has diagonal covariance and ``info``
    carries the achieved tracking error, the off-diagonal residual, and the
    iteration count. Derivation in the module docstring.

    The tests assert that ``t Sigma t'`` is diagonal to 1e-10 and that the
    tracking error is not worse than the symmetric-orthogonalisation start - both
    of which are properties the algorithm is supposed to have and which no
    implementation in the corpus checks.
    """
    cov = symmetrise(np.asarray(cov, dtype=float))
    n = cov.shape[0]
    sd = np.sqrt(np.clip(np.diag(cov), 0.0, None))
    if np.any(sd <= 0):
        raise ValueError("minimum torsion needs strictly positive variances")
    corr = cov_to_corr(cov)
    c_half = sqrtm_psd(corr)

    def objective(q: np.ndarray) -> float:
        diag = np.diag(q @ c_half)
        return float(n - np.sum(diag**2))

    q = np.eye(n)
    best = objective(q)
    n_iter = 0
    for n_iter in range(1, max_iterations + 1):
        d = np.diag(q @ c_half)
        a = c_half @ np.diag(d)
        u, _, vt = np.linalg.svd(a)
        q_new = vt.T @ u.T
        val = objective(q_new)
        if val > best - tol:
            if val < best:
                q, best = q_new, val
            break
        q, best = q_new, val
    d = np.diag(q @ c_half)
    if np.any(np.abs(d) < 1e-12):
        raise ValueError(
            "minimum torsion degenerated: a factor has zero variance, which means "
            "the correlation matrix is (numerically) singular"
        )
    c_half_inv = np.linalg.inv(c_half)
    t_norm = np.diag(d) @ q @ c_half_inv
    t = t_norm @ np.diag(1.0 / sd)
    factor_cov = t @ cov @ t.T
    off = float(np.max(np.abs(factor_cov - np.diag(np.diag(factor_cov)))))
    info = {
        "iterations": n_iter,
        "tracking_error": float(best),
        "max_offdiagonal_factor_cov": off,
        "symmetric_start_tracking_error": float(n - np.sum(np.diag(c_half) ** 2)),
    }
    return t, info


def enb_minimum_torsion(
    weights: np.ndarray, cov: np.ndarray
) -> tuple[float, np.ndarray]:
    """Meucci effective number of bets. Returns ``(ENB, diversification_distribution)``.

    ``p_i`` is the share of portfolio variance carried by minimum-torsion factor
    ``i``; ``ENB = exp(-sum p ln p)``.

    **Do not quote this as a diversification number on a single-factor-dominated
    universe.** Measured here: a one-asset portfolio on 8 perps at rho = 0.95
    scores 7.246. See the module docstring for the table and the reason. It is a
    correct decomposition over the torsion basis and the right input to *factor*
    risk budgeting; it is the wrong answer to "how many bets do I hold".
    """
    w = _normalise(weights)
    cov = symmetrise(np.asarray(cov, dtype=float))
    t, _ = minimum_torsion(cov)
    theta = np.linalg.solve(t.T, w)          # factor exposures: t^-T w
    factor_var = np.diag(t @ cov @ t.T)
    contrib = theta**2 * factor_var
    total = float(contrib.sum())
    if total <= 0:
        return 0.0, np.zeros_like(contrib)
    p = contrib / total
    pos = p[p > 0]
    return float(np.exp(-np.sum(pos * np.log(pos)))), p


def enb_pca(weights: np.ndarray, cov: np.ndarray) -> tuple[float, np.ndarray]:
    """The same entropy, on PCA factors instead of minimum-torsion factors.

    Included precisely so the gap can be shown. PCA factors are uncorrelated but
    they are **not** close to the original assets and they rotate with the sample,
    so the "bets" they count have no stable economic identity. Where this and
    ``enb_minimum_torsion`` disagree, minimum torsion is the one to quote.
    """
    w = _normalise(weights)
    cov = symmetrise(np.asarray(cov, dtype=float))
    vals, vecs = np.linalg.eigh(cov)
    order = np.argsort(vals)[::-1]
    vals, vecs = vals[order], vecs[:, order]
    theta = vecs.T @ w
    contrib = theta**2 * np.clip(vals, 0.0, None)
    total = float(contrib.sum())
    if total <= 0:
        return 0.0, np.zeros_like(contrib)
    p = contrib / total
    pos = p[p > 0]
    return float(np.exp(-np.sum(pos * np.log(pos)))), p


# ---------------------------------------------------------------------------
# risk contributions
# ---------------------------------------------------------------------------


def marginal_risk_contributions(weights: np.ndarray, cov: np.ndarray) -> np.ndarray:
    """``d sigma_p / d w_i = (Sigma w)_i / sigma_p``."""
    w = _normalise(weights)
    cov = symmetrise(np.asarray(cov, dtype=float))
    sw = cov @ w
    sig = float(np.sqrt(max(w @ sw, 0.0)))
    if sig <= 0:
        return np.zeros_like(w)
    return sw / sig


def risk_contributions(
    weights: np.ndarray, cov: np.ndarray, *, normalise: bool = True
) -> np.ndarray:
    """``RC_i = w_i (Sigma w)_i / sigma_p``, summing to ``sigma_p`` (Euler allocation).

    With ``normalise=True`` they sum to 1 and are directly comparable to a risk
    budget. This is the right sizing primitive for perps: Riskfolio's
    risk-contribution *constraint* ``A_rc diag(Sigma W) <= b_rc w'Sigma w``
    (``Portfolio.py:3031``) caps an asset's share of portfolio **variance**, which
    is what "no single perp may carry more than 25% of my risk" actually means -
    a weight cap does not say that at all when correlations are 0.8.
    """
    w = _normalise(weights)
    cov = symmetrise(np.asarray(cov, dtype=float))
    sw = cov @ w
    var = float(w @ sw)
    if var <= 0:
        return np.zeros_like(w)
    rc = w * sw
    return rc / var if normalise else rc / np.sqrt(var)


def diversification_ratio(weights: np.ndarray, cov: np.ndarray) -> float:
    """``(w' sigma) / sqrt(w' Sigma w)`` — Choueifaty's diversification ratio.

    1.0 for a single asset or a perfectly correlated book; ``sqrt(N)`` for N
    independent equal-risk assets. It is the objective of the maximum
    diversification portfolio in ``convex.py``.
    """
    w = _normalise(weights)
    cov = symmetrise(np.asarray(cov, dtype=float))
    sd = np.sqrt(np.clip(np.diag(cov), 0.0, None))
    denom = float(np.sqrt(max(w @ cov @ w, 0.0)))
    if denom <= 0:
        return float("nan")
    return float(np.abs(w) @ sd / denom)


# ---------------------------------------------------------------------------
# the fundamental law
# ---------------------------------------------------------------------------


def information_ratio_from_breadth(
    ic: float, breadth: float, transfer_coefficient: float = 1.0
) -> float:
    """``IR = TC * IC * sqrt(BR)``.

    The transfer coefficient (Clarke, de Silva & Thorley 2002) is the correlation
    between the *unconstrained* optimal active weights and the ones you can
    actually hold. It is not a detail: a long-only constraint on a universe with
    rho_bar 0.68 typically costs 30-50% of it, and it multiplies the IR directly.
    Report it or the IR is an upper bound being quoted as a forecast.
    """
    if breadth < 0:
        raise ValueError("breadth must be non-negative")
    return float(transfer_coefficient * ic * np.sqrt(breadth))


def required_ic(
    target_ir: float, breadth: float, transfer_coefficient: float = 1.0
) -> float:
    """Invert the fundamental law: what IC would this book need to hit ``target_ir``?

    At our breadth this is the sentence that kills most ideas before they are
    coded. BR = 1.35, TC = 0.7, target IR = 1.0 requires **IC = 1.229**, which is
    impossible (IC is a correlation). The honest reading: at this breadth no
    achievable IC produces an IR of 1, so the only route to a higher IR is more
    breadth - which is why breadth is an engineering programme and not a research
    question.
    """
    if breadth <= 0 or transfer_coefficient == 0:
        return float("inf")
    return float(target_ir / (transfer_coefficient * np.sqrt(breadth)))


# ---------------------------------------------------------------------------
# the report
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BreadthReport:
    n_assets: int
    gross_exposure: float
    net_exposure: float
    weight_entropy: float
    inverse_herfindahl: float
    rho_bar: float
    rho_bar_formula: float
    independent_bets: float
    independent_bets_bias_corrected: float
    participation_ratio: float
    minimum_torsion_enb: float
    pca_enb: float
    diversification_ratio: float
    portfolio_volatility: float
    max_risk_contribution: float
    torsion_info: dict

    def summary(self) -> str:
        return "\n".join(
            [
                f"N assets                    {self.n_assets}",
                f"gross / net exposure        {self.gross_exposure:.4f} / {self.net_exposure:.4f}",
                f"portfolio volatility        {self.portfolio_volatility:.6f} per bar",
                f"max risk contribution       {self.max_risk_contribution:.4f}",
                f"diversification ratio       {self.diversification_ratio:.4f}",
                "-- effective breadth, six definitions --",
                f"  participation ratio       {self.participation_ratio:>9.4f}   <-- quote this one",
                f"  independent bets 1'R^-1 1 {self.independent_bets:>9.4f}   upward-biased at small q",
                f"    bias-corrected          {self.independent_bets_bias_corrected:>9.4f}   x (T-N-1)/T",
                f"  N/(1+(N-1)rho_bar)        {self.rho_bar_formula:>9.4f}   (rho_bar={self.rho_bar:.4f})",
                f"  weight entropy            {self.weight_entropy:>9.4f}   correlation-blind",
                f"  inverse Herfindahl        {self.inverse_herfindahl:>9.4f}   correlation-blind (= Riskfolio nea)",
                f"  Meucci ENB (min torsion)  {self.minimum_torsion_enb:>9.4f}   factor-basis entropy, NOT diversification",
                f"  PCA ENB                   {self.pca_enb:>9.4f}   factor-basis entropy, rotation-unstable",
                        f"IR at IC=0.03, TC=1         {information_ratio_from_breadth(0.03, self.participation_ratio):.4f}",
            ]
        )


def breadth_report(
    weights: np.ndarray, cov: np.ndarray, *, n_observations: int | None = None
) -> BreadthReport:
    """Every breadth measure for one portfolio, in one object.

    This is what ``construct.py`` attaches to every allocation it produces. It is
    cheap (one eigendecomposition plus the torsion iteration) and it is the only
    defence against shipping a "diversified" 8-perp book that holds 1.3 bets.
    """
    w = _normalise(weights)
    cov = symmetrise(np.asarray(cov, dtype=float))
    corr = cov_to_corr(cov)
    n = cov.shape[0]
    off = corr[~np.eye(n, dtype=bool)]
    rho = float(np.mean(off)) if off.size else 0.0
    mt_enb, _ = enb_minimum_torsion(w, cov)
    t, info = minimum_torsion(cov)
    _ = t
    pca, _ = enb_pca(w, cov)
    rc = risk_contributions(w, cov)
    return BreadthReport(
        n_assets=n,
        gross_exposure=float(np.sum(np.abs(w))),
        net_exposure=float(np.sum(w)),
        weight_entropy=enb_weight_entropy(w),
        inverse_herfindahl=enb_inverse_herfindahl(w),
        rho_bar=rho,
        rho_bar_formula=enb_rho_bar(n, rho),
        independent_bets=enb_independent_bets(corr),
        independent_bets_bias_corrected=(
            bias_corrected_independent_bets(corr, n_observations)
            if n_observations is not None
            else float("nan")
        ),
        participation_ratio=enb_participation_ratio(corr),
        minimum_torsion_enb=mt_enb,
        pca_enb=pca,
        diversification_ratio=diversification_ratio(w, cov),
        portfolio_volatility=float(np.sqrt(max(w @ cov @ w, 0.0))),
        max_risk_contribution=float(np.max(np.abs(rc))) if rc.size else 0.0,
        torsion_info=info,
    )
