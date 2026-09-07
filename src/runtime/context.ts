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

  /**
   * Halt state the gates need and the exchange does not report.
   *
   * These are recovered from the signed ledger on startup — see `seedFromLedger`. Holding them only
   * in memory was a fail-open in a fail-closed system: gates 09 and 10 halt on the day's opening
   * equity and the running high-water mark, and a process that forgets both on restart re-baselines
   * to the *current*, already-lower equity. Down 2.9% and blocked, restarting made it 0% and
   * allowed. That gives a stuck agent — or an impatient operator — a one-command way out of the two
   * halts that exist precisely to stop a losing session from continuing.
   */
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

  /**
   * Recover the halt baselines from prior ledger records.
   *
   * Every record snapshots the equity the gates saw and the two baselines they judged against, so
   * the chain is already a complete history of both. Reading them back is what makes the halts
   * survive a restart, and deriving them from the *signed* chain rather than from a sidecar counter
   * means lowering a baseline requires forging a hash, which `Ledger.verify()` names the record for.
   *
   * Both recoveries are deliberately one-directional:
   *
   *   - The day baseline takes the EARLIEST value seen today. A restart appends later records, so
   *     nothing written after the fact can lower it.
   *   - The peak takes the MAXIMUM over the window, of both the observed equity and the peak each
   *     record was already judged against. Carrying the recorded peak forward as well as the
   *     observed equity keeps the high-water mark monotone across days and across gaps where a
   *     record has no equity of its own.
   *
   * Records whose equity is null contribute nothing rather than resetting anything — an unreadable
   * account is not evidence of a new high or a new day.
   */
  seedFromLedger(records: readonly { ts?: string; context?: unknown }[], nowMs = Date.now()): void {
    const today = new Date(nowMs).toISOString().slice(0, 10);
    let dayStart: number | null = null;
    let peak: number | null = null;

    for (const r of records) {
      const account = (r.context as { account?: Record<string, unknown> } | undefined)?.account;
      if (!account) continue;
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const equity = num(account.equityUsd);
      const recordedPeak = num(account.peakEquityUsd);
      const recordedDayStart = num(account.dayStartEquityUsd);

      for (const candidate of [equity, recordedPeak]) {
        if (candidate !== null) peak = peak === null ? candidate : Math.max(peak, candidate);
      }

      // Only today's records establish today's opening equity, and only the first one that carries a
      // usable figure — hence the `=== null` guard rather than a min or a last-write-wins.
      if (dayStart === null && typeof r.ts === "string" && r.ts.slice(0, 10) === today) {
        dayStart = recordedDayStart ?? equity;
      }
    }

    if (dayStart !== null) {
      this.dayStartEquityUsd = dayStart;
      this.dayKey = today; // stops the next account() read from re-baselining to current equity
    }
    if (peak !== null) {
      this.peakEquityUsd = this.peakEquityUsd === null ? peak : Math.max(this.peakEquityUsd, peak);
    }
  }

  /** What the halt baselines were recovered as. Exposed so the console can show they survived. */
  get haltBaselines(): { dayStartEquityUsd: number | null; peakEquityUsd: number | null } {
    return { dayStartEquityUsd: this.dayStartEquityUsd, peakEquityUsd: this.peakEquityUsd };
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
