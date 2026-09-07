// Proves the console's browser-side verification logic against a REAL ledger produced by
// the REAL Governor — not a fixture, not a mock of the crypto. The only thing faked here is
// the Binance upstream itself (so this test runs offline and deterministically); the gates,
// the ledger, the hashing and the Ed25519 signing are the genuine production code, and the
// verification step below is a character-for-character copy of src/console/page.ts's
// client-side JavaScript, run through Node's Web Crypto — the same API a real browser has.
//
// This was first proven by hand against a live server with a live Binance connection (see
// docs/13 or the session transcript); this test makes that proof permanent and repeatable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinanceUpstream } from "../src/upstream/binance-mcp.ts";
import { Governor } from "../src/runtime/governor.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { ContextBuilder } from "../src/runtime/context.ts";
import { loadPolicy } from "../src/policy/config.ts";

/** A fake Binance MCP endpoint returning just enough real-shaped data to drive the Governor. */
function fakeBinanceFetch(): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    let result: unknown;
    if (body.method === "tools/call" && body.params?.name === "spot.tickerPrice") {
      result = { content: [{ type: "text", text: JSON.stringify({ symbol: "BTCUSDT", price: "80000.00" }) }], isError: false };
    } else if (body.method === "tools/call" && body.params?.name === "spot.getAccount") {
      result = { content: [{ type: "text", text: JSON.stringify({ balances: [{ asset: "USDT", free: "1000", locked: "0" }] }) }], isError: false };
    } else {
      result = { content: [{ type: "text", text: "{}" }], isError: false };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

// --- the exact client-side verification logic from src/console/page.ts -------------------

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const GENESIS = "0".repeat(64);

async function browserVerifyChain(records: Array<Record<string, unknown>>): Promise<{ ok: boolean; chainHead: string; brokenAt: number | null }> {
  let prev = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const { hash, ...withoutHash } = records[i]!;
    if (withoutHash["prevHash"] !== prev) return { ok: false, chainHead: prev, brokenAt: i };
    const recomputed = await sha256Hex(`${prev}\n${canonicalize(withoutHash)}`);
    if (recomputed !== hash) return { ok: false, chainHead: prev, brokenAt: i };
    prev = recomputed;
  }
  return { ok: true, chainHead: prev, brokenAt: null };
}

async function browserVerifySignature(chainHead: string, publicKeyPem: string, signatureHex: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("spki", pemToDer(publicKeyPem), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(signatureHex), hexToBytes(chainHead));
}

// --- the test -------------------------------------------------------------------------------

test("a real Governor session's ledger verifies end-to-end via pure Web Crypto, exactly as the console page does", async () => {
  const dir = mkdtempSync(join(tmpdir(), "governor-console-test-"));
  try {
    const upstream = new BinanceUpstream({ token: "test-token", fetchImpl: fakeBinanceFetch() });
    const ledger = new Ledger(dir);
    const context = new ContextBuilder(upstream);
    const governor = new Governor({ upstream, policy: loadPolicy(), ledger, context });

    // One allowed read, one refused write -- a real decision of each kind, from the real code.
    const readResult = await governor.call("spot.tickerPrice", { symbol: "BTCUSDT" });
    assert.equal(readResult.isError, false);

    const writeResult = await governor.call("spot.newOrder", { symbol: "DOGEUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 50000 });
    assert.equal(writeResult.isError, true);

    assert.equal(ledger.count, 2);

    const records = ledger.read();
    const attestation = ledger.readAttestation()!;
    assert.ok(attestation, "the day's chain must be signed after two appends");

    const chainResult = await browserVerifyChain(records as unknown as Array<Record<string, unknown>>);
    assert.equal(chainResult.ok, true, "the chain the console re-derives must match what was actually written");
    assert.equal(chainResult.chainHead, attestation.chainHead, "the browser's derived head must equal the server's signed head");

    const sigOk = await browserVerifySignature(chainResult.chainHead, attestation.publicKeyPem, attestation.signatureHex);
    assert.equal(sigOk, true, "Web Crypto must accept the real Ed25519 signature over the real chain head");

    // And the negative: a tampered signature must be rejected, not silently accepted.
    const tampered = attestation.signatureHex.slice(0, -1) + (attestation.signatureHex.slice(-1) === "0" ? "1" : "0");
    const tamperedOk = await browserVerifySignature(chainResult.chainHead, attestation.publicKeyPem, tampered);
    assert.equal(tamperedOk, false, "a single flipped hex character must be caught, or verification is theatre");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
