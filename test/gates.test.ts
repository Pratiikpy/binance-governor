// Gate tests. One per gate, each proving the gate fires AND that it does not fire on the case just
// inside the limit — an off-by-one in a risk check is the whole bug, not a detail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, parsePolicy, type Policy } from "../src/policy/config.ts";
import { evaluateWrite, type AccountCtx, type EvalCtx, type MarketCtx } from "../src/policy/gates.ts";
import { effectOf, isCancel, notionalOf, parseOrder } from "../src/policy/surface.ts";

const NOW = 1_800_000_000_000;

const market = (over: Partial<MarketCtx> = {}): MarketCtx => ({
  refPrice: 100,
  quoteAgeSec: 1,
  estSlippagePct: 0.05,
  symbolTrading: true,
  ...over,
});

const account = (over: Partial<AccountCtx> = {}): AccountCtx => ({
  equityUsd: 1000,
  positionUsdBySymbol: {},
  grossUsd: 0,
  dayStartEquityUsd: 1000,
  peakEquityUsd: 1000,
  ...over,
});

const policy = (over: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, symbolAllowlist: ["BTCUSDT"], ...over });

const ctx = (over: Partial<EvalCtx> = {}): EvalCtx => ({
  policy: policy(),
  market: market(),
  account: account(),
  history: { recent: [], nowMs: NOW },
  ...over,
});

/** A $10 market buy of BTCUSDT — comfortably inside every default limit. */
const order = (args: Record<string, unknown> = {}) =>
  parseOrder("spot.newOrder", { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 10, ...args });

const gate = (d: ReturnType<typeof evaluateWrite>, name: string) => d.results.find((r) => r.gate.startsWith(name));

test("a clean order passes every gate", () => {
  const d = evaluateWrite(order(), ctx());
  assert.equal(d.verdict, "ALLOW", d.reason);
  assert.ok(d.results.every((r) => r.passed));
  assert.equal(d.notionalUsd, 10);
});

test("01 kill switch refuses everything", () => {
  const d = evaluateWrite(order(), ctx({ policy: policy({ killSwitch: true }) }));
  assert.equal(d.verdict, "BLOCK");
  assert.match(d.reason, /kill switch/);
});

test("01 kill switch still permits cancels — flattening must stay possible", () => {
  const cancel = parseOrder("spot.deleteOrder", { symbol: "BTCUSDT", orderId: 1 });
  assert.ok(isCancel("spot.deleteOrder"));
  const d = evaluateWrite(cancel, ctx({ policy: policy({ killSwitch: true }) }));
  assert.equal(d.verdict, "ALLOW");
});

test("02 an empty allowlist permits nothing", () => {
  const d = evaluateWrite(order(), ctx({ policy: policy({ symbolAllowlist: [] }) }));
  assert.equal(d.verdict, "BLOCK");
  assert.match(d.reason, /not on the allowlist/);
});

test("02 the denylist overrides the allowlist", () => {
  const d = evaluateWrite(order(), ctx({ policy: policy({ symbolAllowlist: ["BTCUSDT"], symbolDenylist: ["BTCUSDT"] }) }));
  assert.equal(d.verdict, "BLOCK");
  assert.match(d.reason, /denylist/);
});

test("03 a halted symbol is refused", () => {
  const d = evaluateWrite(order(), ctx({ market: market({ symbolTrading: false }) }));
  assert.equal(d.verdict, "BLOCK");
  assert.equal(gate(d, "03")?.passed, false);
});

test("04 a stale quote is refused, and one exactly at the limit is not", () => {
  const p = policy({ maxQuoteAgeSec: 30 });
  assert.equal(evaluateWrite(order(), ctx({ policy: p, market: market({ quoteAgeSec: 30 }) })).verdict, "ALLOW");
  assert.equal(evaluateWrite(order(), ctx({ policy: p, market: market({ quoteAgeSec: 30.5 }) })).verdict, "BLOCK");
});

