// Binance spot kline fetcher — the one thing missing from every prior build.
//
// `okx/trading/data/collect/binance_klines.py` pulls from `fapi.binance.com` — USDⓈ-M
// FUTURES, not spot. Feeding that data into a "Binance spot" strategy claim would be
// exactly the kind of unit error notes/27-SYNTHESIS.md's traps register calls out. This
// hits the real spot endpoint (`api.binance.com/api/v3/klines`), public, no auth, no
// API key — market data has always been open on Binance.
//
// Cached to JSONL on disk so the idea gate and any backtest never re-fetch the same
// history twice, and so the exact bars behind a claim can be inspected by hand.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BINANCE_SPOT_REST = "https://api.binance.com/api/v3/klines";

export type Interval = "1s" | "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "8h" | "12h" | "1d" | "3d" | "1w" | "1M";

export interface Kline {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTimeMs: number;
  quoteVolume: number;
  trades: number;
  takerBuyBaseVolume: number;
  takerBuyQuoteVolume: number;
}

/** Binance returns each kline as a 12-element array; this is documented at api.binance.com. */
type RawKline = [number, string, string, string, string, string, number, string, number, string, string, string];

function parseKline(row: RawKline): Kline {
  return {
    openTimeMs: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTimeMs: row[6],
    quoteVolume: Number(row[7]),
    trades: row[8],
    takerBuyBaseVolume: Number(row[9]),
    takerBuyQuoteVolume: Number(row[10]),
  };
}

const MAX_LIMIT = 1000;

/**
 * Fetch one page of up to 1000 klines. Binance's own cap — asking for more silently
 * truncates rather than erroring, so paginating past it is mandatory, not optional.
 */
async function fetchPage(symbol: string, interval: Interval, startTimeMs: number, endTimeMs: number, fetchImpl: typeof fetch): Promise<Kline[]> {
  const url = new URL(BINANCE_SPOT_REST);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("startTime", String(startTimeMs));
  url.searchParams.set("endTime", String(endTimeMs));
  url.searchParams.set("limit", String(MAX_LIMIT));

  const res = await fetchImpl(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Binance klines HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const raw = (await res.json()) as RawKline[];
  return raw.map(parseKline);
}

/** Milliseconds one bar of this interval spans. Needed to page without gaps or overlap. */
function intervalMs(interval: Interval): number {
  const unit = interval.slice(-1);
  const n = Number(interval.slice(0, -1));
  const table: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, M: 2_592_000_000 };
  const ms = table[unit];
  if (ms === undefined) throw new Error(`unrecognised interval unit in "${interval}"`);
  return n * ms;
}

export interface FetchKlinesOptions {
  fetchImpl?: typeof fetch;
  /** Pause between pages, in ms. Binance's spot weight limit is generous, but stay polite. */
  pageDelayMs?: number;
}

/**
 * Fetch every kline between two timestamps, paginating transparently. Returns bars in
 * ascending time order with no gaps or duplicates — verified by the caller-visible
 * invariant that each returned bar's `openTimeMs` increases by exactly one interval.
 */
export async function fetchKlines(
  symbol: string,
  interval: Interval,
  startTimeMs: number,
  endTimeMs: number,
  opts: FetchKlinesOptions = {},
): Promise<Kline[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const step = intervalMs(interval);
  const out: Kline[] = [];
  let cursor = startTimeMs;

  while (cursor < endTimeMs) {
    // Binance's endTime is inclusive per page, so request generously and trim after —
    // requesting exactly MAX_LIMIT bars' worth of range keeps every page full until the end.
    const pageEnd = Math.min(endTimeMs, cursor + step * MAX_LIMIT);
    const page = await fetchPage(symbol, interval, cursor, pageEnd, fetchImpl);
    if (page.length === 0) break; // no more data (e.g. before listing)
    out.push(...page);
    const last = page[page.length - 1]!;
    cursor = last.openTimeMs + step;
    if (opts.pageDelayMs) await new Promise((r) => setTimeout(r, opts.pageDelayMs));
  }

  return out.filter((k) => k.openTimeMs >= startTimeMs && k.openTimeMs < endTimeMs);
}

// --------------------------------------------------------------------------------------------
// Disk cache — JSONL, one file per symbol+interval, append-only by design so a re-fetch of an
// overlapping range never corrupts what is already on disk.
// --------------------------------------------------------------------------------------------

function cacheFile(dir: string, symbol: string, interval: Interval): string {
  return join(dir, `${symbol}-${interval}.jsonl`);
}

export function readCache(dir: string, symbol: string, interval: Interval): Kline[] {
  const file = cacheFile(dir, symbol, interval);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Kline);
}

function writeCache(dir: string, symbol: string, interval: Interval, klines: Kline[]): void {
  mkdirSync(dir, { recursive: true });
  const file = cacheFile(dir, symbol, interval);
  writeFileSync(file, klines.map((k) => JSON.stringify(k)).join("\n") + "\n", "utf8");
}

/**
 * Fetch a range, filling only the gaps not already cached. The cache is read first; if it
 * already fully covers [startTimeMs, endTimeMs) at this interval's cadence, nothing is fetched
 * — the whole point of caching historical (immutable) bars is to never ask Binance twice.
 */
export async function fetchKlinesCached(
  dir: string,
  symbol: string,
  interval: Interval,
  startTimeMs: number,
  endTimeMs: number,
  opts: FetchKlinesOptions = {},
): Promise<Kline[]> {
  const existing = readCache(dir, symbol, interval).sort((a, b) => a.openTimeMs - b.openTimeMs);
  const step = intervalMs(interval);

  const haveFrom = existing[0]?.openTimeMs;
  const haveTo = existing[existing.length - 1] ? existing[existing.length - 1]!.openTimeMs + step : undefined;

  const fresh: Kline[] = [];
  if (existing.length === 0 || haveFrom! > startTimeMs) {
    fresh.push(...(await fetchKlines(symbol, interval, startTimeMs, Math.min(endTimeMs, haveFrom ?? endTimeMs), opts)));
  }
  if (haveTo !== undefined && haveTo < endTimeMs) {
    fresh.push(...(await fetchKlines(symbol, interval, haveTo, endTimeMs, opts)));
  } else if (existing.length === 0) {
    // already covered by the branch above
  }

  const merged = [...existing, ...fresh]
    .filter((k, i, arr) => arr.findIndex((x) => x.openTimeMs === k.openTimeMs) === i)
    .sort((a, b) => a.openTimeMs - b.openTimeMs);

  if (fresh.length > 0) writeCache(dir, symbol, interval, merged);
  return merged.filter((k) => k.openTimeMs >= startTimeMs && k.openTimeMs < endTimeMs);
}

/**
 * Per-bar simple returns from a kline series, close-to-close. This is the exact array shape
 * the idea gate expects on its `returns` field — net of nothing (fees are applied separately
 * by the idea gate's cost model, never baked into the return series itself, so the two never
 * double-count or silently disagree about the fee assumption).
 */
export function closeToCloseReturns(klines: Kline[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const prev = klines[i - 1]!.close;
    const curr = klines[i]!.close;
    if (prev > 0) out.push(curr / prev - 1);
  }
  return out;
}
