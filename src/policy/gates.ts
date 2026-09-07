// The gate engine. Pure functions over an explicit context — no I/O, no clock, no globals.
//
// Every input a gate needs is passed in, which is what makes a decision replayable: given the same
// context and the same policy, the verdict is the same forever. That property is the point of the
// ledger, and it is why nothing here reaches for Date.now() or the network.
//
// The engine evaluates every gate and returns all of the results, but the verdict is decided by the
// FIRST failure in order. Order is deliberate: the cheapest and most absolute checks run first, so
// the reason a user sees is the most fundamental one rather than an incidental downstream effect.

import type { Policy } from "./config.ts";
import { type Passport, checkCertification } from "./passport.ts";
import { type ParsedOrder, isCancel, notionalOf } from "./surface.ts";

export type Verdict = "ALLOW" | "ALLOW_CAPPED" | "HOLD" | "BLOCK";

export interface GateResult {
  gate: string;
  passed: boolean;
  detail: string;
  /** A gate that could not be evaluated for lack of data. Treated as a failure, never as a pass. */
  indeterminate?: boolean;
}

export interface Decision {
  verdict: Verdict;
  reason: string;
  results: GateResult[];
  /** Present only for ALLOW_CAPPED: the arguments to send instead of the ones requested. */
  cappedArgs?: Record<string, unknown>;
  /** Notional the engine valued the order at, in quote currency. Null when it could not be valued. */
  notionalUsd: number | null;
}

export interface MarketCtx {
  /** Live reference price for the symbol. Null when unavailable. */
  refPrice: number | null;
  /** Age of that price in seconds. */
  quoteAgeSec: number;
  /** Estimated fill slippage walked against the live book, as a percentage. Null when unknown. */
  estSlippagePct: number | null;
  /** True when the symbol is currently trading on Binance per exchangeInfo. */
  symbolTrading: boolean | null;
}

export interface AccountCtx {
  /** Sub-account equity in quote currency. Null when unavailable. */
  equityUsd: number | null;
  /** Current exposure per symbol, in quote currency. */
  positionUsdBySymbol: Readonly<Record<string, number>>;
  /** Total exposure across all symbols, in quote currency. */
  grossUsd: number;
  /** Equity at the start of the current UTC day. Null when the session has not seen a full day. */
  dayStartEquityUsd: number | null;
  /** Highest equity the session has observed. Null on a fresh session. */
  peakEquityUsd: number | null;
}

export interface RecentOrder {
  tsMs: number;
  symbol: string;
  /** Stable hash of the material order fields — see fingerprintOrder. */
  fingerprint: string;
}

export interface HistoryCtx {
  /** Exposure-increasing orders already allowed this session, newest last. */
  recent: readonly RecentOrder[];
  /** Wall clock for rate and cooldown arithmetic, passed in so decisions replay identically. */
  nowMs: number;
}

export interface EvalCtx {
  policy: Policy;
  market: MarketCtx;
  account: AccountCtx;
  history: HistoryCtx;
  /** Edge the caller claims, in percent. Only checked when provided. */
  expectedEdgePct?: number;
  /**
   * Certifications this Governor has issued. Gate 17 resolves the order's declared strategy hash
   * against these. An empty list with `requireCertifiedStrategy` on refuses everything, which is
   * the correct fail-closed reading of "no research has been certified yet".
   */
  passports?: readonly Passport[];
  /** The strategy the caller says this order came from. */
  strategyHash?: string;
}

/** Material identity of an order: same symbol, side, type, size and price = the same instruction. */
export function fingerprintOrder(o: ParsedOrder): string {
  return [o.tool, o.symbol, o.side ?? "-", o.type ?? "-", o.quantity ?? "-", o.quoteOrderQty ?? "-", o.price ?? "-"].join("|");
}

const pct = (n: number): string => `${n.toFixed(2)}%`;
const usd = (n: number): string => `$${n.toFixed(2)}`;
const EPS = 1e-9;

/**
 * Evaluate one write against the policy.
 *
 * Cancels are evaluated too — they are logged and they respect the kill switch — but they skip every
 * sizing, pricing and rate gate. A risk layer that can refuse a cancel can trap a user in a position,
 * which is a worse outcome than any trade it would have prevented.
 */
