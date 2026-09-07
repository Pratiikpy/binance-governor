// Tests for the two screens that govern what the agent is allowed to SAY and how honestly it is
// allowed to have searched.
//
// Both exist because a guarantee was being taken on trust. The narration screen exists because no
// gate governed language, so a refused order could still be reported as a fill. The trial screen
// exists because the Deflated Sharpe deflates against a number the caller supplies about itself,
// and Governor was believing it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEvidence, deterministicSummary, extractNumbers, screenNarration } from "../src/policy/narration.ts";
import { familyKey, trialCount } from "../src/policy/trials.ts";
import { hashDataset, hashStrategy, issuePassport, type DatasetRef, type StrategySpec } from "../src/policy/passport.ts";
import type { LedgerRecord } from "../src/ledger/ledger.ts";

const NOW = 1_800_000_000_000;

/** A ledger record with only the fields these screens read. */
function rec(over: Partial<LedgerRecord>): LedgerRecord {
  return {
    seq: 0,
    ts: new Date(NOW).toISOString(),
    prevHash: "0".repeat(64),
    hash: "1".repeat(64),
    tool: "spot.newOrder",
    effect: "WRITE",
    args: {},
    verdict: "ALLOW",
    reason: "",
    gates: [],
    notionalUsd: null,
    ...over,
  } as LedgerRecord;
}

const blockedOrder = (notional: number) =>
  rec({
    lifecycle: "BLOCKED",
    verdict: "BLOCK",
    notionalUsd: notional,
    reason: "06_max_order_notional",
    gates: [{ gate: "06_max_order_notional", passed: false, detail: "too big" }],
    args: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteOrderQty: notional },
  });

const confirmedOrder = (notional: number) =>
  rec({
    lifecycle: "STATE_VERIFIED",
    verdict: "ALLOW",
    notionalUsd: notional,
    args: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteOrderQty: notional },
  });

// --- number grounding ---------------------------------------------------------------------------

test("a figure the ledger cannot vouch for is refused", () => {
  const v = screenNarration("I bought $500 of BTC. It was blocked.", [blockedOrder(25)]);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(
    v.violations.some((x) => x.code === "ungrounded_number" && x.quote.includes("500")),
    `expected 500 to be ungrounded, got ${JSON.stringify(v.violations)}`,
  );
});

test("a figure that IS in the ledger passes, including when rounded as written", () => {
  const records = [confirmedOrder(80127.99)];
  // Grounded exactly, and grounded at the precision it was written at. A screen that refused
  // "80,128" would be refusing honest abbreviation, and a screen nobody can satisfy gets turned off.
  for (const claim of ["Executed 80127.99 of notional. Nothing was blocked.", "Executed about $80,128 of notional. Nothing was blocked."]) {
    const v = screenNarration(claim, records);
    assert.equal(v.ok, true, `expected pass for ${claim}: ${JSON.stringify(v)}`);
  }
});

test("rounding tolerance does not stretch to a different number", () => {
  const v = screenNarration("Executed $80,500 of notional. Nothing was blocked.", [confirmedOrder(80127.99)]);
  assert.equal(v.ok, false, "80,500 is not a rounding of 80,127.99 and must not be grounded by it");
});

test("identifiers are not treated as quantities", () => {
  // Timestamps, gate ids and hashes carry no magnitude. Grounding them would be meaningless, and
  // refusing them would make every real summary fail — the screen would be unusable either way.
  const nums = extractNumbers("At 2026-09-07T12:00:00Z gate 06 (06_max_order_notional) refused it; hash 9330992abcdef01.");
  assert.deepEqual(
    nums.map((n) => n.value),
    [],
    `expected no quantities, got ${JSON.stringify(nums)}`,
  );
});

test("counts derived from the records are groundable", () => {
  const v = screenNarration("3 actions were refused by the policy engine.", [blockedOrder(1), blockedOrder(2), blockedOrder(3)]);
  assert.equal(v.ok, true, `a true count must be sayable: ${JSON.stringify(v)}`);
});

// --- execution claims ---------------------------------------------------------------------------

