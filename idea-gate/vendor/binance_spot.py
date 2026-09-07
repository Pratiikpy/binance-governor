"""The one fee schedule missing from the vendored corpus: Binance spot.

Every schedule shipped in ``fees.py`` is perp-calibrated — ``HOUSE_SCHEDULE`` (2/6
bps), ``BINANCE_PERP_VIP0`` (2/5 bps), the ``OKX_PERP_VIP*`` ladder. Feeding any of
them into the idea gate for a Binance SPOT strategy understates the round-trip cost
by roughly half. This is the one addition VOUCH makes to the vendored cost stack,
kept in its own file so nothing upstream is edited.

Read live from this account via ``spot.getAccount`` on 2026-09-05:
``commissionRates: {maker: "0.00100000", taker: "0.00100000"}`` — 10 bps each,
20 bps round trip. No VIP discount, no BNB fee-burn discount applied.
"""

from __future__ import annotations

from fees import FeeSchedule

#: This account's actual live commission rates. Verified against `spot.getAccount`,
#: not assumed from a rate card — VIP tier and any BNB discount change this number.
BINANCE_SPOT_VIP0 = FeeSchedule(maker_bps=10.0, taker_bps=10.0, name="binance-spot-vip0")
