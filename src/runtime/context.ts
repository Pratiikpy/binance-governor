// Builds the context the gates decide on, from live Binance data.
//
// The gates themselves are pure; this is the only place that talks to the exchange on their behalf.
// Keeping the split sharp is what makes a decision replayable: the context is snapshotted into the
// ledger, so the same inputs can be re-run against a different policy later to answer "would these
// limits have stopped it?"
//
// Everything here degrades to null rather than to a guess. A gate that receives null reports itself
// indeterminate and fails, which is the correct direction — an unknown equity must never read as
// "plenty".

import type { BinanceUpstream } from "../upstream/binance-mcp.ts";
import type { AccountCtx, MarketCtx, RecentOrder } from "../policy/gates.ts";
import type { ParsedOrder } from "../policy/surface.ts";
import { notionalOf } from "../policy/surface.ts";

interface Cached<T> {
  at: number;
  value: T;
}

/** Depth levels come off the wire as ["price", "qty"] string pairs. */
type RawLevel = [string, string];

export interface DepthSnapshot {
  bids: [number, number][];
  asks: [number, number][];
  fetchedAtMs: number;
}

/**
 * Walk an order book to estimate the average fill price for a given quote-currency notional, and
 * express the shortfall against the touch as a percentage.
 *
 * Returns null when the book cannot fill the order at all — that is not zero slippage, it is an
 * unanswerable question, and the caller must treat it as such.
 */
export function estimateSlippagePct(depth: DepthSnapshot, side: "BUY" | "SELL", notionalUsd: number): number | null {
  const levels = side === "BUY" ? depth.asks : depth.bids;
  const touch = levels[0]?.[0];
  if (touch === undefined || touch <= 0 || notionalUsd <= 0) return null;

  let remaining = notionalUsd;
  let baseFilled = 0;
  for (const [price, qty] of levels) {
    if (price <= 0 || qty <= 0) continue;
    const levelNotional = price * qty;
    if (levelNotional >= remaining) {
      baseFilled += remaining / price;
      remaining = 0;
      break;
    }
    baseFilled += qty;
    remaining -= levelNotional;
  }
  if (remaining > 0 || baseFilled <= 0) return null; // book too thin to answer

  const avgPrice = notionalUsd / baseFilled;
  const slip = side === "BUY" ? (avgPrice - touch) / touch : (touch - avgPrice) / touch;
  return Math.max(0, slip * 100);
}

export class ContextBuilder {
  private priceCache = new Map<string, Cached<number>>();
  private depthCache = new Map<string, Cached<DepthSnapshot>>();
  private symbolStatus = new Map<string, Cached<boolean>>();
  private accountCache: Cached<{ equityUsd: number | null; positions: Record<string, number> }> | null = null;

  /** Session state the gates need but the exchange does not report. */
  private peakEquityUsd: number | null = null;
  private dayStartEquityUsd: number | null = null;
  private dayKey: string | null = null;
  private recent: RecentOrder[] = [];

  constructor(
    private readonly upstream: BinanceUpstream,
    private readonly priceTtlMs = 5_000,
    private readonly depthTtlMs = 5_000,
    private readonly accountTtlMs = 10_000,
  ) {}

  private fresh<T>(c: Cached<T> | undefined | null, ttl: number, now: number): T | null {
    return c && now - c.at < ttl ? c.value : null;
  }

  async price(symbol: string, nowMs = Date.now()): Promise<{ price: number | null; ageSec: number }> {
    const cached = this.priceCache.get(symbol);
    const hit = this.fresh(cached, this.priceTtlMs, nowMs);
    if (hit !== null) return { price: hit, ageSec: (nowMs - cached!.at) / 1000 };
    try {
      const res = await this.upstream.callTool("spot.tickerPrice", { symbol });
      const p = Number((res.data as { price?: string })?.price);
      if (!Number.isFinite(p) || p <= 0) return { price: null, ageSec: Infinity };
      this.priceCache.set(symbol, { at: nowMs, value: p });
      return { price: p, ageSec: 0 };
    } catch {
      return { price: null, ageSec: Infinity };
    }
  }

