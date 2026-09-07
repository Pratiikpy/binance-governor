// The write surface: which upstream tools can move money, and how to read an order out of one.
//
// The Governor's whole guarantee rests on this file being right. A tool classified READ passes
// through untouched; a tool classified WRITE cannot reach Binance until every gate has approved it.
// So the classification is an explicit allowlist of names, never a heuristic on the string — a
// regex that guesses wrong in the permissive direction is a hole, and "delete" appearing in a
// read-only history endpoint would be a false positive that breaks a legitimate call.
//
// Names verified against a live tools/list + tool_search enumeration on 2026-09-05.
//
// Unknown tools fail CLOSED. Anything absent from that enumeration is classified WRITE, not READ,
// and refused by gate 18 — see catalogue.ts for why that direction is the only safe one.

import { VERIFIED_TOOLS } from "./catalogue.ts";

export type Effect = "READ" | "WRITE" | "SIMULATE";

/**
 * Tools that place, change or cancel an order, or move funds.
 *
 * `spot.orderTest` and `spot.sorOrderTest` are deliberately NOT here. They run Binance's full order
 * validation — symbol status, lot size, min notional, tick size, permissions — and return without
 * executing. They are the Governor's pre-flight check, so they must stay callable while a write is
 * still being decided.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  // Spot orders
  "spot.newOrder",
  "spot.sorOrder",
  "spot.deleteOrder",
  "spot.deleteOpenOrders",
  "spot.deleteOrderList",
  "spot.orderCancelReplace",
  "spot.orderAmendKeepPriority",
  // Spot order lists (OCO / OTO / OPO families)
  "spot.orderOco",
  "spot.orderListOco",
  "spot.orderListOto",
  "spot.orderListOtoco",
  "spot.orderListOpo",
  "spot.orderListOpoco",
  // Convert — a quote acceptance is a trade
  "convert.sendQuoteRequest",
  "convert.acceptQuote",
  "convert.placeLimitOrder",
  "convert.cancelLimitOrder",
  // Wallet
  "wallet.userUniversalTransfer",
]);

/** Order-validation tools: real exchange rules, no execution. Allowed to run pre-decision. */
export const SIMULATE_TOOLS: ReadonlySet<string> = new Set(["spot.orderTest", "spot.sorOrderTest"]);

/**
 * The subset of writes that CREATE exposure, as opposed to reducing or rearranging it.
 *
 * Cancels are deliberately excluded everywhere it matters. A risk layer that can block a cancel is
 * a risk layer that can trap a user in a position, which is worse than the trade it prevented — so
 * cancels are logged and audited like everything else, but they are never refused on size, edge or
 * drawdown grounds.
 */
export const EXPOSURE_INCREASING: ReadonlySet<string> = new Set([
  "spot.newOrder",
  "spot.sorOrder",
  "spot.orderCancelReplace",
  "spot.orderOco",
  "spot.orderListOco",
  "spot.orderListOto",
  "spot.orderListOtoco",
  "spot.orderListOpo",
  "spot.orderListOpoco",
  "convert.acceptQuote",
]);

/**
 * Classify a tool.
 *
 * The default is WRITE, not READ. An unrecognised name is the dangerous case — a product whose
 * scope was granted after this catalogue was enumerated, or a tool Binance added since — and
 * answering READ for it would let it through the Governor untouched. Gate 18 then refuses it,
 * because Governor cannot parse an order it has never seen and must not forward one it cannot judge.
 */
export function effectOf(tool: string): Effect {
  if (WRITE_TOOLS.has(tool)) return "WRITE";
  if (SIMULATE_TOOLS.has(tool)) return "SIMULATE";
  if (VERIFIED_TOOLS.has(tool) || tool.startsWith("governor.")) return "READ";
  return "WRITE";
}

/** Has this tool been enumerated and classified, or is it new to us? */
export function isKnownTool(tool: string): boolean {
  return VERIFIED_TOOLS.has(tool) || WRITE_TOOLS.has(tool) || SIMULATE_TOOLS.has(tool) || tool.startsWith("governor.");
}

export function isCancel(tool: string): boolean {
  return WRITE_TOOLS.has(tool) && !EXPOSURE_INCREASING.has(tool);
}

export type OrderSide = "BUY" | "SELL";

/** A spot order, normalised out of whatever shape the caller used. */
export interface ParsedOrder {
  tool: string;
  symbol: string;
  side: OrderSide | null;
  /** Binance order type: MARKET, LIMIT, STOP_LOSS_LIMIT, … */
  type: string | null;
  /** Base-asset quantity, when the caller specified one. */
  quantity: number | null;
  /** Quote-asset amount, when the caller used quoteOrderQty instead (market buys usually do). */
  quoteOrderQty: number | null;
  /** Limit price, when present. */
  price: number | null;
  stopPrice: number | null;
  timeInForce: string | null;
  /** True when the caller gave neither a quantity nor a quote amount — nothing to size. */
  sizeless: boolean;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.toUpperCase() : null;
}

export function parseOrder(tool: string, args: Record<string, unknown>): ParsedOrder {
  const side = str(args["side"]);
  const quantity = num(args["quantity"]);
  const quoteOrderQty = num(args["quoteOrderQty"]) ?? num(args["quoteQty"]);
  return {
    tool,
    symbol: str(args["symbol"]) ?? "",
    side: side === "BUY" || side === "SELL" ? side : null,
    type: str(args["type"]),
    quantity,
    quoteOrderQty,
    price: num(args["price"]),
    stopPrice: num(args["stopPrice"]),
    timeInForce: str(args["timeInForce"]),
    sizeless: quantity === null && quoteOrderQty === null,
  };
}

/**
 * Notional value of an order in quote currency (USDT for a *USDT pair).
 *
 * `refPrice` is the live mark used when the caller sized in base units, or when a market order
 * carries no price of its own. Returns null when the order cannot be valued — the caller must treat
 * that as "unknown", never as "zero", because a gate that reads an unknown size as zero waves
 * everything through.
 */
export function notionalOf(order: ParsedOrder, refPrice: number | null): number | null {
  if (order.quoteOrderQty !== null) return order.quoteOrderQty;
  if (order.quantity === null) return null;
  const price = order.price ?? refPrice;
  if (price === null || price <= 0) return null;
  return order.quantity * price;
}