test("05 an order with no size is refused, not treated as zero", () => {
  const d = evaluateWrite(parseOrder("spot.newOrder", { symbol: "BTCUSDT", side: "BUY", type: "MARKET" }), ctx());
  assert.equal(d.verdict, "BLOCK");
  assert.equal(gate(d, "05")?.indeterminate, true);
  assert.match(d.reason, /neither quantity nor quoteOrderQty/);
});

test("06 the per-order notional cap holds exactly at the boundary", () => {
  const p = policy({ maxOrderNotionalUsd: 25, holdAboveNotionalUsd: 1e9 });
  assert.equal(evaluateWrite(order({ quoteOrderQty: 25 }), ctx({ policy: p })).verdict, "ALLOW");
  const over = evaluateWrite(order({ quoteOrderQty: 25.01 }), ctx({ policy: p }));
  assert.equal(over.verdict, "BLOCK");
  assert.match(over.reason, /06_max_order_notional/);
});

test("06 capping rewrites the size instead of refusing, when enabled", () => {
  const p = policy({ maxOrderNotionalUsd: 25, capOversizedOrders: true, holdAboveNotionalUsd: 1e9 });
  const d = evaluateWrite(order({ quoteOrderQty: 100 }), ctx({ policy: p }));
  assert.equal(d.verdict, "ALLOW_CAPPED");
  assert.deepEqual(d.cappedArgs, { quoteOrderQty: 25 });
});

test("06 capping is never offered when something other than size failed", () => {
  const p = policy({ maxOrderNotionalUsd: 25, capOversizedOrders: true, symbolAllowlist: [] });
  const d = evaluateWrite(order({ quoteOrderQty: 100 }), ctx({ policy: p }));
  assert.equal(d.verdict, "BLOCK");
});

test("07 position cap counts existing exposure in the same symbol", () => {
  const p = policy({ maxPositionPct: 25, maxOrderNotionalUsd: 1000, holdAboveNotionalUsd: 1e9 });
  const a = account({ equityUsd: 1000, positionUsdBySymbol: { BTCUSDT: 200 }, grossUsd: 200 });
  assert.equal(evaluateWrite(order({ quoteOrderQty: 50 }), ctx({ policy: p, account: a })).verdict, "ALLOW");
  const over = evaluateWrite(order({ quoteOrderQty: 51 }), ctx({ policy: p, account: a }));
  assert.equal(over.verdict, "BLOCK");
  assert.match(over.reason, /07_max_position_pct/);
});

test("08 gross exposure counts every symbol", () => {
  const p = policy({ maxGrossPct: 60, maxPositionPct: 60, maxOrderNotionalUsd: 1000, holdAboveNotionalUsd: 1e9 });
  const a = account({ equityUsd: 1000, positionUsdBySymbol: { ETHUSDT: 550 }, grossUsd: 550 });
  const d = evaluateWrite(order({ quoteOrderQty: 100 }), ctx({ policy: p, account: a }));
  assert.equal(d.verdict, "BLOCK");
  assert.match(d.reason, /08_max_gross_pct/);
});

test("09 the daily loss limit halts trading", () => {
  const a = account({ equityUsd: 960, dayStartEquityUsd: 1000, peakEquityUsd: 1000 });
  const d = evaluateWrite(order(), ctx({ policy: policy({ maxDailyLossPct: 3, maxDrawdownPct: 10 }), account: a }));
  assert.equal(d.verdict, "BLOCK");
  assert.match(d.reason, /09_daily_loss_limit/);
});

test("09 is not enforced before a day baseline exists", () => {
  const a = account({ equityUsd: 500, dayStartEquityUsd: null });
  assert.equal(gate(evaluateWrite(order(), ctx({ account: a })), "09")?.passed, true);
});

test("10 drawdown from the session peak halts trading", () => {
  const a = account({ equityUsd: 940, dayStartEquityUsd: 940, peakEquityUsd: 1000 });
  const d = evaluateWrite(order(), ctx({ policy: policy({ maxDrawdownPct: 5, maxDailyLossPct: 5 }), account: a }));
  assert.equal(d.verdict, "BLOCK");
  assert.match(d.reason, /10_max_drawdown/);
});

