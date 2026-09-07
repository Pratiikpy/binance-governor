// The decision ledger: one append-only, hash-chained record per gated call.
//
// Written for a reader who does not trust us. Every record carries the full input (tool, arguments,
// the context the gates saw), every gate result including the ones that passed, the verdict, and the
// upstream response if the call was allowed through. Blocked calls are recorded exactly as carefully
// as allowed ones — a risk layer that only logs what it permitted cannot prove it ever refused
// anything.
//
// Storage is JSONL, one record per line, one file per UTC day, with a signed sidecar. JSONL because
// appending must be a single write that cannot corrupt what came before, and because the file stays
// greppable by a human with no tooling.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Decision, GateResult } from "../policy/gates.ts";
import { GENESIS_HASH, attest, linkHash, loadOrCreateKeypair, verifyAttestation, type Attestation } from "./attest.ts";

export interface LedgerRecord {
  seq: number;
  ts: string;
  /** Hash of the previous record; GENESIS_HASH for the first. */
  prevHash: string;
  /** Hash of this record's content, chained onto prevHash. Excluded from its own input. */
  hash: string;

  tool: string;
  /**
   * CERTIFY is a Governor-issued Strategy Passport, not an upstream call — which is why this is a
   * wider type than `surface.ts`'s Effect. A certification belongs in the same signed chain as the
   * orders it authorises: an order can then be traced to its certification and back, in one file
   * whose integrity is checkable in a browser.
   */
  effect: "READ" | "WRITE" | "SIMULATE" | "CERTIFY";
  /**
   * SHA-256 over the canonical arguments ACTUALLY SENT upstream, present on every write that
   * reached Binance. The decision is made on the requested order; ALLOW_CAPPED then rewrites it,
   * so without this the ledger records an approval for one instruction and an execution of
   * another, and nobody can prove afterwards that the second descended from the first.
   */
  enforcedOrderHash?: string;
  args: Record<string, unknown>;

  verdict: Decision["verdict"];
  reason: string;
  gates: GateResult[];
  notionalUsd: number | null;

  /** What the gates were looking at when they decided. Enough to replay the decision exactly. */
  context?: Record<string, unknown>;
  /** Binance's own pre-flight validation result, when the order was test-validated first. */
  preflight?: { ok: boolean; detail: string };
  /** Upstream response for calls that were sent. Absent for anything blocked or held. */
  upstream?: { isError: boolean; raw: string };
  /** Populated when the order was rewritten before sending. */
  cappedArgs?: Record<string, unknown>;
}

export interface VerifyReport {
  ok: boolean;
  recordCount: number;
  chainHead: string;
  /** Index of the first record whose hash does not follow from its predecessor. */
  brokenAt: number | null;
  signature: "valid" | "invalid" | "absent";
  /** Whether the signing key matched a pinned issuer. Null when no key was pinned to check against. */
  trustedIssuer: boolean | null;
  detail: string;
}

export class Ledger {
  private readonly dir: string;
  private readonly keyFile: string;
  private seq = 0;
  private head = GENESIS_HASH;

  constructor(dir = join(process.cwd(), "data", "ledger")) {
    this.dir = dir;
    this.keyFile = join(dir, "attestation_key.json");
    mkdirSync(this.dir, { recursive: true });
    this.resume();
  }

  private dayFile(day = new Date().toISOString().slice(0, 10)): string {
    return join(this.dir, `${day}.jsonl`);
  }

  private sidecarFile(day = new Date().toISOString().slice(0, 10)): string {
    return join(this.dir, `${day}.attestation.json`);
  }

  /** Continue today's chain if one exists, so a restart does not silently start a second history. */
  private resume(): void {
    const file = this.dayFile();
    if (!existsSync(file)) return;
    const records = this.read();
    const last = records[records.length - 1];
    if (last) {
      this.seq = last.seq + 1;
      this.head = last.hash;
    }
  }

