// Exposure caps must count orders that have been SENT but have not yet settled.
//
// The gates read gross exposure off the exchange balance, and a balance only knows about what has
// settled. Between sending an order and seeing it land, that order is invisible to the very cap
// meant to bound it — so a run of orders can each pass a 60% gross check and add up to 100%. Each
// one is judged against a world in which the previous ones had not happened.
//
// The per-symbol cooldown hides this for a single symbol, which is what makes it easy to miss: the
// obvious test — fire the same symbol repeatedly — passes. Ten different symbols walk straight
// through, because the cooldown is per-symbol and the rate limit is generous enough to allow a
// burst. That is why these tests deliberately disable cooldown and rate limiting: the point is to
// put the exposure gate alone under load, not to confirm that some other gate catches it first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger/ledger.ts";
import { ContextBuilder } from "../src/runtime/context.ts";
import { Governor } from "../src/runtime/governor.ts";
import { BinanceUpstream } from "../src/upstream/binance-mcp.ts";
import { DEFAULT_POLICY, type Policy } from "../src/policy/config.ts";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT"];

/**
 * An upstream whose balances never move, and whose orders rest at NEW rather than filling.
 *
 * That is the whole scenario: orders accepted by the venue whose effect has not reached the balance
 * the gates read. A fixture that filled instantly would quietly re-introduce the settled exposure
 * the bug depends on being absent.
 */
function unsettlingUpstream(): BinanceUpstream {
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; params?: { name?: string; arguments?: Record<string, unknown> } };
    const name = body.params?.name;
    const text = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }], isError: false });
    let result: unknown = text({});
    if (name === "spot.tickerPrice") result = text({ symbol: "BTCUSDT", price: "100.00" });
    else if (name === "spot.getAccount") result = text({ balances: [{ asset: "USDT", free: "1000", locked: "0" }] });
    else if (name === "spot.exchangeInfo") result = text({ symbols: [{ symbol: String(body.params?.arguments?.["symbol"]), status: "TRADING" }] });
    else if (name === "spot.depth") {
      result = text({
        bids: Array.from({ length: 50 }, (_, i) => [String(100 - i * 0.01), "100"]),
        asks: Array.from({ length: 50 }, (_, i) => [String(100 + i * 0.01), "100"]),
      });
    } else if (name === "spot.newOrder" || name === "spot.orderTest") result = text({ status: "NEW", orderId: 1 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return new BinanceUpstream({ token: "inflight-test", fetchImpl });
}

/** Cooldown and rate limiting off, so the exposure gate is the only thing under test. */
const POLICY: Policy = {
  ...DEFAULT_POLICY,
  symbolAllowlist: SYMBOLS,
  requireCertifiedStrategy: false,
  maxOrderNotionalUsd: 100,
  holdAboveNotionalUsd: 1e9,
  perSymbolCooldownSec: 0,
  maxOrdersPerWindow: 1000,
  maxPositionPct: 100,
};

function withGovernor(fn: (g: Governor, ctx: ContextBuilder) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "inflight-"));
    try {
      const upstream = unsettlingUpstream();
      const ctx = new ContextBuilder(upstream);
      await fn(new Governor({ upstream, policy: POLICY, ledger: new Ledger(dir), context: ctx }), ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "a burst of unsettled orders cannot exceed the gross exposure cap",
  withGovernor(async (governor) => {
    // $1,000 equity at a 60% gross cap is $600 of room. Ten $100 orders would be $1,000.
    let allowed = 0;
    for (const symbol of SYMBOLS) {
      const out = await governor.call("spot.newOrder", { symbol, side: "BUY", type: "MARKET", quoteOrderQty: 100 });
      if (!out.isError) allowed++;
    }
    const capUsd = (POLICY.maxGrossPct / 100) * 1000;
    assert.ok(
      allowed * 100 <= capUsd,
      `in-flight exposure ${allowed * 100} exceeded the ${capUsd} cap — orders already sent are not being counted`,
    );
    assert.equal(allowed, capUsd / 100, "the cap should be reached exactly, not undershot");
  }),
);

test(
  "reserved notional is visible as in-flight exposure",
  withGovernor(async (governor, ctx) => {
    assert.equal(ctx.inFlightUsd, 0, "nothing is in flight before anything is sent");
    await governor.call("spot.newOrder", { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 100 });
    assert.equal(ctx.inFlightUsd, 100, "a sent order that has not settled must hold its notional");
    const account = await ctx.account();
    assert.equal(account.grossUsd, 100, "gross exposure must include the unsettled order");
    assert.equal(account.positionUsdBySymbol["BTCUSDT"], 100);
  }),
);

test(
  "an order that is refused reserves nothing",
  withGovernor(async (governor, ctx) => {
    // Reserving on a refusal would let a blocked agent exhaust its own budget by being blocked,
    // turning every gate into a denial-of-service against the operator.
    const out = await governor.call("spot.newOrder", { symbol: "NOTLISTEDUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 100 });
    assert.equal(out.isError, true);
    assert.equal(ctx.inFlightUsd, 0);
  }),
);

test(
  "an unconfirmed outcome keeps its reservation",
  withGovernor(async (governor, ctx) => {
    // The fixture rests every order at NEW, so the read-back can never settle the question. Not
    // knowing is not the same as knowing it did not happen: releasing here would free budget for an
    // order that may well be live, which is precisely the fail-open direction this layer exists to
    // avoid. This assertion is the one that would break if someone "tidied up" the release list.
    await governor.call("spot.newOrder", { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 100 });
    assert.equal(ctx.inFlightUsd, 100, "a PENDING or UNCONFIRMED order must go on consuming budget");
  }),
);

test(
  "releasing a reservation returns the budget",
  withGovernor(async (_governor, ctx) => {
    ctx.reserve("a", "BTCUSDT", 250);
    assert.equal(ctx.inFlightUsd, 250);
    ctx.release("a");
    assert.equal(ctx.inFlightUsd, 0, "a settled order's hold must be returned, or the account slowly starves");
    ctx.release("a"); // releasing twice is not an error and must not go negative
    assert.equal(ctx.inFlightUsd, 0);
  }),
);
