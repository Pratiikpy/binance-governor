"""Market impact: the calibrated forms, the bracket, and the crossover that retires them.

WHY THIS MODULE EXISTS, AND WHY IT MATTERS LESS THAN YOU EXPECT
--------------------------------------------------------------
The single most decision-relevant number in the whole microstructure canon, for a book
our size, is this: applying Almgren, Thum, Hauptmann & Li (2005) at their own fitted
coefficients, **temporary impact only equals OKX's 6 bps one-way taker fee at 5.2% of
a perp's daily volume** (at sigma = 2.5% daily; 7.5% at sigma = 2%, 1.6% at sigma = 5%).
Below that participation the fee is the dominant execution cost and scheduling is
second-order.  At 1% of ADV we would be shaving 2.24 bps of impact while paying 12 bps
of fee on the round trip.

That is why this module exists but is not the centre of gravity: it is here to *prove*
that impact is the smaller term at our size, to keep us honest if that ever stops being
true, and to give a defensible cost number for a sizing decision.

TRAP A23 — SAY WHICH IMPACT YOU MEAN
------------------------------------
Three different quantities in this literature are all called "impact" and they differ
by up to 10x on the same trade:

* **Immediate** — the contemporaneous quote revision.  Hasbrouck (1991) measures it at
  $0.014 on a $15.53 stock (9 bps) and the *ultimate* cumulative revision at $0.028
  (18 bps).  **The instantaneous figure is exactly half the truth.**
* **Temporary, net of half the permanent** — Almgren's ``K = J - I/2``.  This is what
  ``eta = 0.142, beta = 3/5`` fits.  2.24 bps at 1% of ADV, sigma = 2.5%.
* **Full metaorder** — Toth et al.'s ``Delta = Y sigma sqrt(Q/V)``, ``Y = O(1)``.
  Numerically: 1% of daily volume moves the price ~0.1 sigma_daily, i.e. **25 bps** at
  sigma = 2.5% — an order of magnitude above Almgren's number for the same fraction.

They are not measuring the same object, which is exactly why every number this module
returns is labelled, and why :func:`impact_bracket` returns a *pair*.  Quote the pair,
never a point estimate.

WHAT IS REJECTED, AND WHY
-------------------------
* **Almgren's permanent-impact coefficient for perps.**  ``I = gamma sigma (X/V)(Theta/V)^{1/4}``
  needs ``Theta`` = shares outstanding.  A perp has none.  The nearest analogue is
  open interest / daily volume, which for BTC perps is O(0.5) against the ~200 typical
  of a large-cap equity — a factor of 400 in the wrong place inside a fourth root.
  :func:`almgren_permanent_bps` therefore *requires* an explicit liquidity factor and
  refuses to guess one.
* **Kyle's lambda as a calibration.**  ``lambda = sqrt(Sigma_0 / sigma_u^2)`` is a
  ratio of two unobservables.  The "Kyle lambda" everyone regresses (price change on
  signed order flow) is not the object in the paper.  :func:`kyle_lambda_bps` is
  provided as the *empirical* regression coefficient, named accordingly, with the
  distinction stated in its docstring.
* **Obizhaeva-Wang as an execution engine at our size.**  Their whole result depends on
  resilience ``rho``, which they do not measure.  The one thing we keep is the
  block-at-the-ends conclusion: if ``rho`` is high — and crypto books refill fast — the
  optimum collapses toward "just trade it".  :func:`should_slice` encodes that, but note
  it is **not** a fee argument: a percentage fee is path-independent and slicing does not
  multiply it.  The cost of slicing is timing risk, and that is what is compared.

CALIBRATION PROVENANCE (state it every time)
--------------------------------------------
``ALMGREN_ETA = 0.142 +/- 0.0062``, ``ALMGREN_BETA = 0.600 +/- 0.038``, fitted on
Citigroup US equity desk orders Dec 2001 - Jun 2003, 682,562 orders filtered to 29,509
(95.7% discarded), **R-squared under 1%**, and the paper says in its own introduction
"We hope to provide out-of-sample backtests in a future paper."  It is a well-executed
in-sample fit on 23-year-old US large-cap equities.  Use it as a prior; never call it
validated.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

import numpy as np

__all__ = [
    "ALMGREN_ETA",
    "ALMGREN_ETA_SE",
    "ALMGREN_BETA",
    "ALMGREN_BETA_SE",
    "ALMGREN_GAMMA",
    "TOTH_Y",
    "TOTH_DELTA",
    "HASBROUCK_PERMANENT_MULTIPLE",
    "ImpactEstimate",
    "almgren_temporary_bps",
    "almgren_permanent_bps",
    "toth_sqrt_bps",
    "kyle_lambda_bps",
    "linear_impact_bps",
    "impact_bracket",
    "crossover_participation",
    "obizhaeva_wang_recovery",
    "should_slice",
    "fit_impact_exponent",
]

# --- Almgren, Thum, Hauptmann & Li (2005), Risk 18, 58-62 ---------------------
ALMGREN_ETA = 0.142
ALMGREN_ETA_SE = 0.0062
ALMGREN_BETA = 0.600
ALMGREN_BETA_SE = 0.038
#: Permanent-impact coefficient. Recorded for completeness; REJECTED for perps.
ALMGREN_GAMMA = 0.314
ALMGREN_GAMMA_SE = 0.041

# --- Toth et al. (2011), Phys. Rev. X 1, 021006 -------------------------------
TOTH_Y = 1.0
TOTH_DELTA = 0.5

#: Hasbrouck (1991): ultimate cumulative quote revision / immediate revision.
#: $0.028 / $0.014 on Ames Department Stores. Any impact number measured
#: contemporaneously understates the permanent component by about this factor.
HASBROUCK_PERMANENT_MULTIPLE = 2.0


@dataclass(frozen=True)
class ImpactEstimate:
    """An impact number that carries what kind of impact it is and where it came from.

    Trap A23 in code: you cannot obtain a bare float out of this module.
    """

    bps: float
    kind: Literal["temporary", "permanent", "metaorder", "immediate", "linear"]
    source: str
    provenance: str

    def __str__(self) -> str:
        return f"{self.bps:.3f} bps [{self.kind}] ({self.source})"


def _validate(participation: float, daily_vol_pct: float) -> None:
    if participation < 0:
        raise ValueError("participation must be >= 0")
    if participation > 1.0:
        raise ValueError(
            f"participation={participation} exceeds 100% of daily volume. Every impact "
            "form here is fitted on participations below a few percent; extrapolating "
            "a power law four orders of magnitude past its data is not an estimate."
        )
    if daily_vol_pct <= 0:
        raise ValueError("daily_vol_pct must be > 0")


def almgren_temporary_bps(
    participation: float,
    daily_vol_pct: float,
    *,
    eta: float = ALMGREN_ETA,
    beta: float = ALMGREN_BETA,
) -> ImpactEstimate:
    """Temporary impact, net of half the permanent, in bps.

    ``K / sigma = eta * |X / (V T)|^beta`` where ``X/(V T)`` is the participation rate
    (order size as a fraction of the volume traded over the execution window).  Note
    the paper's own finding that the temporary function carries **no stock-specific
    factor**: "liquidity cost as a fraction of volatility depends only on shares traded
    as a fraction of average daily volume."  That dimensionless framing is what makes
    it transplantable to 8 heterogeneous perps at all.

    Reproduces the corpus table exactly: at ``daily_vol_pct=2.5`` the values are
    0.56 / 1.48 / 2.24 / 5.88 / 8.92 bps at 0.1% / 0.5% / 1% / 5% / 10% of daily volume.
    """
    _validate(participation, daily_vol_pct)
    if participation == 0:
        return ImpactEstimate(0.0, "temporary", "almgren-2005", "eta=%.4f beta=%.3f" % (eta, beta))
    bps = eta * (daily_vol_pct * 100.0) * (participation ** beta)
    return ImpactEstimate(
        bps=bps,
        kind="temporary",
        source="almgren-2005",
        provenance=(
            f"eta={eta:.4f}+/-{ALMGREN_ETA_SE}, beta={beta:.3f}+/-{ALMGREN_BETA_SE}; "
            "Citigroup US equity 2001-2003, in-sample, R^2<1%, 95.7% of orders filtered out"
        ),
    )


def almgren_permanent_bps(
    participation_of_adv: float,
    daily_vol_pct: float,
    liquidity_factor: float,
    *,
    gamma: float = ALMGREN_GAMMA,
    delta: float = 0.25,
) -> ImpactEstimate:
    """Permanent impact. **REQUIRES an explicit liquidity factor; will not guess one.**

    ``I / sigma = gamma * (X/V) * (Theta/V)^delta``.  For an equity ``Theta`` is shares
    outstanding and ``Theta/V`` is inverse turnover, typically ~200.  A perp has no
    shares outstanding; the nearest analogue is open interest / daily volume, which for
    BTC perps is O(0.5).  ``(200)^0.25 = 3.76`` versus ``(0.5)^0.25 = 0.84`` — a 4.5x
    difference that silently rescales every permanent-impact number.

    So this function takes ``liquidity_factor = (Theta/V)`` as a mandatory argument and
    documents that supplying an OI/ADV ratio here is a *transplant*, not a calibration.
    Prefer :func:`toth_sqrt_bps` as the upper bracket instead.
    """
    _validate(participation_of_adv, daily_vol_pct)
    if liquidity_factor <= 0:
        raise ValueError("liquidity_factor must be > 0 and must be supplied explicitly")
    bps = gamma * (daily_vol_pct * 100.0) * participation_of_adv * (liquidity_factor ** delta)
    return ImpactEstimate(
        bps=bps,
        kind="permanent",
        source="almgren-2005",
        provenance=(
            f"gamma={gamma}+/-{ALMGREN_GAMMA_SE}, delta={delta}, "
            f"liquidity_factor={liquidity_factor} SUPPLIED BY CALLER. "
            "REJECTED for perps without an independent re-derivation of the factor."
        ),
    )


def toth_sqrt_bps(
    participation_of_adv: float, daily_vol_pct: float, *, y: float = TOTH_Y, delta: float = TOTH_DELTA
) -> ImpactEstimate:
    """Full metaorder impact under the square-root law, in bps.

    ``Delta = Y sigma (Q/V)^delta`` with ``Y = O(1)``, ``delta ~ 0.5`` for small-tick
    contracts and ~0.6 for large-tick.  Measured by CFM on ~500,000 proprietary futures
    metaorders 2007-2010, over ``Q/V`` from a few 1e-4 to a few percent.

    The mechanism behind it is the one to remember when anyone proposes resting an
    order: the latent supply/demand profile is V-shaped and **vanishes at the current
    price**, so the volume genuinely available at the touch is close to zero and what
    looks like depth is intention that evaporates on approach.  That is the theoretical
    reason a touch fill is adverse.

    This is the **upper** bracket: at 1% of ADV and sigma = 2.5% it returns 25 bps
    against Almgren's 2.24 bps, because it is measuring the whole metaorder including
    the permanent part.
    """
    _validate(participation_of_adv, daily_vol_pct)
    bps = y * (daily_vol_pct * 100.0) * (participation_of_adv ** delta)
    return ImpactEstimate(
        bps=bps,
        kind="metaorder",
        source="toth-2011",
        provenance=(
            f"Y={y}, delta={delta}; CFM proprietary futures metaorders 2007-2010, "
            "~500k trades, no CI published on delta, sample is one fund's own trades"
        ),
    )


def kyle_lambda_bps(lam_per_unit_notional: float, signed_notional: float, price: float) -> ImpactEstimate:
    """Linear impact from an **empirically regressed** lambda. Not Kyle's lambda.

    Kyle (1985) Theorem 1 gives ``lambda = 0.5 * (sigma_u^2 / Sigma_0)^{-1/2}`` — a
    ratio of two quantities nobody can observe.  What practitioners call "Kyle lambda"
    is the slope of a regression of price change on signed order flow, which is a
    different object with the same name.  This function prices the *regression* object
    and says so, so that nobody later cites Kyle for a number Kyle does not contain.

    ``lam_per_unit_notional`` is the fitted slope in price units per unit of signed
    quote-notional.  :func:`~bot.execution.measure.impact_study` fits it from our tape.
    """
    if price <= 0:
        raise ValueError("price must be > 0")
    move = lam_per_unit_notional * signed_notional
    return ImpactEstimate(
        bps=abs(move) / price * 1e4,
        kind="linear",
        source="regressed-lambda",
        provenance=(
            "empirical slope of price change on signed flow. NOT Kyle (1985)'s lambda, "
            "which is unidentified without the private-information variance."
        ),
    )


def linear_impact_bps(participation: float, coefficient_bps: float) -> ImpactEstimate:
    """The naive ``impact = k * participation`` form, for comparison only.

    Almgren-Chriss (2000) assumed linear temporary impact; the same author's 2005 data
    rejected it (beta = 0.600 +/- 0.038, so 0.5 is rejected at 95% and 1.0 is nowhere
    near).  Keep the linear form only to show how much a linear assumption overstates
    small trades and understates large ones.
    """
    if participation < 0:
        raise ValueError("participation must be >= 0")
    return ImpactEstimate(
        bps=coefficient_bps * participation,
        kind="linear",
        source="almgren-chriss-2000",
        provenance="linear temporary impact, REJECTED by Almgren 2005's own fit",
    )


def impact_bracket(participation: float, daily_vol_pct: float) -> tuple[ImpactEstimate, ImpactEstimate]:
    """(lower, upper) impact estimate. **The only sanctioned way to quote impact.**

    Lower = Almgren's temporary form (2.24 bps at 1% ADV, sigma 2.5%).
    Upper = Toth's metaorder square root (25 bps at the same point).

    They differ by ~10x because they measure different things.  A single number here is
    a claim we cannot defend, which is why this returns a pair and there is no
    ``impact_point_estimate``.
    """
    lo = almgren_temporary_bps(participation, daily_vol_pct)
    hi = toth_sqrt_bps(participation, daily_vol_pct)
    if hi.bps < lo.bps:
        # Can happen at very large participation where beta=0.6 > delta=0.5 crosses.
        # Report the true ordering rather than mislabelling which is which.
        return hi, lo
    return lo, hi


def crossover_participation(
    fee_bps_one_way: float,
    daily_vol_pct: float,
    *,
    eta: float = ALMGREN_ETA,
    beta: float = ALMGREN_BETA,
) -> float:
    """Participation at which temporary impact equals the one-way fee.

    Solve ``eta * sigma_bps * p^beta = fee`` for ``p``.  **This is the number that
    retires the optimal-execution literature for our size.**  At OKX's 6 bps taker and
    sigma = 2.5% daily it is 5.17%; at sigma = 2% it is 7.49%; at sigma = 5%, 1.63%.

    Below the crossover, an execution scheduler is optimising the smaller term while
    the fee sits untouched.  Above it, scheduling starts to matter — and at that point
    the honest response is usually to trade less, not to schedule better.
    """
    if fee_bps_one_way <= 0:
        raise ValueError("fee_bps_one_way must be > 0")
    if daily_vol_pct <= 0:
        raise ValueError("daily_vol_pct must be > 0")
    sigma_bps = daily_vol_pct * 100.0
    return float((fee_bps_one_way / (eta * sigma_bps)) ** (1.0 / beta))


def obizhaeva_wang_recovery(
    initial_displacement_bps: float, rho_per_second: float, elapsed_s: float
) -> float:
    """Remaining book displacement after ``elapsed_s``, under exponential resilience.

    ``A_t = V_t + s/2 + x_0 exp(-rho t)`` (Obizhaeva & Wang 2005/2013).  ``rho`` is the
    resilience — how fast the book refills after being hit — and it is the parameter
    the whole optimal-execution answer turns on, and the one nobody in that literature
    measured for a crypto perp.  It is also the one parameter a free depth feed *can*
    estimate: regress post-sweep depth recovery at the touch on time since the sweep.

    Until it is measured for OKX, treat any O-W-derived schedule as unparameterised.
    """
    if rho_per_second < 0:
        raise ValueError("rho_per_second must be >= 0")
    if elapsed_s < 0:
        raise ValueError("elapsed_s must be >= 0")
    return initial_displacement_bps * math.exp(-rho_per_second * elapsed_s)


def should_slice(
    total_participation: float,
    daily_vol_pct: float,
    n_slices: int,
    *,
    timing_bps_single: float = 0.0,
    timing_bps_sliced: float | None = None,
    per_order_fee_bps: float = 0.0,
) -> tuple[bool, str]:
    """Does spreading this order over ``n_slices`` times as long pay for itself?

    **THE FEE IS PATH-INDEPENDENT AND SLICING DOES NOT MULTIPLY IT.**  This is worth
    stating loudly because an earlier version of this module got it wrong.  Every venue
    we trade charges a *percentage* of notional, so ``n`` slices of ``X/n`` pay exactly
    the same total fee as one slice of ``X``.  Almgren & Chriss say the same thing
    algebraically: the ``epsilon * sum|n_k| = epsilon * |X|`` term — half-spread plus
    fees — is path-independent, and **no execution schedule can reduce it**.  That is
    precisely why the fee is a *turnover* problem and not an *execution* problem.

    So what does slicing actually trade?

    * **It reduces impact.**  Almgren's temporary impact is a function of the
      participation *rate* ``X/(VT)``.  Spreading the same ``X`` over ``n`` times the
      window divides the rate by ``n``, and the cost in bps of notional falls from
      ``eta sigma p^beta`` to ``eta sigma (p/n)^beta`` — a factor ``n^{-beta}``.
      Note this is the cost per unit of notional, so it is *not* multiplied by ``n``.
    * **It buys timing risk.**  The execution now spans ``n`` times as long, and the
      dispersion of the achieved price around arrival grows as ``sqrt(T)`` — measured, on
      our own 1-second tape, almost exactly: BTC p95 adverse timing runs
      **2.7 / 5.0 / 7.2 / 15.9 / 28.9 / 56.9 bps at 10 / 30 / 60 / 300 / 900 / 3600 s**.
    * **It can add a per-order cost** where one exists — a flat fee, or a minimum
      notional that forces the slices larger than intended.  Zero on a percentage-fee
      perp; the argument is here so the function is honest on venues where it is not.

    So the comparison is ``impact_saving`` against ``timing_penalty + extra_fees``, and
    at our size the answer is essentially always **do not slice** — not because slicing
    costs fees, but because the impact it saves (**1.68 bps** at 1% of ADV, sliced 10x)
    is an order of magnitude smaller than the timing risk it buys (measured on BTC: p95
    adverse timing goes 7.2 bps at 60 s -> 15.9 at 300 s -> 28.9 at 900 s).  That is
    Obizhaeva-Wang's block-at-the-ends result arrived at from the measurement side.

    ``timing_bps_sliced`` defaults to ``timing_bps_single * sqrt(n_slices)``, the
    diffusive scaling, which is the right default when the measured curve is not to hand.
    """
    if n_slices < 1:
        raise ValueError("n_slices must be >= 1")
    if n_slices == 1:
        return False, "n_slices=1: nothing to decide."
    impact_one = almgren_temporary_bps(total_participation, daily_vol_pct).bps
    impact_sliced = almgren_temporary_bps(total_participation / n_slices, daily_vol_pct).bps
    saving = impact_one - impact_sliced
    if timing_bps_sliced is None:
        timing_bps_sliced = timing_bps_single * math.sqrt(n_slices)
    timing_penalty = timing_bps_sliced - timing_bps_single
    extra_fees = (n_slices - 1) * per_order_fee_bps
    verdict = saving > timing_penalty + extra_fees
    return verdict, (
        f"impact {impact_one:.3f} -> {impact_sliced:.3f} bps saves {saving:.3f} bps; "
        f"timing {timing_bps_single:.3f} -> {timing_bps_sliced:.3f} bps costs "
        f"{timing_penalty:.3f} bps; per-order fees {extra_fees:.3f} bps; "
        f"{'SLICE' if verdict else 'DO NOT SLICE'}"
    )


def fit_impact_exponent(
    participation: np.ndarray, impact_bps: np.ndarray, *, min_points: int = 30
) -> dict[str, float]:
    """Fit ``impact = c * participation^beta`` by OLS in log-log. Returns c, beta, SEs, R^2.

    This is how we test Almgren's ``beta = 0.600 +/- 0.038`` and Toth's ``0.5`` against
    our own tape rather than importing either.  Both papers report a *fitted* exponent
    with a real standard error, so ours has to as well — a point estimate with no SE
    cannot be compared to theirs.
    """
    p = np.asarray(participation, dtype=float)
    y = np.asarray(impact_bps, dtype=float)
    mask = np.isfinite(p) & np.isfinite(y) & (p > 0) & (y > 0)
    p, y = p[mask], y[mask]
    if p.size < min_points:
        raise ValueError(
            f"only {p.size} usable points (need >= {min_points}). Refusing to fit a "
            "power law to a handful of observations."
        )
    X = np.column_stack([np.ones_like(p), np.log(p)])
    coef, *_ = np.linalg.lstsq(X, np.log(y), rcond=None)
    resid = np.log(y) - X @ coef
    dof = p.size - 2
    s2 = float(resid @ resid) / dof
    cov = s2 * np.linalg.inv(X.T @ X)
    ss_tot = float(((np.log(y) - np.log(y).mean()) ** 2).sum())
    ss_res = float(resid @ resid)
    return {
        "c": float(np.exp(coef[0])),
        "beta": float(coef[1]),
        "beta_se": float(np.sqrt(cov[1, 1])),
        "log_c_se": float(np.sqrt(cov[0, 0])),
        "r2": 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan"),
        "n": float(p.size),
    }
