// A halt must outlive the process that declared it.
//
// Gates 09 and 10 halt on two figures the exchange does not report: the day's opening equity and the
// running high-water mark. Governor used to hold both in memory only. That made restarting the
// process a way out of both halts — the fresh baselines re-derive from whatever equity is *left*, so
// an account down 2.9% and blocked comes back up reading 0% and allowed.
//
// That is the worst class of bug this project can have. Every other gate can be argued about; a risk
// layer whose halts are cleared by `Ctrl-C, up-arrow, Enter` is not a risk layer. These tests exist
// to keep that fixed, and each one restarts for real: a second Governor over the same ledger
// directory, with the first thrown away.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger/ledger.ts";
import { ContextBuilder } from "../src/runtime/context.ts";
import { Governor } from "../src/runtime/governor.ts";
import { BinanceUpstream } from "../src/upstream/binance-mcp.ts";
import { DEFAULT_POLICY } from "../src/policy/config.ts";
import { evaluateWrite, type AccountCtx } from "../src/policy/gates.ts";
import { parseOrder } from "../src/policy/surface.ts";

/**
 * An upstream whose account equity the test controls.
 *
 * The whole scenario is "equity fell, then the process restarted", so equity has to be a variable
 * rather than a fixture — a static balance could not tell a recovered baseline from a fresh one.
 */