test("claiming a fill with nothing confirmed is refused", () => {
  const v = screenNarration("I bought BTC for you. It was blocked.", [blockedOrder(25)]);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(v.violations.some((x) => x.code === "unsupported_execution_claim"));
});

test("SUBMITTED and UNCONFIRMED are not evidence of a fill", () => {
  // The whole reason the lifecycle exists. If past-tense language could paper over UNCONFIRMED here,
  // the distinction would be undone at the last step, in the only place a human ever reads it.
  const v = screenNarration("The order was filled.", [rec({ lifecycle: "UNCONFIRMED", verdict: "ALLOW", notionalUsd: 25 })]);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(v.violations.some((x) => x.code === "unsupported_execution_claim"));
  assert.ok(v.violations.some((x) => x.code === "false_certainty" || x.code === "unsupported_execution_claim"));
});

test("a confirmed fill may be described as a fill", () => {
  const v = screenNarration("The order was filled.", [confirmedOrder(25)]);
  assert.equal(v.ok, true, JSON.stringify(v));
});

// --- forecasts and advice -----------------------------------------------------------------------

test("forecasts are refused however they are phrased", () => {
  for (const claim of [
    "BTC will rally next week. Nothing was blocked.",
    "I expect a rise from here. Nothing was blocked.",
    "This is a risk-free entry. Nothing was blocked.",
    "Bullish outlook into the weekend. Nothing was blocked.",
  ]) {
    const v = screenNarration(claim, [confirmedOrder(25)]);
    assert.equal(v.ok, false, `expected refusal for: ${claim}`);
    if (v.ok) continue;
    assert.ok(v.violations.some((x) => x.code === "forecast"), `expected a forecast violation for: ${claim}`);
  }
});

test("investment advice is refused", () => {
  const v = screenNarration("You should buy more here. Nothing was blocked.", [confirmedOrder(25)]);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(v.violations.some((x) => x.code === "advice"));
});

test("a plain factual summary is not refused", () => {
  // The control that matters. A screen that refuses everything proves nothing and would be switched
  // off within a day, so an honest summary has to survive it intact.
  const v = screenNarration("One action was refused by the policy engine. No money moved.", [blockedOrder(50)]);
  assert.equal(v.ok, true, JSON.stringify(v));
});

// --- omission -----------------------------------------------------------------------------------

test("a summary that is true but omits a refusal is refused", () => {
  // The check a screen that only reads what IS said cannot have. Every word here is accurate.
  const v = screenNarration("I reviewed the market and took no action today.", [blockedOrder(50), blockedOrder(60)]);
  assert.equal(v.ok, false, "omitting a refusal that happened is still misleading");
  if (v.ok) return;
  const suppressed = v.violations.find((x) => x.code === "refusal_suppressed");
  assert.ok(suppressed, JSON.stringify(v.violations));
  assert.match(suppressed.detail, /2 action/);
});

test("acknowledging the refusal clears that violation", () => {
  const v = screenNarration("I proposed two orders and both were refused by the policy engine.", [blockedOrder(50), blockedOrder(60)]);
  assert.equal(v.ok, true, JSON.stringify(v));
});

// --- the replacement ----------------------------------------------------------------------------

test("every refusal carries a correct replacement, and the replacement passes its own screen", () => {
  // Refusing without replacing is useless: the agent has to have something correct to say. And a
  // replacement that would not survive the screen would be an admission the screen is wrong.
  const records = [blockedOrder(50), confirmedOrder(25)];
  const v = screenNarration("I bought $999 of BTC and it will rally.", records);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(v.replacement.length > 0);
  const second = screenNarration(v.replacement, records);
  assert.equal(second.ok, true, `the deterministic replacement must pass the screen: ${JSON.stringify(second)}`);
});

test("the deterministic summary never invents an outcome for an unconfirmed action", () => {
  const summary = deterministicSummary([rec({ lifecycle: "UNCONFIRMED", verdict: "ALLOW", notionalUsd: 25 })]);
  assert.match(summary, /could NOT establish|unconfirmed/i);
  assert.doesNotMatch(summary, /\bfilled\b|\bbought\b/i);
});