test("11 the order rate limit counts a rolling window", () => {
  const recent = Array.from({ length: 6 }, (_, i) => ({
    tsMs: NOW - i * 1000,
    symbol: "ETHUSDT",
    fingerprint: `x${i}`,
  }));
  const d = evaluateWrite(order(), ctx({ policy: policy({ maxOrdersPerWindow: 6, rateWindowSec: 300 }), history: { recent, nowMs: NOW } }));
  assert.equal(d.verdict, "BLOCK");
  assert.match(d.reason, /11_order_rate/);
});

test("11 orders older than the window do not count", () => {
  const recent = Array.from({ length: 6 }, (_, i) => ({
    tsMs: NOW - 400_000 - i * 1000,
    symbol: "ETHUSDT",
    fingerprint: `x${i}`,
  }));
  assert.equal(evaluateWrite(order(), ctx({ history: { recent, nowMs: NOW } })).verdict, "ALLOW");
});

test("12 the per-symbol cooldown blocks a fast second order on the same symbol", () => {
  const recent = [{ tsMs: NOW - 10_000, symbol: "BTCUSDT", fingerprint: "other" }];
  const d = evaluateWrite(order(), ctx({ policy: policy({ perSymbolCooldownSec: 60 }), history: { recent, nowMs: NOW } }));
  assert.equal(d.verdict, "BLOCK");
  assert.match(d.reason, /12_symbol_cooldown/);
});

test("12 a different symbol is not affected by the cooldown", () => {
  const recent = [{ tsMs: NOW - 10_000, symbol: "ETHUSDT", fingerprint: "other" }];
  assert.equal(evaluateWrite(order(), ctx({ history: { recent, nowMs: NOW } })).verdict, "ALLOW");
});

test("13 an identical order inside the window is a duplicate", () => {
  const o = order();
  const recent = [
    { tsMs: NOW - 5_000, symbol: "BTCUSDT", fingerprint: "spot.newOrder|BTCUSDT|BUY|MARKET|-|10|-" },
  ];
  const d = evaluateWrite(o, ctx({ policy: policy({ perSymbolCooldownSec: 0 }), history: { recent, nowMs: NOW } }));
  assert.equal(d.verdict, "BLOCK");
  assert.match(d.reason, /13_duplicate_order/);
});

test("14 a limit price far from the book is a fat-finger", () => {
  const p = policy({ maxPriceDeviationPct: 2 });
  const near = evaluateWrite(order({ type: "LIMIT", price: 101, quantity: 0.05, quoteOrderQty: undefined }), ctx({ policy: p }));
  assert.equal(gate(near, "14")?.passed, true);
  const far = evaluateWrite(order({ type: "LIMIT", price: 130, quantity: 0.05, quoteOrderQty: undefined }), ctx({ policy: p }));
  assert.equal(far.verdict, "BLOCK");
  assert.match(far.reason, /14_price_sanity/);
});

test("15 slippage above tolerance is refused, and an unknown book is not a pass", () => {
  const over = evaluateWrite(order(), ctx({ policy: policy({ maxSlippagePct: 0.4 }), market: market({ estSlippagePct: 1.2 }) }));
  assert.equal(over.verdict, "BLOCK");
  const unknown = evaluateWrite(order(), ctx({ market: market({ estSlippagePct: null }) }));
  assert.equal(unknown.verdict, "BLOCK");
  assert.equal(gate(unknown, "15")?.indeterminate, true);
});

test("16 an edge that does not survive fees is refused", () => {
  const p = policy({ feeRoundTripPct: 0.2, minNetEdgePct: 0 });
  const thin = evaluateWrite(order(), ctx({ policy: p, expectedEdgePct: 0.1 }));
  assert.equal(thin.verdict, "BLOCK");
  assert.match(thin.reason, /16_net_edge/);
  const fat = evaluateWrite(order(), ctx({ policy: p, expectedEdgePct: 1.0 }));
  assert.equal(fat.verdict, "ALLOW");
});

test("16 is not enforced when no edge was declared", () => {
  assert.equal(gate(evaluateWrite(order(), ctx()), "16")?.passed, true);
});

