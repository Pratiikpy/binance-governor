// Trial accounting: how many strategies were really tried before this one looked good.
//
// The Deflated Sharpe Ratio is the single most load-bearing number the idea gate produces, and it
// takes one input the caller supplies about itself: how many configurations were searched. Deflation
// is entirely driven by that count. Search 200 and report 1 and the correction all but vanishes —
// the statistic does not merely weaken, it inverts, certifying the luckiest draw of a wide sweep as
// though it were a single honest hypothesis.
//
// Governor was accepting that number on trust: `nTrials: req.nTrials ?? 1`. An agent sweeping two
// hundred parameter sets by calling evaluateIdea two hundred times, each declaring one trial, would
// have had every one of them deflated for a search of size one. Nothing was lying — each individual
// call was true — and the guarantee was gone anyway. That is selection bias arriving through the
// front door, and it is exactly the failure the DSR exists to correct for.
//
// It does not have to be taken on trust, because Governor already writes every certification into a
// signed, hash-chained ledger. The true size of the search is therefore a fact about the ledger, not
// a claim by the caller: count the distinct strategies this Governor has been asked to judge over
// the same data, and deflate against that.
//
//   effective trials = max(declared by caller, observed in the ledger)
//
// The max, never the ledger alone. A caller that honestly swept seventy-one configurations inside
// its own process and declared 71 must keep the benefit of that honesty even though Governor only
// ever saw one call. The observed count is a floor on the truth, not a replacement for it.
//
// Deliberately not solved here: a caller can sweep in a second process, against a second Governor,
// or on its own machine, and present only the survivor. No ledger can see a search it was never
// shown. What this closes is the case where Governor itself was the search tool — which is the case
// that matters, because the tool that makes sweeping easy is the tool that makes it happen.

import type { LedgerRecord } from "../ledger/ledger.ts";
import { canonicalize } from "./passport.ts";

export interface TrialCount {
  /** What the caller said its search size was. Null when it said nothing. */
  declared: number | null;
  /** Distinct strategies this Governor has been asked to judge over the same data. */
  observed: number;
  /** What the idea gate should actually deflate against. */
  effective: number;
  /**
   * True when the ledger knows the search was wider than the caller declared. Surfaced rather than
   * silently corrected: an agent that learns its under-count was noticed can fix its reporting, and
   * a reviewer reading the record can see that the correction was applied and why.
   */
  understated: boolean;
  detail: string;
}

/**
 * What makes two evaluations part of one search.
 *
 * A trial is only a trial relative to a family: fifty configurations of a moving-average rule on
 * BTCUSDT hourly bars are one search, while a funding-carry idea on a different instrument is a
 * different question and deflating one by the other's count would be superstition rather than
 * statistics.
 *
 * The family key is therefore the DATA, not the strategy — the symbols and the sample the strategies
 * were judged on. Keying it on the strategy name instead would be trivially defeatable by renaming
 * the strategy on each pass, which is precisely the behaviour this is meant to catch.
 */
export function familyKey(symbols: readonly string[], datasetHashOrRef: string): string {
  return canonicalize({ symbols: [...symbols].map((s) => s.toUpperCase()).sort(), data: datasetHashOrRef });
}

interface CertifyRecord {
  strategyHash: string;
  family: string;
}

/**
 * Read every certification this Governor has issued out of the ledger.
 *
 * Only CERTIFY records are considered, and only ones carrying a passport — a record whose shape is
 * unrecognised is skipped rather than guessed at, and skipping can only ever lower the observed
 * count, which keeps this side of the correction conservative.
 */
function certificationsFrom(records: readonly LedgerRecord[]): CertifyRecord[] {
  const out: CertifyRecord[] = [];
  for (const r of records) {
    if (r.effect !== "CERTIFY") continue;
    const passport = (r.context as { passport?: { strategyHash?: unknown; spec?: { symbols?: unknown }; datasetHash?: unknown } } | undefined)?.passport;
    if (!passport || typeof passport.strategyHash !== "string" || typeof passport.datasetHash !== "string") continue;
    const symbols = Array.isArray(passport.spec?.symbols) ? (passport.spec.symbols as unknown[]).filter((s): s is string => typeof s === "string") : [];
    out.push({ strategyHash: passport.strategyHash, family: familyKey(symbols, passport.datasetHash) });
  }
  return out;
}

/**
 * How many trials the idea gate should really deflate against.
 *
 * `candidateHash` is the strategy about to be judged. It is counted whether or not the ledger has
 * seen it before: a search of one is still a search of one, and a re-evaluation of an already-judged
 * strategy must not inflate the count, which is why the set is keyed by hash rather than counted by
 * record.
 */
export function trialCount(args: {
  records: readonly LedgerRecord[];
  candidateHash: string;
  symbols: readonly string[];
  datasetHash: string;
  declared: number | null;
}): TrialCount {
  const family = familyKey(args.symbols, args.datasetHash);
  const seen = new Set<string>([args.candidateHash]);
  for (const c of certificationsFrom(args.records)) {
    if (c.family === family) seen.add(c.strategyHash);
  }

  const observed = seen.size;
  const declared = args.declared !== null && Number.isFinite(args.declared) && args.declared >= 1 ? Math.floor(args.declared) : null;
  const effective = Math.max(declared ?? 1, observed);
  const understated = declared !== null && observed > declared;

  let detail: string;
  if (understated) {
    detail =
      `the caller declared ${declared} trial(s), but this Governor has judged ${observed} distinct strategies over the same data — ` +
      `deflating against ${effective}. Reporting a search as smaller than it was is what turns a Deflated Sharpe back into an undeflated one.`;
  } else if (declared === null) {
    detail = `no trial count was declared; the ledger has seen ${observed} distinct strategies over this data, so ${effective} is used.`;
  } else {
    detail = `the caller declared ${declared} trial(s) and the ledger has seen ${observed} over the same data — deflating against ${effective}.`;
  }

  return { declared, observed, effective, understated, detail };
}
