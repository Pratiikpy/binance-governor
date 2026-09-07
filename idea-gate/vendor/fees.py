"""Venue fees, and the one design rule that makes a maker lie impossible to tell.

WHY THIS MODULE EXISTS
----------------------
Our own measurements say the round-trip taker cost (0.12%) exceeds every effect we
were able to measure on the panel: intraday edge ~0.00%, overnight drift ~0.10%.
The fee is therefore not a correction applied at the end of a backtest — it is the
largest single term in the P&L and it has to be modelled first, exactly, and
pessimistically.

Three structural decisions are baked in here, each taken from a source that paid
for it with a real defect:

1.  ``LiquiditySide`` is assigned by whatever *simulates or reports* the fill, never
    asserted by the strategy.  hftbacktest (MIT, ``models/fee.rs:66-74`` with
    ``order.maker`` set at ``nopartialfillexchange.rs:178-183``) makes this a bool the
    exchange owns; lfest-rs goes further and makes ``Fee<Maker>`` and ``Fee<Taker>``
    incompatible *types*.  Python has no such type wall, so we approximate it: the
    only way to obtain a MAKER fee from this module is to hand it a fill whose
    ``liquidity`` field was produced by a fill model, and :class:`FeeSchedule` refuses
    outright to price :attr:`LiquiditySide.UNKNOWN` unless you explicitly opt into the
    conservative resolution.  LEAN's unknown-liquidity path silently resolves to
    *maker*, which is the flattering direction and is how a maker assumption sneaks
    into a report nobody audited.

2.  The default schedule charges ``max(maker, taker)`` on **both** sides.  Three lines,
    lifted in spirit from freqtrade ``optimize/backtesting.py:280-281``, whose log line
    reads "worst case fee from exchange (lowest tier)".  Contrast the field: octobot
    defaults to 0 (and guards the TAKER assignment with the MAKER key), superalgos is
    a silent 0 for fees *and* slippage, jesse has one scalar with no maker/taker
    concept at all, hummingbot's backtester defaults to 2 bps/side against a real 5-6,
    and hftbacktest's Python ``BacktestAsset()`` silently defaults to zero fee *and*
    zero latency.

3.  Every cost number is reported at 0x, 1x and 2x in the same artefact
    (Auto-Quant-V2 ``portfolio_explorer.py:3655``; no licence on that repo, so the
    mechanism is reimplemented here, not copied).  A result that only survives at 1x
    is a result that dies on a fee-schedule change.

WHAT THE NUMBERS ARE, AND WHERE THEY COME FROM
----------------------------------------------
``OKX_PERP_VIP0`` (2.0 / 5.0 bps) is the schedule hummingbot's OKX perpetual connector
carries as ``DEFAULT_FEES`` (``okx_perpetual_utils.py:11-13``).  It is a *venue list
price*, it does not know your VIP tier, and hummingbot never calls
``/api/v5/account/trade-fee`` to find out.

``HOUSE_TAKER_BPS = 6.0`` is our own working figure — the one every design decision in
this repository is anchored to — giving the 12 bps round trip that dominates our
measured effects.  It is deliberately 1 bp/side worse than the venue list price,
because the list price is what you pay when nothing goes wrong.

Neither is a substitute for reading your actual fee tier off the account. Use
:meth:`FeeSchedule.from_account` the moment you have live credentials, and treat these
constants as the pessimistic prior you fall back to.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, replace
from typing import Iterable, Mapping, Sequence

__all__ = [
    "LiquiditySide",
    "FeeSchedule",
    "Fill",
    "FeeReport",
    "OKX_PERP_VIP0",
    "OKX_PERP_VIP1",
    "OKX_PERP_VIP2",
    "OKX_PERP_VIP3",
    "OKX_PERP_VIP4",
    "OKX_PERP_VIP5",
    "BINANCE_PERP_VIP0",
    "HOUSE_TAKER_BPS",
    "HOUSE_MAKER_BPS",
    "HOUSE_SCHEDULE",
    "cost_multiple_sweep",
]


class LiquiditySide(enum.Enum):
    """Which side of the book a fill actually took.

    ``UNKNOWN`` is a first-class state on purpose.  A fill whose liquidity side we
    cannot establish is not a maker fill and is not a taker fill; it is a fill whose
    cost we do not know, and the only honest defaults are "charge taker" (conservative)
    or "refuse to price it" (strict).  Both are available; neither is silent.
    """

    MAKER = "maker"
    TAKER = "taker"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Fill:
    """One execution, as the venue or the fill model reports it.

    ``liquidity`` must be produced by whatever matched the order.  Nothing in this
    package will ever set it to MAKER on your behalf: a strategy that wants a maker
    fill has to be handed one by a fill model that decided it earned one, and the only
    fill model in this package that can do that (:mod:`bot.execution.queue_model`)
    refuses to run on the data we actually hold.
    """

    symbol: str
    side: str  # "buy" | "sell"
    price: float
    qty: float  # base units, always positive
    liquidity: LiquiditySide
    ts: float | None = None  # epoch seconds
    fee_paid_quote: float | None = None  # venue-reported, when we have it

    @property
    def notional(self) -> float:
        return abs(self.price * self.qty)

    @property
    def signed_qty(self) -> float:
        return abs(self.qty) if self.side.lower() == "buy" else -abs(self.qty)


@dataclass(frozen=True)
class FeeSchedule:
    """A venue fee schedule in basis points of notional.

    Positive is a charge; a negative ``maker_bps`` is a rebate and is supported, but
    read the warning: every shipped hftbacktest example uses ``maker = -0.00005``,
    a Binance/Bybit market-maker-programme rebate.  Copying that config into an OKX
    study moves the per-side maker cost by 2.5 bps and flips the sign of every
    spread-capture result.  We do not qualify for any rebate programme.
    """

    maker_bps: float
    taker_bps: float
    name: str = "unnamed"
    #: Multiplier applied to both legs, so a single knob can express "what if fees
    #: doubled".  Used by :func:`cost_multiple_sweep`; 1.0 is the real schedule.
    cost_multiple: float = 1.0

    def __post_init__(self) -> None:
        if self.taker_bps < 0:
            raise ValueError(
                f"taker_bps={self.taker_bps} is negative. No venue we can reach pays "
                "you to cross the spread; this is almost certainly a units error."
            )
        if self.cost_multiple < 0:
            raise ValueError("cost_multiple must be >= 0")

    # ------------------------------------------------------------------
    # construction
    # ------------------------------------------------------------------

    @classmethod
    def conservative(cls, maker_bps: float, taker_bps: float, name: str = "conservative") -> "FeeSchedule":
        """freqtrade's rule: charge ``max(maker, taker)`` on both sides.

        WHY: a backtest does not know which side of the book it took, and every engine
        that guesses guesses in its own favour.  Collapsing both rates to the worse of
        the two removes the guess entirely, at the price of overstating cost for a
        strategy that genuinely rests orders.  Given that our whole conclusion is
        "budget taker", overstating maker cost costs us nothing we wanted.
        """
        worst = max(maker_bps, taker_bps)
        return cls(maker_bps=worst, taker_bps=worst, name=name)

    @classmethod
    def from_account(cls, maker_rate: float, taker_rate: float, name: str = "account") -> "FeeSchedule":
        """Build from the venue's own ``/api/v5/account/trade-fee`` response.

        OKX reports these as negative *decimal* fractions (a charge is negative), so
        we take the absolute value and convert to bps.  Note the sign convention trap:
        hummingbot negates the venue's number when reconciling a realised fill
        (``okx_perpetual_derivative.py:468``) precisely because of this.
        """
        return cls(maker_bps=abs(maker_rate) * 1e4, taker_bps=abs(taker_rate) * 1e4, name=name)

    def scaled(self, multiple: float) -> "FeeSchedule":
        """Return the same schedule at ``multiple`` x cost, for the 0x/1x/2x sweep."""
        return replace(self, cost_multiple=multiple, name=f"{self.name}@{multiple:g}x")

    # ------------------------------------------------------------------
    # pricing
    # ------------------------------------------------------------------

    def rate_bps(self, liquidity: LiquiditySide, *, on_unknown: str = "taker") -> float:
        """bps charged for one side of one fill.

        ``on_unknown`` decides what an UNKNOWN liquidity side costs:
          - ``"taker"``  — the conservative resolution, and the default.
          - ``"raise"``  — refuse.  Use this in a research pipeline where an unknown
            side means the fill model has a hole in it and you want to find the hole.
          - ``"maker"``  — **not offered.**  LEAN does this silently and it is the
            single most flattering default in the corpus.
        """
        if liquidity is LiquiditySide.MAKER:
            base = self.maker_bps
        elif liquidity is LiquiditySide.TAKER:
            base = self.taker_bps
        else:
            if on_unknown == "raise":
                raise ValueError(
                    "Liquidity side is UNKNOWN. Refusing to price it. Either the fill "
                    "model must decide, or pass on_unknown='taker' to charge the "
                    "conservative rate explicitly."
                )
            if on_unknown != "taker":
                raise ValueError(
                    f"on_unknown={on_unknown!r} is not allowed. The only permitted "
                    "resolutions are 'taker' (conservative) and 'raise' (strict). "
                    "Resolving an unknown side to 'maker' is how a maker assumption "
                    "enters a report unnoticed."
                )
            base = self.taker_bps
        return base * self.cost_multiple

    def fee_quote(self, fill: Fill, *, on_unknown: str = "taker", prefer_reported: bool = True) -> float:
        """Cost of one fill in quote currency.

        WHY ``prefer_reported``: hummingbot keeps two fee paths and the distinction
        matters — the *estimate* (a static schedule, used for pre-trade sizing and the
        budget check) and the *realised* number the venue puts on the fill.  Every
        barrier decision should run on the realised number; only pre-trade sizing may
        use the estimate.  When ``fill.fee_paid_quote`` is present it is the truth and
        we use it.
        """
        if prefer_reported and fill.fee_paid_quote is not None:
            return abs(fill.fee_paid_quote) * self.cost_multiple
        return fill.notional * self.rate_bps(fill.liquidity, on_unknown=on_unknown) / 1e4

    def round_trip_bps(
        self,
        entry: LiquiditySide = LiquiditySide.TAKER,
        exit_: LiquiditySide = LiquiditySide.TAKER,
        *,
        on_unknown: str = "taker",
    ) -> float:
        """Total fee, in bps of notional, to open and close one position."""
        return self.rate_bps(entry, on_unknown=on_unknown) + self.rate_bps(exit_, on_unknown=on_unknown)

    def total_fee_quote(
        self, fills: Iterable[Fill], *, on_unknown: str = "taker", prefer_reported: bool = True
    ) -> float:
        return sum(self.fee_quote(f, on_unknown=on_unknown, prefer_reported=prefer_reported) for f in fills)

    def describe(self) -> str:
        return (
            f"{self.name}: maker {self.maker_bps * self.cost_multiple:.3f} bps, "
            f"taker {self.taker_bps * self.cost_multiple:.3f} bps, "
            f"taker round trip {self.round_trip_bps():.3f} bps"
        )


@dataclass(frozen=True)
class FeeReport:
    """The 0x / 1x / 2x artefact.

    Auto-Quant-V2's habit, reimplemented: print every result at zero cost, real cost
    and double cost side by side.  A gross number with no zero-cost twin hides whether
    the strategy ever had an edge; a real-cost number with no double-cost twin hides
    how close to the cliff it is.
    """

    zero: float
    real: float
    double: float
    units: str = "bps"

    @property
    def survives_double(self) -> bool:
        return self.double > 0

    @property
    def cost_sensitivity(self) -> float:
        """How much of the gross result the real fee consumes, in [0, inf).

        1.0 means the fee ate exactly the whole gross edge.  Above 1.0 the strategy is
        a fee-transfer mechanism.
        """
        if self.zero == 0:
            return float("inf")
        return (self.zero - self.real) / abs(self.zero)

    def __str__(self) -> str:
        return (
            f"0x={self.zero:.4f} 1x={self.real:.4f} 2x={self.double:.4f} {self.units} "
            f"(fee eats {self.cost_sensitivity * 100:.1f}% of gross; "
            f"{'survives' if self.survives_double else 'DIES'} at 2x)"
        )


def cost_multiple_sweep(gross_bps: float, round_trips: float, schedule: FeeSchedule) -> FeeReport:
    """Net edge at 0x, 1x and 2x the fee schedule.

    ``gross_bps`` is the pre-cost edge over the whole evaluation window;
    ``round_trips`` is how many complete open+close cycles produced it.  The product
    ``round_trips * round_trip_bps`` is the fee bill, and it is linear in turnover —
    which is the entire argument for the throttle in :mod:`bot.execution.turnover`.
    """
    rt = schedule.scaled(1.0).round_trip_bps()
    return FeeReport(
        zero=gross_bps,
        real=gross_bps - round_trips * rt,
        double=gross_bps - round_trips * rt * 2.0,
    )


# ----------------------------------------------------------------------
# Venue schedules.
#
# OKX perpetual (linear USDT-margined) public tiers, taker/maker in bps of notional.
# VIP0 matches the DEFAULT_FEES constant in hummingbot's OKX perpetual connector
# (okx_perpetual_utils.py:11-13). The higher tiers are the published ladder; they are
# recorded so a tier change is a one-line edit rather than a scattered constant hunt,
# and they are NOT verified against a live account here. Read the tier off the account
# before you rely on any of them.
# ----------------------------------------------------------------------

OKX_PERP_VIP0 = FeeSchedule(maker_bps=2.0, taker_bps=5.0, name="okx-perp-vip0")
OKX_PERP_VIP1 = FeeSchedule(maker_bps=1.8, taker_bps=4.5, name="okx-perp-vip1")
OKX_PERP_VIP2 = FeeSchedule(maker_bps=1.6, taker_bps=4.0, name="okx-perp-vip2")
OKX_PERP_VIP3 = FeeSchedule(maker_bps=1.4, taker_bps=3.5, name="okx-perp-vip3")
OKX_PERP_VIP4 = FeeSchedule(maker_bps=1.2, taker_bps=3.0, name="okx-perp-vip4")
OKX_PERP_VIP5 = FeeSchedule(maker_bps=1.0, taker_bps=2.5, name="okx-perp-vip5")

BINANCE_PERP_VIP0 = FeeSchedule(maker_bps=2.0, taker_bps=5.0, name="binance-perp-vip0")

#: Our working figures. Every design decision in this repository is anchored to a
#: 12 bps taker round trip; that is where "turnover is the enemy" comes from.
HOUSE_TAKER_BPS = 6.0
HOUSE_MAKER_BPS = 2.0
HOUSE_SCHEDULE = FeeSchedule(
    maker_bps=HOUSE_MAKER_BPS, taker_bps=HOUSE_TAKER_BPS, name="house-working"
)


def schedule_table(schedules: Sequence[FeeSchedule]) -> Mapping[str, float]:
    """Round-trip taker cost of each schedule, for a one-glance comparison."""
    return {s.name: s.round_trip_bps() for s in schedules}