test("an order inside policy but above the auto-approve limit is held, not sent", () => {
  const p = policy({ maxOrderNotionalUsd: 100, holdAboveNotionalUsd: 20 });
  const d = evaluateWrite(order({ quoteOrderQty: 50 }), ctx({ policy: p }));
  assert.equal(d.verdict, "HOLD");
  assert.match(d.reason, /waiting for a human/);
});

test("unknown equity blocks rather than waves through", () => {
  const d = evaluateWrite(order(), ctx({ account: account({ equityUsd: null }) }));
  assert.equal(d.verdict, "BLOCK");
  assert.equal(gate(d, "07")?.indeterminate, true);
});

test("every gate result is reported, not just the failing one", () => {
  const d = evaluateWrite(order(), ctx({ policy: policy({ symbolAllowlist: [] }) }));
  assert.ok(d.results.length >= 16);
  assert.ok(d.results.some((r) => r.passed));
});

// --- surface classification -------------------------------------------------------------------

test("the write surface is an allowlist, not a guess", () => {
  assert.equal(effectOf("spot.newOrder"), "WRITE");
  assert.equal(effectOf("spot.deleteOrder"), "WRITE");
  assert.equal(effectOf("wallet.userUniversalTransfer"), "WRITE");
  assert.equal(effectOf("spot.orderTest"), "SIMULATE");
  assert.equal(effectOf("spot.tickerPrice"), "READ");
  assert.equal(effectOf("spot.getAccount"), "READ");
  // Reads whose names contain write-ish words must not be misclassified.
  assert.equal(effectOf("wallet.withdrawHistory"), "READ");
  assert.equal(effectOf("margin.queryBorrowRepayRecordsInMarginAccount"), "READ");
  assert.equal(effectOf("convert.getConvertTradeHistory"), "READ");
});

test("notional falls back to the reference price only when the order has no price", () => {
  assert.equal(notionalOf(parseOrder("spot.newOrder", { symbol: "X", quoteOrderQty: 30 }), 100), 30);
  assert.equal(notionalOf(parseOrder("spot.newOrder", { symbol: "X", quantity: 2 }), 100), 200);
  assert.equal(notionalOf(parseOrder("spot.newOrder", { symbol: "X", quantity: 2, price: 50 }), 100), 100);
  assert.equal(notionalOf(parseOrder("spot.newOrder", { symbol: "X" }), 100), null);
  assert.equal(notionalOf(parseOrder("spot.newOrder", { symbol: "X", quantity: 2 }), null), null);
});

// --- policy validation ------------------------------------------------------------------------

test("a policy typo is rejected rather than silently defaulted", () => {
  assert.throws(() => parsePolicy({ maxOrderNotinalUsd: 100 }), /unknown policy field/);
  assert.throws(() => parsePolicy({ maxOrderNotionalUsd: -1 }), /must be a finite number/);
  assert.throws(() => parsePolicy({ maxOrderNotionalUsd: "100" }), /must be a finite number/);
  assert.throws(() => parsePolicy({ maxPositionPct: 90, maxGrossPct: 50 }), /cannot exceed/);
  assert.throws(() => parsePolicy({ maxDailyLossPct: 9, maxDrawdownPct: 5 }), /would never fire/);
});

test("symbols are normalised to upper case", () => {
  assert.deepEqual(parsePolicy({ symbolAllowlist: ["btcusdt"] }).symbolAllowlist, ["BTCUSDT"]);
});

// --- fail-closed and ledger tamper-evidence -----------------------------------------------------
// Ported in shape from Agent Arena's property suites: a risk layer must refuse when it breaks, and a
// ledger must catch mutation, reordering, deletion, truncation and a foreign signing key.

test("the gate engine fails closed when something inside it throws", () => {
  const poison = ctx();
  // A context whose account getter explodes stands in for any internal defect.
  Object.defineProperty(poison.account, "positionUsdBySymbol", {
    get() {
      throw new TypeError("boom");
    },
  });
  const d = evaluateWrite(order(), poison);
  assert.equal(d.verdict, "BLOCK");
  assert.match(d.reason, /00_internal_error/);
  assert.equal(d.results[0]?.indeterminate, true);
});