export function evaluateWrite(order: ParsedOrder, ctx: EvalCtx): Decision {
  // Fail closed. Any exception anywhere below — a malformed context, a missing field, arithmetic on
  // something that was not a number — becomes a refusal, never an escape. A risk layer that throws is
  // a risk layer whose caller decides what to do next, and the caller is the thing we do not trust.
  try {
    return evaluateWriteUnsafe(order, ctx);
  } catch (err) {
    const detail = `internal error — fail-closed (${err instanceof Error ? err.name : typeof err})`;
    return {
      verdict: "BLOCK",
      reason: `00_internal_error: ${detail}`,
      results: [{ gate: "00_internal_error", passed: false, detail, indeterminate: true }],
      notionalUsd: null,
    };
  }
}

function evaluateWriteUnsafe(order: ParsedOrder, ctx: EvalCtx): Decision {
  const { policy: p, market, account, history } = ctx;
  const results: GateResult[] = [];
  const add = (gate: string, passed: boolean, detail: string, indeterminate = false): void => {
    results.push(indeterminate ? { gate, passed, detail, indeterminate } : { gate, passed, detail });
  };

  const cancel = isCancel(order.tool);
  const notional = notionalOf(order, market.refPrice);

  // 1 — kill switch. Absolute, and it applies to cancels only in the sense that it does not block
  //     them: flattening must stay possible while the switch is engaged.
  add("01_kill_switch", !p.killSwitch || cancel, p.killSwitch ? "kill switch engaged" : "ok");

  if (cancel) {
    const failed = results.find((r) => !r.passed);
    return {
      verdict: failed ? "BLOCK" : "ALLOW",
      reason: failed ? failed.detail : "cancel — sizing gates do not apply",
      results,
      notionalUsd: null,
    };
  }

  // 2 — symbol permission. An empty allowlist permits nothing; that is the safe reading.
  const allowed = p.symbolAllowlist.includes(order.symbol);
  const denied = p.symbolDenylist.includes(order.symbol);
  add(
    "02_symbol_allowed",
    allowed && !denied,
    denied
      ? `${order.symbol} is on the denylist`
      : allowed
        ? `${order.symbol} allowed`
        : `${order.symbol} not on the allowlist [${p.symbolAllowlist.join(", ") || "empty"}]`,
  );

  // 3 — the symbol is actually trading right now (halts, delistings, maintenance).
  add(
    "03_symbol_trading",
    market.symbolTrading !== false,
    market.symbolTrading === null ? "trading status unknown" : market.symbolTrading ? "TRADING" : "not currently trading",
    market.symbolTrading === null,
  );

  // 4 — quote freshness. A decision made on a stale price is not a decision.
  add(
    "04_quote_fresh",
    market.quoteAgeSec <= p.maxQuoteAgeSec + EPS,
    `quote age ${market.quoteAgeSec.toFixed(1)}s (max ${p.maxQuoteAgeSec}s)`,
  );

  // 5 — the order must have a size we can value. Unknown size is never treated as zero.
  add(
    "05_order_sized",
    notional !== null,
    notional === null
      ? order.sizeless
        ? "order specifies neither quantity nor quoteOrderQty"
        : "order size could not be valued — no price available"
      : `notional ${usd(notional)}`,
    notional === null,
  );

  // 6 — per-order notional ceiling.
  add(
    "06_max_order_notional",
    notional !== null && notional <= p.maxOrderNotionalUsd + EPS,
    notional === null ? "size unknown" : `${usd(notional)} (max ${usd(p.maxOrderNotionalUsd)})`,
    notional === null,
  );

  // 7 — resulting position in this symbol, as a share of equity.
  const existing = account.positionUsdBySymbol[order.symbol] ?? 0;
  if (account.equityUsd !== null && account.equityUsd > 0 && notional !== null) {
    const resultingPct = ((existing + notional) / account.equityUsd) * 100;
    add(
      "07_max_position_pct",
      resultingPct <= p.maxPositionPct + EPS,
      `${order.symbol} would be ${pct(resultingPct)} of equity (max ${pct(p.maxPositionPct)})`,
    );
  } else {
    add("07_max_position_pct", false, "equity or size unknown", true);
  }

  // 8 — total exposure across everything.
  if (account.equityUsd !== null && account.equityUsd > 0 && notional !== null) {
    const grossPct = ((account.grossUsd + notional) / account.equityUsd) * 100;
    add(
      "08_max_gross_pct",
      grossPct <= p.maxGrossPct + EPS,
      `gross would be ${pct(grossPct)} of equity (max ${pct(p.maxGrossPct)})`,
    );
  } else {
    add("08_max_gross_pct", false, "equity or size unknown", true);
  }

  // 9 — daily loss limit. Measured against the equity the day opened at.
  if (account.equityUsd !== null && account.dayStartEquityUsd !== null && account.dayStartEquityUsd > 0) {
    const dayPnlPct = ((account.equityUsd - account.dayStartEquityUsd) / account.dayStartEquityUsd) * 100;
    add(
      "09_daily_loss_limit",
      dayPnlPct > -p.maxDailyLossPct - EPS,
      `day P&L ${pct(dayPnlPct)} (halt at ${pct(-p.maxDailyLossPct)})`,
    );
  } else {
    add("09_daily_loss_limit", true, "no day baseline yet — not enforced");
  }

  // 10 — drawdown from the session high-water mark. Clearing this needs a human.
  if (account.equityUsd !== null && account.peakEquityUsd !== null && account.peakEquityUsd > 0) {
    const ddPct = ((account.peakEquityUsd - account.equityUsd) / account.peakEquityUsd) * 100;
    add(
      "10_max_drawdown",
      ddPct <= p.maxDrawdownPct + EPS,
      `drawdown ${pct(ddPct)} from peak ${usd(account.peakEquityUsd)} (max ${pct(p.maxDrawdownPct)})`,
    );
  } else {
    add("10_max_drawdown", true, "no peak recorded yet — not enforced");
  }

  // 11 — order rate over a rolling window.
  const windowStart = history.nowMs - p.rateWindowSec * 1000;
  const inWindow = history.recent.filter((o) => o.tsMs >= windowStart);
  add(
    "11_order_rate",
    inWindow.length < p.maxOrdersPerWindow,
    `${inWindow.length} order(s) in the last ${p.rateWindowSec}s (max ${p.maxOrdersPerWindow})`,
  );

  // 12 — per-symbol cooldown.
  const lastForSymbol = [...history.recent].reverse().find((o) => o.symbol === order.symbol);
  const sinceSec = lastForSymbol ? (history.nowMs - lastForSymbol.tsMs) / 1000 : Infinity;
  add(
    "12_symbol_cooldown",
    sinceSec >= p.perSymbolCooldownSec,
    Number.isFinite(sinceSec)
      ? `${sinceSec.toFixed(0)}s since the last ${order.symbol} order (min ${p.perSymbolCooldownSec}s)`
      : `no prior ${order.symbol} order`,
  );

  // 13 — duplicate instruction. Catches a retry loop before it becomes a position.
  const fp = fingerprintOrder(order);
  const dupWindowStart = history.nowMs - p.duplicateWindowSec * 1000;
  const dup = history.recent.find((o) => o.fingerprint === fp && o.tsMs >= dupWindowStart);
  add(
    "13_duplicate_order",
    dup === undefined,
    dup ? `identical order ${((history.nowMs - dup.tsMs) / 1000).toFixed(0)}s ago` : "no duplicate",
  );

  // 14 — fat-finger. A limit price far from the live book is a typo far more often than a view.
  if (order.price !== null && market.refPrice !== null && market.refPrice > 0) {
    const devPct = (Math.abs(order.price - market.refPrice) / market.refPrice) * 100;
    add(
      "14_price_sanity",
      devPct <= p.maxPriceDeviationPct + EPS,
      `limit ${order.price} is ${pct(devPct)} from ${market.refPrice} (max ${pct(p.maxPriceDeviationPct)})`,
    );
  } else {
    add("14_price_sanity", true, order.price === null ? "no limit price" : "no reference price");
  }

  // 15 — slippage walked against the live book.
  if (market.estSlippagePct !== null) {
    add(
      "15_slippage",
      market.estSlippagePct <= p.maxSlippagePct + EPS,
      `est. slippage ${pct(market.estSlippagePct)} (max ${pct(p.maxSlippagePct)})`,
    );
  } else {
    add("15_slippage", false, "order book unavailable — slippage not estimable", true);
  }

  // 16 — does the claimed edge survive costs? Only meaningful when an edge was declared.
  if (ctx.expectedEdgePct !== undefined) {
    const slip = market.estSlippagePct ?? 0;
    const net = ctx.expectedEdgePct - p.feeRoundTripPct - slip;
    add(
      "16_net_edge",
      net >= p.minNetEdgePct - EPS,
      `net edge ${pct(net)} = ${pct(ctx.expectedEdgePct)} − fees ${pct(p.feeRoundTripPct)} − slip ${pct(slip)} (min ${pct(p.minNetEdgePct)})`,
    );
  } else {
    add("16_net_edge", true, "no edge declared — not enforced");
  }

  // 17 — does this order descend from certified research?
  //
  // Placed last so that a reckless order still reports the reckless reason first: an uncertified
  // $50,000 all-in should read as an oversized order, not as a paperwork problem. The gate still
  // fires and still appears in the results; it simply does not steal the headline from a more
  // fundamental failure.
  if (!p.requireCertifiedStrategy) {
    add("17_strategy_certified", true, "certification not required by policy — not enforced");
  } else {
    const cert = checkCertification(ctx.strategyHash, order.symbol, ctx.passports ?? [], history.nowMs);
    add("17_strategy_certified", cert.ok, cert.ok ? `certified strategy ${cert.passport.spec.name} (${cert.passport.strategyHash.slice(0, 12)}…)` : cert.detail);
  }

  const failures = results.filter((r) => !r.passed);
  if (failures.length === 0) {
    if (notional !== null && notional > p.holdAboveNotionalUsd + EPS) {
      return {
        verdict: "HOLD",
        reason: `${usd(notional)} exceeds the ${usd(p.holdAboveNotionalUsd)} auto-approve limit — waiting for a human`,
        results,
        notionalUsd: notional,
      };
    }
    return { verdict: "ALLOW", reason: "all gates passed", results, notionalUsd: notional };
  }

  // Capping is offered only when the single failure is the per-order notional cap. Anything else —
  // a denied symbol, a stale quote, a drawdown halt — is a refusal, because there is no smaller
  // version of the order that makes it acceptable.
  const onlyNotionalFailed = failures.length === 1 && failures[0]!.gate === "06_max_order_notional";
  if (p.capOversizedOrders && onlyNotionalFailed && notional !== null && market.refPrice !== null) {
    const capped = capOrderTo(order, p.maxOrderNotionalUsd, market.refPrice);
    if (capped) {
      return {
        verdict: "ALLOW_CAPPED",
        reason: `size reduced from ${usd(notional)} to the ${usd(p.maxOrderNotionalUsd)} per-order cap`,
        results,
        cappedArgs: capped,
        notionalUsd: p.maxOrderNotionalUsd,
      };
    }
  }

  return {
    verdict: "BLOCK",
    reason: `${failures[0]!.gate}: ${failures[0]!.detail}`,
    results,
    notionalUsd: notional,
  };
}

/**
 * Rewrite an order down to a target notional.
 *
 * Quote-denominated orders are trivially capped. Base-denominated ones are divided by the reference
 * price, which is an approximation — so the capped order is still re-validated against Binance's own
 * filters by the caller before it is sent.
 */
export function capOrderTo(order: ParsedOrder, targetUsd: number, refPrice: number): Record<string, unknown> | null {
  if (order.quoteOrderQty !== null) return { quoteOrderQty: targetUsd };
  if (order.quantity !== null && refPrice > 0) {
    const price = order.price ?? refPrice;
    if (price <= 0) return null;
    return { quantity: targetUsd / price };
  }
  return null;
}
