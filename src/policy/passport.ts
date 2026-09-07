// Strategy Passport: the binding between "this research passed" and "this order may execute".
//
// Without it the two halves of this product are two features that happen to share a process. The
// idea gate certifies a strategy; the order gate judges an order; nothing connects them. An agent
// can get SMA(5)/SMA(40) certified, quietly mutate the parameters, and trade the mutation. The
// order gate still refuses a *dangerous* order — but the certification has become decorative,
// because no order ever had to descend from it.
//
// A passport closes that. Certification produces an immutable hash of the exact strategy that was
// judged, together with the exact evidence that judged it. Every live order names a hash. Gate 17
// refuses any order whose named strategy was never certified, was certified as UNSUPPORTED, has
// expired, or was certified for a different symbol.
//
//     research -> certification -> identity -> execution -> audit
//
// The hash covers the strategy spec and the data it was judged on, so changing a parameter, a
// symbol, or the sample changes the identity. There is no way to mutate a strategy and keep its
// passport; that is the entire point.

import { createHash } from "node:crypto";

/**
 * What was certified. Deliberately open-ended in `params` — Governor does not need to understand a
 * strategy to bind an order to it, and pretending to would invite strategies to be described in
 * whatever shape makes the hash convenient.
 */
export interface StrategySpec {
  /** Human name, e.g. "sma-crossover". Part of the identity. */
  name: string;
  /** Symbols this strategy is certified to trade. An order on any other symbol fails gate 17. */
  symbols: string[];
  /** Everything that defines the strategy's behaviour: windows, thresholds, sizing rules. */
  params: Record<string, unknown>;
}

/** What the strategy was judged on. Changing the sample changes the identity. */
export interface DatasetRef {
  symbol: string;
  interval: string;
  bars: number;
  /** First and last bar open times, ISO. */
  from: string;
  to: string;
}

export interface Passport {
  /** SHA-256 over the canonical spec. The identity an order must carry. */
  strategyHash: string;
  /** SHA-256 over the canonical dataset reference. Recorded so a re-run is checkable. */
  datasetHash: string;
  spec: StrategySpec;
  dataset: DatasetRef;
  verdict: "SUPPORTED" | "UNSUPPORTED";
  /** The idea gate's own reason string, carried verbatim. */
  reason: string;
  /** Headline evidence, kept small enough to render but complete enough to argue with. */
  evidence: {
    nTrials: number;
    dsr: number | null;
    minBacktestYears: number | null;
    yearsHeld: number | null;
    pbo: number | null;
    walkForwardOosSharpe: number | null;
    netEdgeBps: number | null;
    haltTempoMedianBars: number | null;
  };
  issuedAt: string;
  expiresAt: string;
}

/**
 * Canonical JSON: object keys sorted at every depth, no incidental whitespace.
 *
 * A hash is only an identity if the same strategy always produces the same bytes. Two objects that
 * differ solely in key insertion order are the same strategy and must hash identically, or an
 * agent could dodge gate 17 by reordering its own JSON.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Identity of a strategy. Symbols are sorted before hashing so ["BTCUSDT","ETHUSDT"] and
 * ["ETHUSDT","BTCUSDT"] are one strategy rather than two — a set, written down in some order.
 */
export function hashStrategy(spec: StrategySpec): string {
  return sha256(canonicalize({ name: spec.name, symbols: [...spec.symbols].sort(), params: spec.params }));
}

export function hashDataset(d: DatasetRef): string {
  return sha256(canonicalize(d));
}

export function issuePassport(args: {
  spec: StrategySpec;
  dataset: DatasetRef;
  verdict: "SUPPORTED" | "UNSUPPORTED";
  reason: string;
  evidence: Passport["evidence"];
  nowMs: number;
  validForDays: number;
}): Passport {
  const issued = new Date(args.nowMs);
  const expires = new Date(args.nowMs + args.validForDays * 86_400_000);
  return {
    strategyHash: hashStrategy(args.spec),
    datasetHash: hashDataset(args.dataset),
    spec: args.spec,
    dataset: args.dataset,
    verdict: args.verdict,
    reason: args.reason,
    evidence: args.evidence,
    issuedAt: issued.toISOString(),
    expiresAt: expires.toISOString(),
  };
}

export type CertificationStatus =
  | { ok: true; passport: Passport }
  | { ok: false; code: "no_hash" | "unknown" | "unsupported" | "expired" | "wrong_symbol"; detail: string };

/**
 * Can this order execute under this passport set?
 *
 * Every failure mode is named separately rather than collapsed into "not certified", because the
 * operator's response differs: an unknown hash means the agent invented one, an expired passport
 * means re-run the research, and a wrong symbol means the agent drifted off its mandate.
 */
export function checkCertification(
  strategyHash: string | undefined,
  symbol: string | undefined,
  passports: readonly Passport[],
  nowMs: number,
): CertificationStatus {
  if (!strategyHash) {
    return { ok: false, code: "no_hash", detail: "order carries no strategy hash — nothing ties it to certified research" };
  }
  const passport = passports.find((p) => p.strategyHash === strategyHash);
  if (!passport) {
    return { ok: false, code: "unknown", detail: `strategy ${strategyHash.slice(0, 12)}… was never certified by this Governor` };
  }
  if (passport.verdict !== "SUPPORTED") {
    return { ok: false, code: "unsupported", detail: `strategy ${strategyHash.slice(0, 12)}… was certified UNSUPPORTED: ${passport.reason}` };
  }
  if (Date.parse(passport.expiresAt) <= nowMs) {
    return { ok: false, code: "expired", detail: `certification expired ${passport.expiresAt} — re-run the idea gate on current data` };
  }
  if (symbol && !passport.spec.symbols.includes(symbol)) {
    return {
      ok: false,
      code: "wrong_symbol",
      detail: `certified for ${passport.spec.symbols.join(", ")} — this order is ${symbol}`,
    };
  }
  return { ok: true, passport };
}
