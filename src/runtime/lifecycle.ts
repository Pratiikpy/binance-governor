// Execution truth: the difference between "the API returned success" and "the money moved".
//
// Governor used to write one record per write and call it done. The verdict said ALLOW, the upstream
// said `success: true`, and the ledger recorded an execution. That is a lie by omission, and it is
// the specific lie Binance's own documentation warns about: their DeFi reference states that a
// broadcast transaction hash means the transaction was *submitted*, not that it succeeded, and their
// skills re-fetch after every state-changing call because the backends silently no-op and still
// return success. An audit trail that cannot distinguish "asked" from "happened" is not an audit
// trail; it is a log of intentions.
//
// So a write is no longer an event. It is a lifecycle, and every transition is appended to the same
// signed, hash-chained ledger:
//
//   PROPOSED ─┬─ BLOCKED                                  (a gate refused it)
//             └─ AUTHORIZED ── SUBMITTED ─┬─ PENDING ──┬─ CONFIRMED ── STATE_VERIFIED
//                                         │            ├─ FAILED
//                                         │            ├─ REVERTED
//                                         │            └─ DROPPED
//                                         └─ UNCONFIRMED
//
// UNCONFIRMED is the important one and the one a naive implementation never has. It means Governor
// could not establish what happened — the read-back failed, timed out, or disagreed with itself. It
// is not a failure and it is not a success, and recording it as either would be inventing certainty.

/** Every state a write can be in. Ordered by the sequence they normally occur in. */
export const LIFECYCLE_STATES = [
  "PROPOSED",
  "BLOCKED",
  "AUTHORIZED",
  "SUBMITTED",
  "PENDING",
  "CONFIRMED",
  "FAILED",
  "REVERTED",
  "DROPPED",
  "UNCONFIRMED",
  "STATE_VERIFIED",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/**
 * Legal transitions. Anything absent here is a bug in the caller, and `assertTransition` refuses it
 * rather than letting a record claim a state it could not have reached — a ledger that permits
 * SUBMITTED → STATE_VERIFIED without a confirmation in between would let the very shortcut this
 * module exists to prevent back in through the side door.
 */
const TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  PROPOSED: ["BLOCKED", "AUTHORIZED"],
  BLOCKED: [],
  AUTHORIZED: ["SUBMITTED", "FAILED"],
  SUBMITTED: ["PENDING", "CONFIRMED", "FAILED", "REVERTED", "DROPPED", "UNCONFIRMED"],
  PENDING: ["CONFIRMED", "FAILED", "REVERTED", "DROPPED", "UNCONFIRMED"],
  CONFIRMED: ["STATE_VERIFIED", "UNCONFIRMED"],
  FAILED: [],
  REVERTED: [],
  DROPPED: [],
  UNCONFIRMED: ["CONFIRMED", "FAILED", "STATE_VERIFIED"], // a later read-back may still settle it
  STATE_VERIFIED: [],
};

/** States from which nothing further can happen. */
export const TERMINAL_STATES: readonly LifecycleState[] = ["BLOCKED", "FAILED", "REVERTED", "DROPPED", "STATE_VERIFIED"];