test("evidence is built from the records and not from the caller", () => {
  const e = buildEvidence([blockedOrder(50), confirmedOrder(25)]);
  assert.ok(e.values.includes(50) && e.values.includes(25));
  assert.equal(e.blocked.length, 1);
  assert.equal(e.confirmed.length, 1);
});

// --- trial accounting ---------------------------------------------------------------------------

const DATASET: DatasetRef = { symbol: "BTCUSDT", interval: "1h", bars: 8760, from: "2025-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" };

function certifyRecord(spec: StrategySpec, dataset: DatasetRef): LedgerRecord {
  const passport = issuePassport({
    spec,
    dataset,
    verdict: "UNSUPPORTED",
    reason: "test",
    evidence: { nTrials: 1, dsr: null, minBacktestYears: null, yearsHeld: null, pbo: null, walkForwardOosSharpe: null, netEdgeBps: null, haltTempoMedianBars: null },
    nowMs: NOW,
    validForDays: 30,
  });
  return rec({ effect: "CERTIFY", tool: "governor.evaluateIdea", context: { passport } });
}

const sma = (fast: number): StrategySpec => ({ name: "sma-crossover", symbols: ["BTCUSDT"], params: { fast, slow: 40 } });

test("sweeping through Governor is counted even when every call declares one trial", () => {
  // The attack: 25 configurations, 25 calls, each honestly saying "this is one hypothesis". Every
  // individual statement is true and the Deflated Sharpe is defeated anyway.
  const records = Array.from({ length: 25 }, (_, i) => certifyRecord(sma(i + 2), DATASET));
  const t = trialCount({
    records,
    candidateHash: hashStrategy(sma(99)),
    symbols: ["BTCUSDT"],
    datasetHash: hashDataset(DATASET),
    declared: 1,
  });
  assert.equal(t.observed, 26, "25 already judged plus the candidate");
  assert.equal(t.effective, 26);
  assert.equal(t.understated, true);
});

test("an honest declaration is never lowered by the ledger", () => {
  // A caller that swept 71 configurations in its own process and said so must keep the benefit of
  // that honesty, even though Governor only ever saw one call.
  const t = trialCount({ records: [], candidateHash: hashStrategy(sma(5)), symbols: ["BTCUSDT"], datasetHash: hashDataset(DATASET), declared: 71 });
  assert.equal(t.effective, 71);
  assert.equal(t.understated, false);
});

test("re-judging the same strategy is one trial, not two", () => {
  const records = [certifyRecord(sma(5), DATASET), certifyRecord(sma(5), DATASET)];
  const t = trialCount({ records, candidateHash: hashStrategy(sma(5)), symbols: ["BTCUSDT"], datasetHash: hashDataset(DATASET), declared: 1 });
  assert.equal(t.observed, 1, "the same hash seen three times is still one hypothesis");
});

test("a different dataset is a different search", () => {
  // Deflating an unrelated question by another search's count would be superstition, not statistics.
  const other: DatasetRef = { ...DATASET, symbol: "ETHUSDT" };
  const records = Array.from({ length: 10 }, (_, i) => certifyRecord(sma(i + 2), DATASET));
  const t = trialCount({ records, candidateHash: hashStrategy({ name: "x", symbols: ["ETHUSDT"], params: {} }), symbols: ["ETHUSDT"], datasetHash: hashDataset(other), declared: 1 });
  assert.equal(t.observed, 1);
});

test("renaming the strategy on each pass does not escape the count", () => {
  // The obvious dodge, and the reason the family key is the DATA rather than the strategy name.
  const records = Array.from({ length: 8 }, (_, i) => certifyRecord({ name: `idea-${i}`, symbols: ["BTCUSDT"], params: { seed: i } }, DATASET));
  const t = trialCount({
    records,
    candidateHash: hashStrategy({ name: "idea-final", symbols: ["BTCUSDT"], params: { seed: 99 } }),
    symbols: ["BTCUSDT"],
    datasetHash: hashDataset(DATASET),
    declared: 1,
  });
  assert.equal(t.observed, 9);
  assert.equal(t.understated, true);
});

test("the family key is order- and case-insensitive over symbols", () => {
  assert.equal(familyKey(["ETHUSDT", "btcusdt"], "d"), familyKey(["BTCUSDT", "ETHUSDT"], "d"));
});
