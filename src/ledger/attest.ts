// Tamper-evidence for the decision ledger: a per-record hash chain, plus an Ed25519 signature over
// the chain head.
//
// Two mechanisms, because they fail differently. The hash chain makes an edit to record N invalidate
// every record after it, so truncation and insertion are both visible without any key material. The
// signature proves the chain was produced by this Governor instance, so a whole ledger cannot be
// swapped for a friendlier one. Verification of the chain needs nothing but the file; verification
// of the signature needs only the public key, which the attestation carries with it.
//
// Adapted from the attestation module of my earlier NightDesk work. Two changes matter here:
// serialization is canonical (sorted keys) rather than JSON.stringify's insertion order, so the same
// logical record always hashes the same; and each record carries prevHash, so tampering is localised
// rather than only detectable across the whole batch.
//
// Pure node:crypto. No dependency, no network, and signing never sits in front of a trade.

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  createHash,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface Keypair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyPem: string;
}

export interface Attestation {
  algo: "ed25519";
  recordCount: number;
  /** Hash of the final record — the head of the chain, and therefore of the whole history. */
  chainHead: string;
  signatureHex: string;
  publicKeyPem: string;
  signedAt: string;
}

/** The genesis link. Every chain starts here, so an empty ledger has a well-defined head. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Deterministic JSON: object keys sorted at every depth, arrays left in order.
 *
 * Insertion order is not a property of the data, so hashing JSON.stringify output means the same
 * record can hash two different ways depending on how it was built. That would produce false tamper
 * alarms, and a tamper alarm nobody believes is worse than no alarm.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Hash of one record given its predecessor. The record must not already contain its own hash. */
export function linkHash(prevHash: string, recordWithoutHash: unknown): string {
  return sha256Hex(`${prevHash}\n${canonicalize(recordWithoutHash)}`);
}

export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string };
}

/**
 * Load the signing key, generating and persisting one on first use.
 *
 * The private key lives under data/, which is gitignored. It signs an audit trail and nothing else —
 * it has no authority over funds and cannot place an order.
 */
export function loadOrCreateKeypair(file: string): Keypair {
  if (existsSync(file)) {
    const { privateKeyPem, publicKeyPem } = JSON.parse(readFileSync(file, "utf8")) as {
      privateKeyPem: string;
      publicKeyPem: string;
    };
    return { privateKey: createPrivateKey(privateKeyPem), publicKey: createPublicKey(publicKeyPem), publicKeyPem };
  }
  const kp = generateKeypair();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      { privateKeyPem: kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string, publicKeyPem: kp.publicKeyPem },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return kp;
}

/** Sign a chain head. Self-contained: the attestation carries the public key needed to check it. */
export function attest(chainHead: string, recordCount: number, keys: Keypair): Attestation {
  return {
    algo: "ed25519",
    recordCount,
    chainHead,
    signatureHex: edSign(null, Buffer.from(chainHead, "hex"), keys.privateKey).toString("hex"),
    publicKeyPem: keys.publicKeyPem,
    signedAt: new Date().toISOString(),
  };
}

export function verifyAttestation(chainHead: string, att: Attestation): boolean {
  if (att.chainHead !== chainHead) return false;
  try {
    return edVerify(null, Buffer.from(chainHead, "hex"), createPublicKey(att.publicKeyPem), Buffer.from(att.signatureHex, "hex"));
  } catch {
    return false;
  }
}
