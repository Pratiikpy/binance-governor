// The policy: the limits the agent physically cannot exceed.
//
// This is the file a user actually edits, so it is plain JSON, every field is a number or a list of
// strings, and every field is documented. There is no expression language and nothing is evaluated
// at runtime — a policy you cannot read at a glance is a policy you cannot trust.
//
// Defaults are deliberately tight. The failure mode we care about is an agent doing something large
// and irreversible on its first run, so an unconfigured Governor is close to useless rather than
// close to unlimited, and loosening it is a decision the user makes on purpose.

import { readFileSync, existsSync } from "node:fs";

export interface Policy {
  /** Trading is refused outright while this is true. The one switch that overrides everything. */
  killSwitch: boolean;

  /** Symbols the agent may trade. Empty means nothing is tradeable — not "everything". */
  symbolAllowlist: string[];
  /** Checked after the allowlist, so a symbol can be revoked without editing the allowlist. */
  symbolDenylist: string[];

  /** Hard ceiling on a single order, in quote currency (USDT for *USDT pairs). */
  maxOrderNotionalUsd: number;
  /** Ceiling on one symbol's position as a percentage of sub-account equity. */
  maxPositionPct: number;
  /** Ceiling on total exposure across all symbols, as a percentage of equity. */
  maxGrossPct: number;

  /** Session halts when the day's realised + unrealised loss reaches this percentage of equity. */
  maxDailyLossPct: number;
  /** Session halts when equity falls this far below its high-water mark. Needs a human to clear. */
  maxDrawdownPct: number;

  /** Most exposure-increasing orders allowed in any rolling window. */
  maxOrdersPerWindow: number;
  /** Length of that window, in seconds. */
  rateWindowSec: number;
  /** Minimum gap between two exposure-increasing orders on the same symbol, in seconds. */
  perSymbolCooldownSec: number;

  /** A materially identical order inside this many seconds is treated as a duplicate and refused. */
  duplicateWindowSec: number;

  /**
   * Every live order must name a strategy that this Governor certified (gate 17).
   *
   * Default true, because it is the product's whole thesis: execution is earned by research, and a
   * certification nothing has to descend from is decoration. Turning it off leaves the other 16
   * gates fully in force — it only stops Governor asking *which* strategy an order came from.
   */
  requireCertifiedStrategy: boolean;
  /** How long a certification stays valid. Research ages; markets move. */
  certificationValidDays: number;

  // --- on-chain policy, for Binance Agentic Wallet actions ---
  /**
   * DeFi protocols the agent may enter. Empty means none — the same reading as the symbol
   * allowlist, and for the same reason: "nothing is listed" must mean "nothing is permitted",
   * never "everything is permitted".
   */
  defiProtocolAllowlist: string[];
  /** Ceiling on one protocol's share of equity. Concentration is the risk DeFi punishes hardest. */
  maxProtocolExposurePct: number;
  /** A protocol thinner than this is refused. Exit liquidity is what a position is actually worth. */
  minProtocolTvlUsd: number;
  /**
   * An advertised yield above this needs a human. Not because high yield is fraud, but because it
   * is a claim, and Binance's own DeFi reference shows protocols advertising over 6,800% — a number
   * an agent should never act on unattended.
   */
  holdAboveApyBps: number;
  /** Slippage tolerance the agent may request on-chain, in basis points. */
  maxOnChainSlippageBps: number;

  /** A limit price further than this from the live book is refused as a fat-finger. */
  maxPriceDeviationPct: number;
  /** Estimated fill slippage, walked against the live order book, above which the order is refused. */
  maxSlippagePct: number;
  /** Quotes older than this are not a basis for a decision. */
  maxQuoteAgeSec: number;

  /** Round-trip taker fee assumed when checking whether an edge survives costs. */
  feeRoundTripPct: number;
  /** Required edge AFTER fees and slippage. Only applied when the caller declares an expected edge. */
  minNetEdgePct: number;

  /**
   * Orders above this notional are held for a human instead of refused. Set at or above
   * maxOrderNotionalUsd to disable holds entirely and make every breach a refusal.
   */
  holdAboveNotionalUsd: number;