function upstreamAtEquity(usdt: () => number): BinanceUpstream {
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; params?: { name?: string } };
    const name = body.params?.name;
    const text = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }], isError: false });
    let result: unknown = text({});
    if (name === "spot.tickerPrice") result = text({ symbol: "BTCUSDT", price: "80000.00" });
    else if (name === "spot.getAccount") result = text({ balances: [{ asset: "USDT", free: String(usdt()), locked: "0" }] });
    else if (name === "spot.exchangeInfo") result = text({ symbols: [{ symbol: "BTCUSDT", status: "TRADING" }] });
    else if (name === "spot.depth") {
      result = text({
        bids: Array.from({ length: 50 }, (_, i) => [String(80000 - i), "1.0"]),
        asks: Array.from({ length: 50 }, (_, i) => [String(80001 + i), "1.0"]),
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return new BinanceUpstream({ token: "halt-persistence-test", fetchImpl });
}

const POLICY = { ...DEFAULT_POLICY, symbolAllowlist: ["BTCUSDT"], requireCertifiedStrategy: false };

/** Build a Governor over an existing ledger directory — i.e. simulate a restart. */
function bootGovernor(dir: string, equity: () => number): { governor: Governor; ctx: ContextBuilder } {
  const upstream = upstreamAtEquity(equity);
  const ctx = new ContextBuilder(upstream);
  const governor = new Governor({ upstream, policy: POLICY, ledger: new Ledger(dir), context: ctx });
  return { governor, ctx };
}

function withTempLedger(fn: (dir: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "halt-persist-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "the daily-loss baseline survives a restart",
  withTempLedger(async (dir) => {
    let equity = 1000;

    // Session one: the account is whole, and the day baseline is captured at 1000.
    const first = bootGovernor(dir, () => equity);
    await first.governor.call("spot.newOrder", { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 10 });
    assert.equal(first.ctx.haltBaselines.dayStartEquityUsd, 1000, "session one should baseline at the opening equity");

    // The account loses money, and the process is restarted.
    equity = 900;
    const second = bootGovernor(dir, () => equity);
    const recovered = await second.ctx.account();

    assert.equal(
      recovered.dayStartEquityUsd,
      1000,
      "after a restart the day baseline must still be the day's OPENING equity, not the reduced balance",
    );
    assert.equal(recovered.equityUsd, 900);

    // And the gate must actually halt on it. Asserting the baseline alone would not prove the halt.
    const decision = evaluateWrite(parseOrder("spot.newOrder", { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 10 }), {
      policy: POLICY,
      market: { refPrice: 80000, quoteAgeSec: 1, estSlippagePct: 0.01, symbolTrading: true },
      account: recovered as AccountCtx,
      history: { recent: [], nowMs: Date.now() },
      passports: [],
    });
    const dailyLoss = decision.results.find((g) => g.gate === "09_daily_loss_limit");
    assert.equal(dailyLoss?.passed, false, `gate 09 must still be halted after the restart — got: ${dailyLoss?.detail}`);
    assert.equal(decision.verdict, "BLOCK");
  }),
);

test(
  "the drawdown high-water mark survives a restart",
  withTempLedger(async (dir) => {
    let equity = 2000;

    const first = bootGovernor(dir, () => equity);
    await first.governor.call("spot.newOrder", { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 10 });
    assert.equal(first.ctx.haltBaselines.peakEquityUsd, 2000);

    equity = 1800; // a 10% drawdown from the peak
    const second = bootGovernor(dir, () => equity);
    const recovered = await second.ctx.account();

    assert.equal(recovered.peakEquityUsd, 2000, "the high-water mark must be recovered, not reset to the current equity");

    const decision = evaluateWrite(parseOrder("spot.newOrder", { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 10 }), {
      policy: POLICY,
      market: { refPrice: 80000, quoteAgeSec: 1, estSlippagePct: 0.01, symbolTrading: true },
      account: recovered as AccountCtx,
      history: { recent: [], nowMs: Date.now() },
      passports: [],
    });
    const dd = decision.results.find((g) => g.gate === "10_max_drawdown");
    assert.equal(dd?.passed, false, `gate 10 must still be halted after the restart — got: ${dd?.detail}`);
  }),
);

test(
  "a restart cannot lower a baseline, however many times it is repeated",
  withTempLedger(async (dir) => {
    // The attack this closes is iterative: restart, trade, lose, restart again, each cycle
    // re-baselining lower until the halt is meaningless. One restart proving correct does not prove
    // the fix holds under repetition, because a bug that takes the LAST recorded value rather than
    // the earliest would pass the single-restart test and fail this one.
    let equity = 1000;
    const boot = bootGovernor(dir, () => equity);
    await boot.governor.call("spot.newOrder", { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 10 });

    for (const step of [950, 900, 850, 800]) {
      equity = step;
      const next = bootGovernor(dir, () => equity);
      // A blocked order still writes a record carrying the lower equity — that is the record a naive
      // "last value wins" recovery would latch onto.
      await next.governor.call("spot.newOrder", { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteOrderQty: 10 });
      const acct = await next.ctx.account();
      assert.equal(acct.dayStartEquityUsd, 1000, `day baseline drifted at equity ${step}`);
      assert.equal(acct.peakEquityUsd, 1000, `peak drifted at equity ${step}`);
    }
  }),
);

test(
  "seeding ignores records with no readable equity rather than resetting on them",
  withTempLedger(async (dir) => {
    const ctx = new ContextBuilder(upstreamAtEquity(() => 500));
    const today = new Date().toISOString().slice(0, 10);
    ctx.seedFromLedger([
      { ts: `${today}T00:00:00.000Z`, context: { account: { equityUsd: 1000, dayStartEquityUsd: 1000, peakEquityUsd: 1000 } } },
      { ts: `${today}T01:00:00.000Z`, context: { account: { equityUsd: null, dayStartEquityUsd: null, peakEquityUsd: null } } },
      { ts: `${today}T02:00:00.000Z`, context: undefined },
    ]);
    const { dayStartEquityUsd, peakEquityUsd } = ctx.haltBaselines;
    assert.equal(dayStartEquityUsd, 1000, "an unreadable account is not evidence of a new day");
    assert.equal(peakEquityUsd, 1000, "an unreadable account is not evidence of a new high");
  }),
);

test(
  "yesterday's records set the peak but never today's day baseline",
  withTempLedger(async (dir) => {
    // The two baselines have different scopes and must not be conflated: the drawdown mark is a
    // high-water mark that carries across days, while the daily-loss baseline resets each UTC day.
    // Seeding both from one scan is only correct if the day filter is applied to one and not the other.
    const ctx = new ContextBuilder(upstreamAtEquity(() => 900));
    const nowMs = Date.parse("2026-09-07T12:00:00.000Z");
    ctx.seedFromLedger(
      [
        { ts: "2026-09-06T10:00:00.000Z", context: { account: { equityUsd: 1500, dayStartEquityUsd: 1500, peakEquityUsd: 1500 } } },
        { ts: "2026-09-07T09:00:00.000Z", context: { account: { equityUsd: 1000, dayStartEquityUsd: 1000, peakEquityUsd: 1500 } } },
      ],
      nowMs,
    );
    const { dayStartEquityUsd, peakEquityUsd } = ctx.haltBaselines;
    assert.equal(dayStartEquityUsd, 1000, "today's baseline comes from today's first record, not yesterday's");
    assert.equal(peakEquityUsd, 1500, "the high-water mark carries across the day boundary");
  }),
);

test(
  "a fresh day genuinely re-baselines — recovery must not freeze the halt forever",
  withTempLedger(async (dir) => {
    // The fix must not overshoot. If yesterday's opening equity leaked into today, an account that
    // simply had a bad Tuesday would start Wednesday already halted, and the operator's only recourse
    // would be deleting the ledger — which is exactly the behaviour the fix exists to prevent.
    const ctx = new ContextBuilder(upstreamAtEquity(() => 900));
    const nowMs = Date.parse("2026-09-07T12:00:00.000Z");
    ctx.seedFromLedger([{ ts: "2026-09-06T10:00:00.000Z", context: { account: { equityUsd: 1000, dayStartEquityUsd: 1000, peakEquityUsd: 1000 } } }], nowMs);
    assert.equal(ctx.haltBaselines.dayStartEquityUsd, null, "yesterday's opening equity is not today's baseline");
    assert.equal(ctx.haltBaselines.peakEquityUsd, 1000, "but the high-water mark still carries");
  }),
);
