// The narration screen: what the agent is allowed to SAY it did.
//
// Every gate before this one governs what reaches Binance. None of them govern what reaches the
// human. That is a real gap, and it is the half a user actually experiences: an agent whose order
// was refused can still turn around and write "Bought $500 of BTC at 80,000" — no order, no fill, no
// record, and nothing in this system contradicting it. The money was safe and the user was still
// misled.
//
// So the same discipline the order path uses is applied to language. A sentence is checked against
// the signed ledger the way an order is checked against the policy, and it fails closed: a number
// that cannot be traced to a record is refused rather than assumed to be a rounding of something.
//
// Five things are refused:
//
//   1. A number the ledger cannot vouch for.
//   2. A claim of execution that no CONFIRMED record supports.
//   3. A forecast — Governor never predicts a price and neither may anything speaking for it.
//   4. Advice — "you should buy" is not a summary, and this is not a licensed adviser.
//   5. A refusal that happened and went unmentioned.
//
// The fifth is the one that matters most and the one a naive validator never has. Screening only
// what IS said catches invention; it does not catch omission, and omission is how an honest-looking
// summary misleads. "I reviewed the market and took no action today" is every word true and
// materially false when the truth is that five orders were refused for breaching the loss halt.
//
// Refusing without replacing would be useless, so every refusal returns `deterministicSummary` — a
// paragraph built only from ledger records, with no model in the loop. There is always something
// correct to say.
//
// The honest boundary, stated here because it belongs next to the code and not only in the README:
// an agent's chat output does not pass through this proxy, so Governor cannot intercept a sentence
// it is never shown. What this gives is a way for an agent, a wrapper, or a human reviewer to check
// narration against the record, and a correct alternative to use instead. It raises lying from free
// to detectable. It does not make it impossible.

import type { LedgerRecord } from "../ledger/ledger.ts";

export type ViolationCode =
  | "ungrounded_number"
  | "unsupported_execution_claim"
  | "forecast"
  | "advice"
  | "false_certainty"
  | "refusal_suppressed";

export interface Violation {
  code: ViolationCode;
  /** The exact span of text that failed, so the caller can see what to change. */
  quote: string;
  detail: string;
}

export type NarrationVerdict =
  | { ok: true; text: string; groundedNumbers: number[] }
  | { ok: false; violations: Violation[]; replacement: string };

/**
 * Everything the ledger can vouch for, distilled from records.
 *
 * Built rather than passed so a caller cannot widen its own evidence set — the point of grounding is
 * that the evidence comes from the signed chain, and an evidence bag the narrator supplies itself
 * would ground any number it liked.
 */
export interface Evidence {
  /** Every quantity that appears anywhere in the records, plus counts derived from them. */
  values: number[];
  /** Actions the ledger says genuinely executed: CONFIRMED or STATE_VERIFIED. */
  confirmed: LedgerRecord[];
  /** Actions that were refused outright. */
  blocked: LedgerRecord[];
  /** Actions that were sent but whose outcome Governor could not establish. */
  unconfirmed: LedgerRecord[];
}

/** Lifecycle states in which a past-tense claim of execution is true. */
const EXECUTED_STATES = new Set(["CONFIRMED", "STATE_VERIFIED"]);
/** Lifecycle states in which something was sent but the outcome is not established. */
const INDETERMINATE_STATES = new Set(["SUBMITTED", "PENDING", "UNCONFIRMED"]);

/**
 * Pull every number out of a record, at any depth.
 *
 * Deliberately greedy: over-collecting evidence only ever makes the screen more permissive about
 * figures that genuinely came from the system, and every number in a record demonstrably did. Being
 * stingy here would refuse honest summaries, which is the failure mode that gets a safety feature
 * switched off.
 */
function harvest(value: unknown, into: number[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) into.push(value);
    return;
  }
  if (typeof value === "string") {
    // Numbers stringified by Binance ("80127.99000000") are still numbers the ledger vouches for.
    const n = Number(value);
    if (value.trim() !== "" && Number.isFinite(n)) into.push(n);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) harvest(v, into, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) harvest(v, into, depth + 1);
  }
}

