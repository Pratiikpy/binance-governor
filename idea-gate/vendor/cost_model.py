"""The unified round-trip cost model, and the inequalities every trade has to satisfy.

WHAT THIS IS FOR
----------------
Everything else in this package produces one term.  This module adds them up and turns
the sum into the small number of inequalities that decide whether a trade is allowed:

    net_edge      = expected_edge - fee - spread - impact - timing
    break_even    = the edge at which net_edge == 0
    required_p    = the hit rate a symmetric barrier needs to clear the cost
    min_hold_days = how long a position must be held for its edge to outrun funding

The reason this is a module and not four lines inside a strategy is that every one of
those inequalities has been got wrong somewhere in the corpus, in the same direction,
by omitting a term:

* ``hummingbot``'s backtester defaults to ``trade_cost = 0.0002`` — 4 bps round trip
  against our 12 — and models **zero slippage**.
* ``octobot`` defaults fees to 0 and has a copy-paste bug where the ``MAKER`` key
  guards the ``TAKER`` assignment.  ``superalgos`` is a silent 0 for both fees and
  slippage.  ``jesse`` has one scalar with no maker/taker concept at all.
* ``godzilla``'s backtester hard-codes ``data.fee = 0``.
* ``FinceptTerminal``'s ``process_fill(fee=0.0)`` is never passed a fee.
* ``awesome-systematic-trading``'s 49 fee-modelled strategies all use **0.5 bps/side**,
  10-12x cheaper than our round trip; its headline crypto strategy (Sharpe 0.892, 365
  round trips/yr) goes to **-21.5%/yr** at our real cost.
* Qlib's shipped RL-for-execution simulator greps clean for ``fee``, ``cost``,
  ``slippage`` and ``impact``.

THE ARITHMETIC THAT DECIDES THE WHOLE DESIGN
--------------------------------------------
Round-trip taker 0.12%.  Measured intraday edge ~0.00%.  Overnight drift ~0.10%.
Therefore:

* A strategy that round-trips **daily** pays 0.12% to chase 0.00-0.10%.  It loses before
  it starts, and it does so at every parameter setting, which is why 360+ intraday
  variants (breakout and reversion, all trend filters) had a profit factor never above
  0.89.
* AFML section 15.3 in OKX units: a **+/-0.5% barrier needs 62% precision** to break
  even; a **+/-2% barrier needs 53%**.  Meta-labelling does not create edge — it tells
  you the only reachable region is **wide barriers and low turnover**, which is the
  same conclusion the fee arithmetic reaches without a model.
* Funding is a holding cost of **2.67%/yr** on our own basket, i.e. 0.053-0.089 annual
  Sharpe units.  Against Carver's 0.13 SR total cost budget it consumes 41-68% of the
  allowance before a single trade.

So the cost model is not a haircut applied at the end.  It is the constraint that
defines the strategy space, and it belongs at the front.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from fees import FeeSchedule, HOUSE_SCHEDULE, LiquiditySide
from impact import impact_bracket

__all__ = [
    "CostComponents",
    "RoundTripCostModel",
    "BreakEvenStatus",
    "BreakEvenResult",
    "break_even_cost_bps",
    "required_precision",
    "min_barrier_for_precision",
    "min_holding_days",
]


@dataclass(frozen=True)
class CostComponents:
    """Every term, separately, plus the bracket. Never collapsed to one number upstream."""

    fee_bps: float
    spread_bps: float
    impact_low_bps: float
    impact_high_bps: float
    timing_bps: float
    funding_bps: float

    @property
    def total_low_bps(self) -> float:
        return self.fee_bps + self.spread_bps + self.impact_low_bps + self.timing_bps + self.funding_bps

    @property
    def total_high_bps(self) -> float:
        return self.fee_bps + self.spread_bps + self.impact_high_bps + self.timing_bps + self.funding_bps

    @property
    def fee_share_low(self) -> float:
        return self.fee_bps / self.total_low_bps if self.total_low_bps else float("nan")

    def __str__(self) -> str:
        return (
            f"fee {self.fee_bps:.2f} + spread {self.spread_bps:.2f} + impact "
            f"[{self.impact_low_bps:.2f}, {self.impact_high_bps:.2f}] + timing "
            f"{self.timing_bps:.2f} + funding {self.funding_bps:.2f} = "
            f"[{self.total_low_bps:.2f}, {self.total_high_bps:.2f}] bps "
            f"(fee is {self.fee_share_low:.0%} of the low estimate)"
        )


@dataclass
class RoundTripCostModel:
    """Cost of one complete open-and-close, in bps of notional.

    ``entry_liquidity`` and ``exit_liquidity`` default to TAKER on both legs, and that
    default is a decision, not laziness: 90% of fills in the only real LLM-perp tape
    were taker, adverse selection on resting orders is -7.0 to -7.6 bps, and
    :mod:`bot.execution.adverse_selection` will veto a maker assumption anyway.
    Setting either to MAKER here is asserting a fill you have not earned; the veto is
    the place to earn it.
    """

    fees: FeeSchedule = field(default_factory=lambda: HOUSE_SCHEDULE)
    half_spread_bps: float = 0.0
    daily_vol_pct: float = 2.5
    timing_bps: float = 0.0
    funding_pct_per_day: float = 0.0
    entry_liquidity: LiquiditySide = LiquiditySide.TAKER
    exit_liquidity: LiquiditySide = LiquiditySide.TAKER

    def components(self, *, participation: float = 0.0, holding_days: float = 0.0) -> CostComponents:
        fee = self.fees.round_trip_bps(self.entry_liquidity, self.exit_liquidity)
        # Two legs, each crossing half the spread.
        spread = 2.0 * self.half_spread_bps
        lo, hi = impact_bracket(participation, self.daily_vol_pct)
        # Impact is paid on both legs.
        funding = self.funding_pct_per_day * 100.0 * max(0.0, holding_days)
        return CostComponents(
            fee_bps=fee,
            spread_bps=spread,
            impact_low_bps=2.0 * lo.bps,
            impact_high_bps=2.0 * hi.bps,
            timing_bps=2.0 * self.timing_bps,
            funding_bps=funding,
        )

    def total_bps(
        self, *, participation: float = 0.0, holding_days: float = 0.0, bound: Literal["low", "high"] = "high"
    ) -> float:
        """Total round-trip cost.

        ``bound`` defaults to ``"high"`` — the Toth square-root bracket — because a
        pre-trade gate that uses the optimistic end of a 10x-wide impact bracket is a
        gate that lets through exactly the trades it exists to stop.
        """
        c = self.components(participation=participation, holding_days=holding_days)
        return c.total_high_bps if bound == "high" else c.total_low_bps

    def net_edge_bps(
        self,
        expected_edge_bps: float,
        *,
        participation: float = 0.0,
        holding_days: float = 0.0,
        bound: Literal["low", "high"] = "high",
    ) -> float:
        """NightDesk gate 8 as an inequality: ``edge - fees - slippage``.

        The gate that would have blocked every losing intraday variant we ever ran, and
        the reason the throttle in :mod:`bot.execution.turnover` is described as a
        fee-control mechanism wearing a risk-control costume.
        """
        return expected_edge_bps - self.total_bps(
            participation=participation, holding_days=holding_days, bound=bound
        )

    def break_even_edge_bps(
        self, *, participation: float = 0.0, holding_days: float = 0.0, bound: Literal["low", "high"] = "high"
    ) -> float:
        """The edge at which the trade exactly pays for itself. Print this next to every Sharpe."""
        return self.total_bps(participation=participation, holding_days=holding_days, bound=bound)

    def max_round_trips_for_edge(self, annual_gross_edge_bps: float, **kw) -> float:
        """How many round trips a given annual gross edge can afford before it is gone."""
        rt = self.total_bps(**kw)
        if rt <= 0:
            return float("inf")
        return max(0.0, annual_gross_edge_bps / rt)


# ----------------------------------------------------------------------
# Break-even cost search (Auto-Quant-V2's mechanism, reimplemented — that repo has
# no licence, so nothing is copied; the bisection and the typed statuses are rebuilt
# from the described behaviour).
# ----------------------------------------------------------------------


class BreakEvenStatus:
    AVAILABLE = "available"
    GROSS_NON_POSITIVE = "gross-non-positive"
    NO_TURNOVER = "no-turnover"
    ABOVE_SEARCH_BOUND = "above-search-bound"


@dataclass(frozen=True)
class BreakEvenResult:
    """A break-even cost with a *typed status*, because "no answer" has several causes.

    ``agent-backtest-lab`` emits ``"pbo": null`` when it cannot compute a statistic,
    which is indistinguishable from "the statistic is zero" and from "we forgot to run
    it".  A first-class "the evidence does not justify a statistic" state with a
    machine-readable reason is strictly better and costs one enum.
    """

    status: str
    break_even_bps: float | None
    iterations: int
    detail: str

    def __str__(self) -> str:
        if self.break_even_bps is None:
            return f"[{self.status}] {self.detail}"
        return f"break-even at {self.break_even_bps:.3f} bps/round-trip ({self.status}, {self.iterations} iters)"


def break_even_cost_bps(
    gross_returns: "list[float] | tuple[float, ...]",
    turnover_per_period: "list[float] | tuple[float, ...]",
    *,
    max_bps: float = 200.0,
    steps: int = 80,
) -> BreakEvenResult:
    """Bisect for the per-round-trip cost at which the **compounded** net curve goes flat.

    Compounded, not summed: a strategy whose arithmetic mean return is positive can have
    a negative compounded return, and the compounded one is what the account does.

    ``gross_returns[i]`` is the period's gross fractional return; ``turnover_per_period[i]``
    is the number of round trips in that period.  Net return for a cost ``c`` bps is
    ``r_i - turnover_i * c/1e4``.
    """
    if len(gross_returns) != len(turnover_per_period):
        raise ValueError("gross_returns and turnover_per_period must be the same length")
    if not gross_returns:
        raise ValueError("empty series")

    def compounded(c_bps: float) -> float:
        acc = 1.0
        for r, t in zip(gross_returns, turnover_per_period):
            acc *= 1.0 + (r - t * c_bps / 1e4)
            if acc <= 0:
                return -1.0
        return acc - 1.0

    total_turnover = float(sum(turnover_per_period))
    if total_turnover <= 0:
        return BreakEvenResult(
            BreakEvenStatus.NO_TURNOVER,
            None,
            0,
            "no round trips: cost cannot bind, and a strategy that never trades has no "
            "execution cost to break even against",
        )
    if compounded(0.0) <= 0:
        return BreakEvenResult(
            BreakEvenStatus.GROSS_NON_POSITIVE,
            None,
            0,
            f"gross compounded return is {compounded(0.0):+.6f} at ZERO cost: there is no "
            "edge to erode, so break-even cost is not a meaningful statistic",
        )
    if compounded(max_bps) > 0:
        return BreakEvenResult(
            BreakEvenStatus.ABOVE_SEARCH_BOUND,
            None,
            0,
            f"still profitable at {max_bps:.0f} bps/round-trip; either turnover is tiny or "
            "the gross edge is implausible. Check turnover before celebrating.",
        )

    lo, hi = 0.0, max_bps
    for i in range(steps):
        mid = 0.5 * (lo + hi)
        if compounded(mid) > 0:
            lo = mid
        else:
            hi = mid
    return BreakEvenResult(
        BreakEvenStatus.AVAILABLE, 0.5 * (lo + hi), steps, "bisection on the compounded net curve"
    )


# ----------------------------------------------------------------------
# The barrier arithmetic (AFML section 15.3, in OKX units)
# ----------------------------------------------------------------------


def required_precision(barrier_pct: float, round_trip_bps: float) -> float:
    """Hit rate a symmetric +/-``barrier_pct`` bet needs to break even after costs.

    Expected P&L per trade is ``b(2p - 1) - c``; setting it to zero gives
    ``p = (c/b + 1)/2``.

    Reproduces the corpus numbers exactly: at ``round_trip_bps = 12``,
    ``barrier_pct = 0.5`` gives **0.62** and ``barrier_pct = 2.0`` gives **0.53**.
    Which is the whole meta-labelling result: the only region with an achievable
    precision is wide barriers and low turnover.
    """
    if barrier_pct <= 0:
        raise ValueError("barrier_pct must be > 0")
    b = barrier_pct / 100.0
    c = round_trip_bps / 1e4
    return (c / b + 1.0) / 2.0


def min_barrier_for_precision(precision: float, round_trip_bps: float) -> float:
    """Inverse of :func:`required_precision`: the narrowest barrier a given hit rate can carry.

    At a genuinely good 55% hit rate and 12 bps round trip, the answer is **1.2%** —
    a barrier no intraday strategy reaches, which is the same conclusion arrived at
    from the other side.
    """
    if not (0.5 < precision < 1.0):
        raise ValueError(
            "precision must be strictly between 0.5 and 1.0; at or below 0.5 no barrier "
            "width makes a symmetric bet profitable at any positive cost"
        )
    c = round_trip_bps / 1e4
    return c / (2.0 * precision - 1.0) * 100.0


def min_holding_days(
    edge_bps: float, round_trip_bps: float, funding_pct_per_day: float
) -> float:
    """Days a position must be held for its edge to outrun cost plus carry.

    Returns ``inf`` when the edge never clears the round trip, and 0 when carry is
    favourable and the edge already clears the fee.  Note the sign convention: a
    *positive* ``funding_pct_per_day`` is a cost to us.

    hummingbot's status display frames this as "days of funding to repay the round
    trip" and that framing is the right one: a hedged carry capture on our numbers
    needs **32.8 days** to pay its 24 bps two-leg round trip, against a 14-day window.
    """
    net_at_zero = edge_bps - round_trip_bps
    daily_carry_bps = funding_pct_per_day * 100.0
    if daily_carry_bps <= 0:
        # Carry pays us; the only hurdle is the round trip, met immediately or never.
        return 0.0 if net_at_zero > 0 else float("inf")
    if net_at_zero <= 0:
        return float("inf")
    # Edge is a one-off; carry accrues. The position is only worth holding while
    # cumulative carry stays below the realised edge.
    return net_at_zero / daily_carry_bps


def max_holding_days(edge_bps: float, round_trip_bps: float, funding_pct_per_day: float) -> float:
    """Alias with the honest name: carry eats the edge, so this is a DEADLINE, not a floor.

    ``min_holding_days`` is the name the framing invites and it is misleading: with an
    adverse carry the edge does not grow with time, so the number computed is the point
    at which holding longer turns a winner into a loser.  Both names are exported so
    that whichever one a caller reaches for, the docstring says what the number means.
    """
    return min_holding_days(edge_bps, round_trip_bps, funding_pct_per_day)