  read(day?: string): LedgerRecord[] {
    const file = this.dayFile(day);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerRecord);
  }

  /** Append a record, chain it, and re-sign the day's head. Returns the stored record. */
  append(entry: Omit<LedgerRecord, "seq" | "ts" | "prevHash" | "hash">): LedgerRecord {
    const base = { seq: this.seq, ts: new Date().toISOString(), prevHash: this.head, ...entry };
    const hash = linkHash(this.head, base);
    const record: LedgerRecord = { ...base, hash };

    appendFileSync(this.dayFile(), JSON.stringify(record) + "\n", "utf8");
    this.seq += 1;
    this.head = hash;
    this.sign();
    return record;
  }

  /** Sign the current head. Called after every append; cheap, and never in front of a trade. */
  private sign(): void {
    const att = attest(this.head, this.seq, loadOrCreateKeypair(this.keyFile));
    writeFileSync(this.sidecarFile(), JSON.stringify(att, null, 2), "utf8");
  }

  get chainHead(): string {
    return this.head;
  }

  get count(): number {
    return this.seq;
  }

  /** The signed attestation for a day, or null if that day has no signed chain yet. */
  readAttestation(day?: string): Attestation | null {
    const file = this.sidecarFile(day);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as Attestation;
  }

  /**
   * Re-derive every hash from genesis and check the signature.
   *
   * This is the function a sceptic runs. It needs no secret, and it names the exact record where the
   * history stops adding up rather than just reporting a boolean.
   */
  verify(day?: string, opts: { expectedCount?: number; pinnedPublicKeyPem?: string } = {}): VerifyReport {
    const records = this.read(day);
    let prev = GENESIS_HASH;
    for (let i = 0; i < records.length; i++) {
      const r = records[i]!;
      const { hash, ...withoutHash } = r;
      if (r.prevHash !== prev || linkHash(prev, withoutHash) !== hash) {
        return {
          ok: false,
          recordCount: records.length,
          chainHead: prev,
          brokenAt: i,
          signature: "absent",
          trustedIssuer: null,
          detail: `record ${i} (seq ${r.seq}, tool ${r.tool}) does not follow from its predecessor — the ledger was altered`,
        };
      }
      prev = hash;
    }

    const sidecar = this.sidecarFile(day);
    if (!existsSync(sidecar)) {
      return {
        ok: false,
        recordCount: records.length,
        chainHead: prev,
        brokenAt: null,
        signature: "absent",
        trustedIssuer: null,
        detail: "chain is intact but unsigned — no attestation sidecar",
      };
    }
    const att = JSON.parse(readFileSync(sidecar, "utf8")) as Attestation;
    const sigOk = verifyAttestation(prev, att);

    // Integrity is not authenticity. A signature that verifies against the key carried inside the
    // attestation only proves the file is self-consistent — anyone can re-sign a rewritten ledger with
    // their own key and it will pass. Pinning the expected public key is what makes it *ours*.
    const trusted = opts.pinnedPublicKeyPem === undefined ? null : normalizePem(opts.pinnedPublicKeyPem) === normalizePem(att.publicKeyPem);

    // Truncating the newest records leaves a shorter chain that is still perfectly self-consistent.
    // Only an externally known record count can catch it, so callers who know the count must pass it.
    const truncated = opts.expectedCount !== undefined && records.length < opts.expectedCount;

    const ok = sigOk && trusted !== false && !truncated;
    return {
      ok,
      recordCount: records.length,
      chainHead: prev,
      brokenAt: null,
      signature: sigOk ? "valid" : "invalid",
      trustedIssuer: trusted,
      detail: !sigOk
        ? "chain is intact but the signature does not match — the ledger was replaced or re-signed by another key"
        : trusted === false
          ? "chain and signature are self-consistent but the signing key is not the pinned issuer — this ledger was produced by someone else"
          : truncated
            ? `chain is intact but only ${records.length} of an expected ${opts.expectedCount} record(s) are present — the tail was truncated`
            : `${records.length} record(s), chain intact, signature valid${trusted === true ? ", issuer pinned" : ""}`,
    };
  }
}

/** PEM comparison that ignores line endings and surrounding whitespace. */
function normalizePem(pem: string): string {
  return pem.replace(/\s+/g, "");
}
