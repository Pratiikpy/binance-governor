---
name: binance-governor
description: A policy-gated proxy for the Binance MCP Server. Every write an agent proposes — orders, cancels, transfers — passes a deterministic risk engine, is validated by Binance's own spot.orderTest, and is recorded to a hash-chained Ed25519-signed ledger before it reaches Binance. Includes a statistical idea gate (Deflated Sharpe Ratio, Minimum Backtest Length) that checks whether a strategy is even supported by its own backtest before it is allowed to run live. Use this skill whenever an agent needs guardrails and an audit trail around real trading, or needs to check whether a strategy's backtest actually clears real transaction costs.
metadata:
  version: 0.1.0
  author: Pratiikpy
license: MIT
---

# Binance Governor

A second signature on every AI trade. Your agent proposes — Governor decides — you verify.

## What this is

Governor is a local MCP server that sits between your AI agent and the Binance MCP Server
(`https://agent.binance.com/mcp/agentic`). It re-exposes every tool Binance offers — nothing an
agent could do before becomes impossible — but every **write** (an order, a cancel, an internal
transfer) is checked against a deterministic policy before it reaches Binance:

- Per-order notional cap, position and gross exposure limits, a daily loss halt, a drawdown halt
- Symbol allowlist, order rate limiting, per-symbol cooldown, duplicate-instruction detection
- A fat-finger price check and a slippage estimate walked against the live order book
- Validation by **Binance's own `spot.orderTest`** before anything is actually sent
- Every decision — allowed and refused — appended to a hash-chained, Ed25519-signed ledger

It also exposes `governor.evaluateIdea`: before running a strategy live, an agent can check whether
the strategy is statistically supported at all, using the Deflated Sharpe Ratio and Minimum Backtest
Length (Bailey & López de Prado) against this account's real trading costs — not an opinion, a
computation.

Full source, architecture, and a live demo of the idea gate on real Binance data:
https://github.com/Pratiikpy/binance-governor

## When to use this skill

Use this whenever your task involves an AI agent placing real orders on Binance and you want a
deterministic, auditable safety layer between the agent's decision and the exchange — or whenever
you want to sanity-check a trading strategy's backtest before trusting it.

## Setup

Requires Node.js 22+ and Python 3.11+ (for the idea gate's statistics — numpy and scipy).

```bash
git clone https://github.com/Pratiikpy/binance-governor
cd binance-governor
npm install
claude mcp login binance-mcp-server   # authenticate once, same as connecting directly to Binance
npm run governor                       # starts Governor at http://127.0.0.1:8787
```

Then connect your agent to Governor **instead of** Binance's MCP server directly:

```bash
claude mcp add binance-governor --transport http http://127.0.0.1:8787/mcp
```

Every tool Binance's MCP server offers is still available through this connection. Reads pass
through untouched; writes are gated as described above.

## Usage

Ask your agent to trade as you normally would — "buy $10 of BNB on spot," "check my balance," "cancel
my open orders." Reads happen immediately. A write that clears every gate is restated and sent; a
write that fails a gate returns a structured refusal naming the exact rule and the numbers involved,
so the agent can correct the call rather than retry blindly:

```
Buy $50,000 of BTC on spot.
```
```json
{
  "governor": "BLOCK",
  "reason": "06_max_order_notional: $50000.00 (max $25.00)",
  "hint": "The order was not sent to Binance. Adjust it to satisfy the failed gate, or change the policy deliberately."
}
```

Before trusting a backtested strategy, ask the agent to run it through the idea gate:

```
Check whether this strategy is statistically supported: [paste per-bar returns], tried 71
configurations before landing on this one, claimed edge 12 bps per round trip.
```

The gate computes the Deflated Sharpe Ratio, Minimum Backtest Length, and a real cost-floor check
against Binance's live commission schedule, and returns `SUPPORTED` or `UNSUPPORTED` with the exact
arithmetic. Most strategies come back `UNSUPPORTED` — that is the correct, honest answer far more
often than not, and this gate is designed to say so rather than flatter a backtest.

## Configuration

Governor's default policy locks trading to BTCUSDT/ETHUSDT/BNBUSDT with a $25 per-order cap. Drop a
`policy.json` in the working directory to change limits — see the repository README for the full
schema. A malformed policy file is rejected outright rather than silently falling back to a default.

## Verify it

`npm run verify` runs a full test suite (76 tests covering every gate, the idea gate's statistics,
and the ledger's cryptography) plus an adversarial release audit that fires 13 realistic attacks —
an all-in order, an unlisted symbol, a fat-finger price, a malformed order, a retry-loop duplicate, an order-rate flood, a poisoned tool result, a poisoned tool description, an upstream schema rug-pull, a strategy substitution, an order capped between approval and execution, a tool that is not in the catalogue, and an agent chasing yield on an unvetted DeFi protocol — through the real Governor and fails if even one gets through.

The included console (`http://127.0.0.1:8787`) lets you re-derive and verify the entire signed ledger
in your own browser, using nothing but the Web Crypto API — no library, no trust required.

## Security

Governor never stores or requests a Binance API key. It reads the OAuth token your MCP client
already obtained from Binance (via Claude Code's own credential store, or `BINANCE_MCP_TOKEN` if set
explicitly) and uses only that. There is no withdrawal scope on Binance's Agentic sub-accounts — by
Binance's own design — so nothing this skill does can move funds off the exchange.