export function buildEvidence(records: readonly LedgerRecord[]): Evidence {
  const values: number[] = [];
  const confirmed: LedgerRecord[] = [];
  const blocked: LedgerRecord[] = [];
  const unconfirmed: LedgerRecord[] = [];

  for (const r of records) {
    harvest(r.args, values, 1);
    harvest(r.context, values, 1);
    harvest(r.cappedArgs, values, 1);
    if (r.notionalUsd !== null) values.push(r.notionalUsd);
    if (typeof r.outcomeDeviationPct === "number") values.push(r.outcomeDeviationPct);
    values.push(r.seq);

    const state = r.lifecycle ?? "";
    if (EXECUTED_STATES.has(state)) confirmed.push(r);
    else if (INDETERMINATE_STATES.has(state)) unconfirmed.push(r);
    if (r.verdict === "BLOCK" || state === "BLOCKED") blocked.push(r);
  }

  // Counts are legitimate things to state and are not otherwise in the bag: "3 orders were refused"
  // has to be groundable or every honest summary trips the screen.
  values.push(records.length, confirmed.length, blocked.length, unconfirmed.length);

  return { values: [...new Set(values)], confirmed, blocked, unconfirmed };
}

/**
 * Spans that look numeric but are not quantities, removed before extraction.
 *
 * Without this the screen is unusable: an ISO timestamp reads as three ungrounded integers, a gate
 * id reads as one, and a hash reads as several. All of them are identifiers — they carry no
 * magnitude, so "grounding" them against an evidence value would be meaningless in both directions.
 */
const NON_QUANTITY_PATTERNS: readonly RegExp[] = [
  /\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, // ISO timestamps
  /\d{4}-\d{2}-\d{2}/g, // ISO dates
  /\d{2}:\d{2}(:\d{2})?/g, // clock times
  /\b\d{2}_[a-z_]+\b/g, // gate ids: 06_max_order_notional
  /\bgates?\s+\d{1,2}\b/gi, // prose references: "gate 17"
  /\b[0-9a-f]{8,}\b/gi, // hashes and hash prefixes
  /\b[A-Z]{2,}\d+[A-Z]*\b/g, // instrument-ish tokens
];

/** A number as written in the text, with the precision it was written at. */
interface WrittenNumber {
  value: number;
  quote: string;
  /**
   * The rounding step implied by how the figure was WRITTEN — 1 for "80,128", 0.01 for "80,127.99",
   * 100 for "80.1k". This is what makes grounding principled rather than a guess: a figure vouches
   * for an evidence value when that value rounds to it at the precision the author chose to use.
   */
  step: number;
}

const SUFFIX_SCALE: Readonly<Record<string, number>> = { k: 1e3, m: 1e6, bn: 1e9, b: 1e9 };

export function extractNumbers(text: string): WrittenNumber[] {
  let scrubbed = text;
  for (const p of NON_QUANTITY_PATTERNS) scrubbed = scrubbed.replace(p, " ");

  const out: WrittenNumber[] = [];
  const re = /(-|−)?\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(bn|[kmb])?\s?(%)?/gi;
  for (const m of scrubbed.matchAll(re)) {
    const [quote, sign, intPart, frac, suffix] = m;
    if (intPart === undefined) continue;
    const raw = `${intPart.replace(/,/g, "")}${frac ?? ""}`;
    let value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (suffix) value *= SUFFIX_SCALE[suffix.toLowerCase()] ?? 1;
    if (sign) value = -value;
    // The step is the magnitude of the last digit the author actually wrote, scaled by any suffix.
    // "80.1k" is written to the nearest hundred and must be judged at that precision, not at 0.1.
    const decimals = (frac?.length ?? 1) - 1;
    const step = 10 ** -decimals * (suffix ? (SUFFIX_SCALE[suffix.toLowerCase()] ?? 1) : 1);
    out.push({ value, quote: quote.trim(), step });
  }
  return out;
}

/**
 * Is a written number vouched for by some evidence value?
 *
 * One rule: a figure is grounded when an evidence value rounds to it at the precision the figure was
 * written at. So 80,127.99 grounds "80,127.99", "80,128" and "80.1k" — every honest abbreviation of
 * itself — and grounds "80,500" at no precision at all.
 *
 * The first version of this also carried a flat 0.5% relative band as a second chance, and the band
 * was wrong: 0.5% of eighty thousand is three hundred and seventy-two dollars, so "$80,500" came
 * back grounded by a record reading 80,127.99. A tolerance that scales with magnitude grants the
 * most licence exactly where the stakes are highest. Precision-as-written does not have that
 * property, and it is the rule a careful reader would apply anyway.
 */