  /**
   * When true, an order that breaches only the per-order notional cap is capped to the cap and sent,
   * rather than refused. Applies to nothing else — a symbol that is not on the allowlist is never
   * "capped" onto it.
   */
  capOversizedOrders: boolean;
}

export const DEFAULT_POLICY: Policy = {
  killSwitch: false,

  symbolAllowlist: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
  symbolDenylist: [],

  maxOrderNotionalUsd: 25,
  maxPositionPct: 25,
  maxGrossPct: 60,

  maxDailyLossPct: 3,
  maxDrawdownPct: 5,

  maxOrdersPerWindow: 6,
  rateWindowSec: 300,
  perSymbolCooldownSec: 60,

  duplicateWindowSec: 45,

  requireCertifiedStrategy: true,
  certificationValidDays: 30,

  defiProtocolAllowlist: [],
  maxProtocolExposurePct: 10,
  minProtocolTvlUsd: 100_000_000,
  holdAboveApyBps: 2_000,
  maxOnChainSlippageBps: 50,

  maxPriceDeviationPct: 2,
  maxSlippagePct: 0.4,
  maxQuoteAgeSec: 30,

  feeRoundTripPct: 0.2,
  minNetEdgePct: 0,

  holdAboveNotionalUsd: 25,
  capOversizedOrders: false,
};

const NUMERIC_FIELDS: (keyof Policy)[] = [
  "maxOrderNotionalUsd",
  "maxPositionPct",
  "maxGrossPct",
  "maxDailyLossPct",
  "maxDrawdownPct",
  "maxOrdersPerWindow",
  "rateWindowSec",
  "perSymbolCooldownSec",
  "duplicateWindowSec",
  "certificationValidDays",
  "maxProtocolExposurePct",
  "minProtocolTvlUsd",
  "holdAboveApyBps",
  "maxOnChainSlippageBps",
  "maxPriceDeviationPct",
  "maxSlippagePct",
  "maxQuoteAgeSec",
  "feeRoundTripPct",
  "minNetEdgePct",
  "holdAboveNotionalUsd",
];

/**
 * Merge a partial policy over the defaults and reject anything malformed.
 *
 * Validation throws rather than falling back. A policy file with a typo silently reverting a limit
 * to its default is exactly the failure this project exists to prevent.
 */
export function parsePolicy(input: unknown): Policy {
  if (input === null || typeof input !== "object") throw new Error("policy must be a JSON object");
  const raw = input as Record<string, unknown>;

  const known = new Set(Object.keys(DEFAULT_POLICY));
  const unknownKeys = Object.keys(raw).filter((k) => !known.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(`unknown policy field(s): ${unknownKeys.join(", ")}`);
  }

  const merged: Policy = { ...DEFAULT_POLICY, ...(raw as Partial<Policy>) };

  for (const field of NUMERIC_FIELDS) {
    const v = merged[field] as unknown;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`policy.${String(field)} must be a finite number >= 0, got ${JSON.stringify(v)}`);
    }
  }
  if (typeof merged.killSwitch !== "boolean") throw new Error("policy.killSwitch must be a boolean");
  if (typeof merged.capOversizedOrders !== "boolean") throw new Error("policy.capOversizedOrders must be a boolean");
  if (typeof merged.requireCertifiedStrategy !== "boolean") throw new Error("policy.requireCertifiedStrategy must be a boolean");

  for (const field of ["symbolAllowlist", "symbolDenylist", "defiProtocolAllowlist"] as const) {
    const v = merged[field] as unknown;
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
      throw new Error(`policy.${field} must be an array of strings`);
    }
    merged[field] = (v as string[]).map((s) => s.toUpperCase());
  }

  if (merged.maxPositionPct > merged.maxGrossPct) {
    throw new Error("policy.maxPositionPct cannot exceed policy.maxGrossPct");
  }
  if (merged.maxDailyLossPct > merged.maxDrawdownPct) {
    throw new Error("policy.maxDailyLossPct cannot exceed policy.maxDrawdownPct — the daily halt would never fire");
  }
  return merged;
}

export function loadPolicy(file = "policy.json"): Policy {
  if (!existsSync(file)) return { ...DEFAULT_POLICY };
  return parsePolicy(JSON.parse(readFileSync(file, "utf8")));
}