  async depth(symbol: string, nowMs = Date.now()): Promise<DepthSnapshot | null> {
    const hit = this.fresh(this.depthCache.get(symbol), this.depthTtlMs, nowMs);
    if (hit) return hit;
    try {
      const res = await this.upstream.callTool("spot.depth", { symbol, limit: 100 });
      const raw = res.data as { bids?: RawLevel[]; asks?: RawLevel[] } | undefined;
      const toLevels = (ls: RawLevel[] | undefined): [number, number][] =>
        (ls ?? []).map(([p, q]) => [Number(p), Number(q)] as [number, number]).filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q));
      const snap: DepthSnapshot = { bids: toLevels(raw?.bids), asks: toLevels(raw?.asks), fetchedAtMs: nowMs };
      if (snap.bids.length === 0 && snap.asks.length === 0) return null;
      this.depthCache.set(symbol, { at: nowMs, value: snap });
      return snap;
    } catch {
      return null;
    }
  }

  /** Whether Binance currently lists the symbol as TRADING. Cached for a minute; it rarely changes. */
  async isTrading(symbol: string, nowMs = Date.now()): Promise<boolean | null> {
    const hit = this.fresh(this.symbolStatus.get(symbol), 60_000, nowMs);
    if (hit !== null) return hit;
    try {
      const res = await this.upstream.callTool("spot.exchangeInfo", { symbol });
      const info = res.data as { symbols?: { symbol: string; status: string }[] } | undefined;
      const entry = info?.symbols?.find((s) => s.symbol === symbol);
      if (!entry) return null;
      const trading = entry.status === "TRADING";
      this.symbolStatus.set(symbol, { at: nowMs, value: trading });
      return trading;
    } catch {
      return null;
    }
  }

  /**
   * Equity and per-symbol exposure for the Agentic sub-account.
   *
   * Spot "position" means the value of a held base asset against its USDT pair. A free USDT balance
   * is equity but not exposure, which is why the two are accumulated separately.
   */
  async account(nowMs = Date.now()): Promise<AccountCtx> {
    const cached = this.fresh(this.accountCache, this.accountTtlMs, nowMs);
    let snapshot = cached;
    if (!snapshot) {
      snapshot = await this.fetchAccount(nowMs);
      this.accountCache = { at: nowMs, value: snapshot };
    }

    const equity = snapshot.equityUsd;
    if (equity !== null) {
      const today = new Date(nowMs).toISOString().slice(0, 10);
      if (this.dayKey !== today) {
        this.dayKey = today;
        this.dayStartEquityUsd = equity;
      }
      this.peakEquityUsd = this.peakEquityUsd === null ? equity : Math.max(this.peakEquityUsd, equity);
    }

    const gross = Object.values(snapshot.positions).reduce((a, b) => a + b, 0);
    return {
      equityUsd: equity,
      positionUsdBySymbol: snapshot.positions,
      grossUsd: gross,
      dayStartEquityUsd: this.dayStartEquityUsd,
      peakEquityUsd: this.peakEquityUsd,
    };
  }

  private async fetchAccount(nowMs: number): Promise<{ equityUsd: number | null; positions: Record<string, number> }> {
    let balances: { asset: string; free: string; locked: string }[];
    try {
      const res = await this.upstream.callTool("spot.getAccount", {});
      balances = (res.data as { balances?: { asset: string; free: string; locked: string }[] })?.balances ?? [];
    } catch {
      return { equityUsd: null, positions: {} };
    }

    const positions: Record<string, number> = {};
    let equity = 0;
    for (const b of balances) {
      const qty = Number(b.free) + Number(b.locked);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      if (b.asset === "USDT") {
        equity += qty;
        continue;
      }
      const symbol = `${b.asset}USDT`;
      const { price } = await this.price(symbol, nowMs);
      if (price === null) continue; // no USDT pair, or unpriceable — excluded rather than guessed at
      const value = qty * price;
      positions[symbol] = (positions[symbol] ?? 0) + value;
      equity += value;
    }
    return { equityUsd: equity, positions };
  }

  /** Full market context for one order, including a slippage estimate sized to that order. */
  async market(order: ParsedOrder, nowMs = Date.now()): Promise<MarketCtx> {
    const [{ price, ageSec }, trading] = await Promise.all([this.price(order.symbol, nowMs), this.isTrading(order.symbol, nowMs)]);

    let estSlippagePct: number | null = null;
    const notional = notionalOf(order, price);
    if (notional !== null && order.side !== null) {
      const book = await this.depth(order.symbol, nowMs);
      if (book) estSlippagePct = estimateSlippagePct(book, order.side, notional);
    }

    return { refPrice: price, quoteAgeSec: ageSec, estSlippagePct, symbolTrading: trading };
  }

  /** Orders the gates should count for rate, cooldown and duplicate checks. */
  history(nowMs = Date.now()): { recent: readonly RecentOrder[]; nowMs: number } {
    return { recent: this.recent, nowMs };
  }

  /** Record an order the Governor actually sent. Only sent orders count against the limits. */
  noteSent(o: RecentOrder): void {
    this.recent.push(o);
    if (this.recent.length > 500) this.recent = this.recent.slice(-500);
    this.accountCache = null; // position and equity just changed
  }

  /** Drop cached balances so the next decision re-reads the account. */
  invalidateAccount(): void {
    this.accountCache = null;
  }
}