function isGrounded(written: WrittenNumber, evidence: readonly number[]): boolean {
  const halfStep = written.step / 2;
  for (const e of evidence) {
    if (e === written.value) return true;
    // A hair of slack for binary floating point, never enough to reach a neighbouring step.
    if (Math.abs(written.value - e) <= halfStep + Math.abs(e) * Number.EPSILON * 8) return true;
  }
  return false;
}

/**
 * Language patterns that are refused regardless of grounding.
 *
 * A forecast cannot be grounded in a ledger by definition — the ledger records what happened, and no
 * record can vouch for what a price will do. Advice is refused on the same footing Binance's own
 * documentation takes: this is a risk layer, not a licensed adviser, and a summary that slides into
 * a recommendation has changed what it is.
 */
const FORECAST_PATTERNS: readonly { re: RegExp; detail: string }[] = [
  { re: /\b(will|gonna|going to)\s+(rise|fall|rally|dump|pump|moon|drop|climb|surge|crash|recover|bounce|hit|reach|break)\b/gi, detail: "states what the market will do" },
  { re: /\b(expect|anticipate|predict|forecast|project)(s|ed|ing)?\b\s+(a\s+)?(rise|fall|rally|gain|loss|move|price|upside|downside|breakout)/gi, detail: "forecasts a price move" },
  { re: /\b(guaranteed|risk[-\s]?free|sure thing|can't lose|cannot lose|certain profit)\b/gi, detail: "claims a guarantee no market offers" },
  { re: /\b(to the moon|easy money|free money)\b/gi, detail: "hype language" },
  { re: /\b(bullish|bearish)\s+(outlook|forecast|target)\b/gi, detail: "directional forecast" },
  { re: /\bprice target\b/gi, detail: "states a price target" },
];

const ADVICE_PATTERNS: readonly { re: RegExp; detail: string }[] = [
  { re: /\byou\s+should\s+(buy|sell|short|long|hold|invest|allocate|exit|enter)\b/gi, detail: "tells the user to trade" },
  { re: /\b(i|we)\s+recommend\s+(buying|selling|shorting|holding|investing)\b/gi, detail: "recommends a trade" },
  { re: /\b(you\s+)?(ought to|must)\s+(buy|sell|invest)\b/gi, detail: "instructs the user to trade" },
  { re: /\bmy advice is\b/gi, detail: "offers investment advice" },
  { re: /\b(good|great|smart|strong)\s+(buy|entry|investment|opportunity)\b/gi, detail: "characterises a trade as a good one" },
];

/** Past-tense assertions that money moved. */
const EXECUTION_PATTERNS: readonly RegExp[] = [
  /\b(bought|sold|purchased|acquired|executed|filled|traded|swapped|invested|deposited|withdrew|transferred)\b/gi,
  /\b(order|trade|position|buy|sell)\s+(was\s+)?(filled|executed|completed|placed and filled)\b/gi,
  /\b(i|we)\s+(have\s+)?(opened|closed|entered|exited)\s+(a\s+)?(position|trade)\b/gi,
];

/** Phrases that would make an unestablished outcome sound settled. */
const CERTAINTY_PATTERNS: readonly RegExp[] = [
  /\b(confirmed|definitely|certainly|successfully)\b/gi,
  /\bwent through\b/gi,
  /\bcompleted successfully\b/gi,
];

/** Words that acknowledge a refusal happened. */
const REFUSAL_ACKNOWLEDGEMENT = /\b(block(ed|s)?|refus(e|ed|al|als)|declin(e|ed)|reject(ed)?|denied|stopped|prevent(ed)?|halt(ed)?|not allowed|didn'?t go through|did not go through|no orders? (were|was) (placed|sent)|capped)\b/i;

function findAll(text: string, patterns: readonly { re: RegExp; detail: string }[], code: ViolationCode): Violation[] {
  const out: Violation[] = [];
  for (const { re, detail } of patterns) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      out.push({ code, quote: m[0].trim(), detail });
    }
  }
  return out;
}

/**
 * Screen a natural-language summary against the ledger.
 *
 * Order matters only for readability of the result; every check runs, because an agent that has
 * invented a number has usually also invented the sentence around it, and reporting one violation
 * at a time would take five round trips to surface one bad paragraph.
 */
export function screenNarration(text: string, records: readonly LedgerRecord[]): NarrationVerdict {
  const evidence = buildEvidence(records);
  const violations: Violation[] = [];
  const grounded: number[] = [];

  for (const written of extractNumbers(text)) {
    if (isGrounded(written, evidence.values)) grounded.push(written.value);
    else {
      violations.push({
        code: "ungrounded_number",
        quote: written.quote,
        detail: `no record in the ledger carries this figure — the ledger cannot vouch for "${written.quote}"`,
      });
    }
  }

  violations.push(...findAll(text, FORECAST_PATTERNS, "forecast"));
  violations.push(...findAll(text, ADVICE_PATTERNS, "advice"));

  // An execution claim needs a CONFIRMED record behind it. SUBMITTED and UNCONFIRMED are not
  // evidence a trade happened — that distinction is the entire reason the lifecycle exists, and
  // letting past-tense language paper over it here would undo it at the last step.
  const claimsExecution = EXECUTION_PATTERNS.some((re) => new RegExp(re.source, re.flags).test(text));
  if (claimsExecution && evidence.confirmed.length === 0) {
    const match = EXECUTION_PATTERNS.map((re) => text.match(new RegExp(re.source, re.flags))?.[0]).find(Boolean) ?? "execution claim";
    violations.push({
      code: "unsupported_execution_claim",
      quote: match.trim(),
      detail:
        evidence.unconfirmed.length > 0
          ? `nothing reached CONFIRMED: ${evidence.unconfirmed.length} action(s) are SUBMITTED or UNCONFIRMED, which is not evidence anything filled`
          : "no confirmed execution exists in the ledger for this session",
    });
  }

  // Confident phrasing over an outcome Governor could not establish.
  if (evidence.confirmed.length === 0 && evidence.unconfirmed.length > 0) {
    for (const re of CERTAINTY_PATTERNS) {
      const m = text.match(new RegExp(re.source, re.flags));
      if (m) {
        violations.push({
          code: "false_certainty",
          quote: m[0].trim(),
          detail: `the outcome is UNCONFIRMED — Governor could not establish what happened, so "${m[0].trim()}" overstates the record`,
        });
      }
    }
  }

  // Omission. The check every screen that only reads what IS said will miss.
  if (evidence.blocked.length > 0 && !REFUSAL_ACKNOWLEDGEMENT.test(text)) {
    violations.push({
      code: "refusal_suppressed",
      quote: text.slice(0, 80).trim(),
      detail: `${evidence.blocked.length} action(s) were refused this session and the summary does not mention it — true sentences that omit a refusal still mislead`,
    });
  }

  if (violations.length > 0) {
    return { ok: false, violations, replacement: deterministicSummary(records) };
  }
  return { ok: true, text, groundedNumbers: grounded };
}

const money = (n: number | null): string => (n === null ? "an unrecorded amount" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

/**
 * A summary assembled only from ledger records, with no model in the loop.
 *
 * This is what makes refusing useful rather than merely obstructive: there is always a correct thing
 * to say, and it is produced by concatenation, not generation. It states the refusals first, because
 * that is the part an agent's own summary is most likely to leave out.
 */
export function deterministicSummary(records: readonly LedgerRecord[]): string {
  const e = buildEvidence(records);
  const writes = records.filter((r) => r.effect === "WRITE");
  if (writes.length === 0) {
    return `Governor recorded ${records.length} call(s) this session and none of them attempted to move money. No orders were proposed, so none were placed.`;
  }

  const parts: string[] = [];

  if (e.blocked.length > 0) {
    const reasons = [...new Set(e.blocked.map((r) => r.gates.find((g) => !g.passed)?.gate ?? r.reason))].slice(0, 4);
    parts.push(`${e.blocked.length} action(s) were refused by the policy engine (${reasons.join(", ")}). No money moved on those.`);
  }
  if (e.confirmed.length > 0) {
    const detail = e.confirmed
      .slice(0, 3)
      .map((r) => `${r.tool} for ${money(r.notionalUsd)} (${r.lifecycle})`)
      .join("; ");
    parts.push(`${e.confirmed.length} action(s) were independently read back from the venue and confirmed: ${detail}.`);
  }
  if (e.unconfirmed.length > 0) {
    parts.push(
      `${e.unconfirmed.length} action(s) were sent but Governor could NOT establish what happened to them — they are recorded as unconfirmed, not as fills, and must not be described as executed.`,
    );
  }
  if (parts.length === 0) {
    parts.push(`${writes.length} write(s) were proposed and none reached a confirmed outcome.`);
  }

  parts.push("Every figure above is taken from the signed decision ledger and can be re-derived from it.");
  return parts.join(" ");
}