export function isTerminal(state: LifecycleState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: LifecycleState, to: LifecycleState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal lifecycle transition ${from} → ${to}`);
  }
}

/**
 * What the caller was authorised to get, bound BEFORE the order is sent.
 *
 * This is the half that makes verification meaningful. Re-reading the account after an order tells
 * you what you now hold; it cannot tell you whether that is what you agreed to. Binding the expected
 * result first turns the read-back into a comparison rather than an observation.
 */
export interface ExpectedOutcome {
  symbol: string;
  side: "BUY" | "SELL" | null;
  /** Quote-currency amount the caller authorised spending (or receiving, on a sell). */
  quoteAmountUsd: number | null;
  /** Base-asset quantity expected, when the order specified one. */
  baseQuantity: number | null;
  /** Reference price at the moment of authorisation. */
  refPrice: number | null;
  /** How far the realised fill may drift from the authorised amount before it is a deviation, in %. */
  tolerancePct: number;
}

/** What actually happened, read back from the venue rather than inferred from the order response. */
export interface ActualOutcome {
  /** The venue's own order status, verbatim: FILLED, PARTIALLY_FILLED, NEW, REJECTED, EXPIRED… */
  status: string | null;
  executedQty: number | null;
  cummulativeQuoteQty: number | null;
  /** True when this came from an independent read-back, not from the order-placement response. */
  independentlyRead: boolean;
}

export interface OutcomeComparison {
  state: LifecycleState;
  /** Signed percentage difference between what was authorised and what was executed. Null when
   *  either side is unknown — an unknown deviation is never reported as zero. */
  deviationPct: number | null;
  withinTolerance: boolean | null;
  detail: string;
}

/**
 * Compare what was authorised against what the venue says actually happened.
 *
 * Every branch that cannot establish the truth returns UNCONFIRMED. That is the whole discipline:
 * the function has no path that guesses, and no path that treats missing data as agreement.
 */
export function compareOutcome(expected: ExpectedOutcome, actual: ActualOutcome): OutcomeComparison {
  if (!actual.independentlyRead) {
    return {
      state: "UNCONFIRMED",
      deviationPct: null,
      withinTolerance: null,
      detail: "outcome taken from the order response rather than an independent read-back — not evidence",
    };
  }
  if (actual.status === null) {
    return { state: "UNCONFIRMED", deviationPct: null, withinTolerance: null, detail: "venue returned no order status on read-back" };
  }

  const status = actual.status.toUpperCase();
  if (status === "REJECTED" || status === "EXPIRED") {
    return { state: "FAILED", deviationPct: null, withinTolerance: null, detail: `venue reports ${status} — the order did not execute` };
  }
  if (status === "CANCELED") {
    return { state: "DROPPED", deviationPct: null, withinTolerance: null, detail: "order was cancelled before it executed" };
  }
  if (status === "NEW" || status === "PENDING_NEW") {
    return { state: "PENDING", deviationPct: null, withinTolerance: null, detail: "accepted by the venue and resting — nothing has filled yet" };
  }

  // FILLED or PARTIALLY_FILLED: something moved, so the question becomes how much.
  const authorised = expected.quoteAmountUsd ?? (expected.baseQuantity !== null && expected.refPrice !== null ? expected.baseQuantity * expected.refPrice : null);
  const realised = actual.cummulativeQuoteQty;

  if (authorised === null || realised === null || authorised <= 0) {
    return {
      state: "UNCONFIRMED",
      deviationPct: null,
      withinTolerance: null,
      detail: `venue reports ${status} but the amounts cannot be compared (authorised ${authorised ?? "unknown"}, realised ${realised ?? "unknown"})`,
    };
  }

  const deviationPct = ((realised - authorised) / authorised) * 100;
  const withinTolerance = Math.abs(deviationPct) <= expected.tolerancePct;

  if (status === "PARTIALLY_FILLED") {
    return {
      state: "CONFIRMED",
      deviationPct,
      withinTolerance,
      detail: `partially filled: ${realised.toFixed(2)} of an authorised ${authorised.toFixed(2)} (${deviationPct >= 0 ? "+" : ""}${deviationPct.toFixed(2)}%)`,
    };
  }

  return {
    state: withinTolerance ? "STATE_VERIFIED" : "CONFIRMED",
    deviationPct,
    withinTolerance,
    detail: withinTolerance
      ? `executed ${realised.toFixed(2)} against an authorised ${authorised.toFixed(2)} — ${deviationPct >= 0 ? "+" : ""}${deviationPct.toFixed(2)}%, within the ${expected.tolerancePct}% tolerance`
      : `executed ${realised.toFixed(2)} against an authorised ${authorised.toFixed(2)} — ${deviationPct >= 0 ? "+" : ""}${deviationPct.toFixed(2)}%, OUTSIDE the ${expected.tolerancePct}% tolerance. Confirmed, not verified.`,
  };
}
