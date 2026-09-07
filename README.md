# Governor

**A second signature on every AI trade. Your agent proposes — this decides — you verify.**

Built for the [Binance Agent OS Mini Hackathon](https://x.com/binance/status/2094810011557838988), Track A.

Governor is an MCP server that sits in front of Binance's own Agent OS MCP server. Every read your
agent makes passes straight through, unchanged. Every *write* — every order, cancel, or transfer —
clears a deterministic policy engine first, is validated by **Binance's own `spot.orderTest`**, and
lands in a hash-chained, Ed25519-signed ledger before it ever reaches the exchange. And before an
agent is allowed to run a strategy at all, a second gate asks whether the strategy is statistically
supported — using Bailey & López de Prado's own Deflated Sharpe Ratio and Minimum Backtest Length
math, not an opinion.

```bash
npm install
claude mcp login binance-mcp-server        # authenticate once against Binance Agent OS
npm run governor                            # starts Governor at http://127.0.0.1:8787
```

Not using Claude Code? Governor needs a Binance Agent OS OAuth token by any route — authenticate
Binance's MCP server in whichever client you use ([Binance's own setup guide](https://developers.binance.com/docs/agent-native/mcp-server/agentic)
covers Cursor, Codex, ChatGPT and VS Code), then hand Governor the token directly:

```bash
BINANCE_MCP_TOKEN=<your token> npm run governor
```

Run `npm run doctor` first if anything looks wrong — it checks your Node version, Python + numpy/scipy
(needed by the idea gate), your policy file, and whether a Binance credential is actually reachable.

Open `http://127.0.0.1:8787` in a browser. That page **is** the product — live decisions, a form to
attack it yourself, and a button that re-derives and verifies the entire signed ledger using nothing
but your browser's own Web Crypto API.

---

## Why this exists

Binance's own MCP documentation says the agent "can make mistakes, act on outdated or hallucinated
information, or send incorrect parameters." What ships against that: per-action confirmation,
no-withdrawal, sub-account isolation, and an emergency stop. That is a blast-radius limiter, not a
risk system. Nothing stops an agent from proposing a strategy with no statistical basis, or an order
that is merely small enough to sneak under the radar.

Two things make this a real gap rather than a hunch. Binance's own **Agentic Wallet** already
enforces daily limits and token scope at the API level on the on-chain side — the exchange side has
no equivalent. And Binance's own landing page sells **CONTROL** as one of three pillars: *"set the
permissions, accounts, and limits for each agent."* Governor is that pillar, built.

## What it actually does

### The order gate — 16 deterministic checks, fail-closed

Kill switch, symbol allow/deny list, symbol trading status, quote freshness, order sizing, per-order
notional cap, position-to-equity ratio, gross exposure, daily loss halt, drawdown halt, order rate
limit, per-symbol cooldown, duplicate-instruction detection, fat-finger price sanity, live order-book
slippage estimate, and net-edge-after-fees. Every gate runs; the verdict is `ALLOW`, `ALLOW_CAPPED`,
`HOLD`, or `BLOCK`, with the exact rule and numbers that decided it. An internal error is treated as a
`BLOCK`, never a silent pass.

Before a write is sent, Binance's own `spot.orderTest` validates it against the exchange's real
filters — lot size, minimum notional, tick size, permissions. Governor never asserts a fill it hasn't
earned from Binance itself.

### The idea gate — can this strategy survive costs at all?

Before an agent may run a strategy live, `governor.evaluateIdea` computes:

- **Deflated Sharpe Ratio** — is the observed Sharpe better than what a search this wide would
  produce from pure noise? (Bailey & López de Prado, 2014)
- **Minimum Backtest Length** — how many years of data would actually be needed to support this
  Sharpe at this many trials? (Bailey, Borwein, López de Prado & Zhu, 2014)
- **Probability of Backtest Overfitting** — across every symmetric split of the sample, how often
  does the in-sample winner land *below* the out-of-sample median? This asks a different question
  from DSR: not "is this Sharpe real" but "is my selection procedure adding value, or picking
  noise?" (Bailey, Borwein, López de Prado & Zhu, 2015)
- **Cost floor** — does the claimed edge survive this account's real Binance spot commission
  (10 bps maker, 10 bps taker — 20 bps round trip, read live from the account)?
- **Effective breadth** — across correlated symbols, how many genuinely independent bets does the
  book actually hold?

This math is vendored from a research library built independently of this hackathon (see
[Provenance](#provenance)), not written for this submission, and it is honest about what it usually
finds: **most strategies fail.** That is not a limitation of the gate — across roughly 150 published
studies from 1956 to 2026, none report a positive, cost-aware, out-of-sample trading result on any
price series. A gate that always says yes would be lying.

### Proof the demo pair is real, not staged

`npm run demo:reject` fetches **live BTCUSDT daily klines from Binance**, sweeps 71 real fast/slow
moving-average combinations — exactly what a builder actually does before shipping "the" strategy —
and asks the idea gate about the best one:

| | |
|---|---|
| Configurations swept | 71 |
| Best config found | SMA(5)/SMA(40) |
| DSR, honestly counting all 71 trials | **0.9558** |
| Minimum backtest length required | **4.18 years** |
| Data actually held | **4.00 years** |
| PBO, across 12,870 symmetric splits | **0.5702** — the in-sample winner lands below the out-of-sample median 57% of the time |
| Verdict | **UNSUPPORTED** |
| Same config, dishonestly declared as `n_trials=1` | DSR 0.9912 → **SUPPORTED** |

The strategy fails by about four weeks of data, and only because the trial count was counted
honestly. Same data, same "best" strategy — the only thing that changed is telling the truth about
how hard the search was.

`npm run demo:accept` runs a synthetic strategy with a planted, genuine edge through the **identical
code path** and gets `SUPPORTED` — proof the gate can say yes when a strategy actually earns it, not
just that it always says no.

### The ledger — verify it yourself, not on faith

Every decision — allowed and refused alike — is appended to a day's JSONL file with a SHA-256 hash
chained to the previous record, and the chain's head is Ed25519-signed after every write. The console
page re-derives that whole chain and checks the signature using nothing but `crypto.subtle` — no
library, no server-side trust. Click "Tamper a byte, then re-verify" and watch a single flipped hex
character get caught.

## Try it yourself

The console at `http://127.0.0.1:8787` has an **Attack it yourself** panel: preset buttons for a
$50,000 all-in order, an unlisted symbol, a fat-finger limit price, and a well-formed small order —
or write your own. Every attempt is a real `spot.newOrder` call through the connected Binance
account, gated exactly as described above. Nothing above the per-order cap can execute, and anything
a gate refuses never reaches Binance at all.

## Architecture

```
  Claude Code / Cursor / Codex / ChatGPT / any MCP client
                       │
                       ▼
      Governor MCP server  (this repo, http://127.0.0.1:8787/mcp)
                       │
     read?  ───────────┼──────────── write?
      │                                │
      ▼                                ▼
  pass straight through      16-gate policy engine (fail-closed)
                                        │
                              Binance spot.orderTest (external validation)
                                        │
                              hash-chained, Ed25519-signed ledger
                                        │
                                        ▼
                          agent.binance.com/mcp/agentic (Binance's real MCP server)
                                        │
                                        ▼
                              your Binance Agentic sub-account
```

Governor never holds Binance credentials of its own — it authenticates through the same OAuth 2.1
session your MCP client already establishes with Binance (`claude mcp login binance-mcp-server`), and
reads the resulting token from Claude Code's own credential store, or from `BINANCE_MCP_TOKEN` if set
explicitly. There is no withdrawal scope on Binance's Agentic sub-accounts — by Binance's own design,
not this project's — so nothing here can ever move funds off the exchange.

## Configuration

Drop a `policy.json` in the project root to override the defaults (locked-down: `BTCUSDT`, `ETHUSDT`,
`BNBUSDT` only, $25 max order, 3% daily loss halt, 5% drawdown halt). An invalid or misspelled field
is rejected outright — a typo in a risk limit silently reverting to a default is exactly the failure
this project exists to prevent. Run `npm run doctor` any time to check your environment (Node
version, Python + numpy/scipy for the idea gate, policy validity, Binance credential, kline cache).

## Verify it

```bash
npm run verify
```

One command: a full TypeScript typecheck, 41 automated tests (every gate proven to fire *and* proven
not to fire one tick inside its own limit, the idea gate proven against real vendored statistics, the
ledger's tamper-detection proven with real cryptography), and an adversarial release audit that fires
six realistic attacks — an all-in order, an unlisted symbol, a fat-finger price, a malformed order, a
retry-loop duplicate, and an order-rate flood — through the real Governor and fails the build if even
one of them gets through.

## Honest boundaries

- Does not claim any strategy shown here found a real, tradeable market edge. The rejected sweep
  demo runs on real Binance data and agrees with the published literature rather than contradicting
  it.
- Does not replace Binance's own confirmation flow, sub-account isolation, or emergency stop — it
  composes with those controls, never substitutes for them.
- Cannot move funds anywhere the connected account did not already grant. There is no withdrawal
  scope on Binance's Agentic sub-accounts.
- The idea gate's statistics are lower bounds under IID-Gaussian assumptions. Real markets have
  fatter tails and autocorrelation, which only raises the bar further.
- This is one operator's session, not a multi-tenant product. The policy and ledger belong to
  whoever is running the Governor instance.

## Provenance

The gate architecture (fail-closed evaluation, `ALLOW`/`ALLOW_CAPPED`/`HOLD`/`BLOCK` verdicts,
hash-chained signed ledger, in-browser Web Crypto verification) draws on patterns from the author's
own prior, independently-built risk-gating projects. The idea gate's statistics
(`idea-gate/vendor/deflated_sharpe.py`, `breadth.py`, `cost_model.py`, `fees.py`, `impact.py`,
`_linalg.py`) are vendored, not rewritten, from the author's own research library implementing
Bailey & López de Prado's published formulas — built and tested independently of this hackathon, and
carried in unmodified except for `binance_spot.py`, a small addition supplying this account's actual
Binance spot commission schedule (10 bps / 10 bps), since every fee schedule in the vendored library
was calibrated for perpetual futures, not spot.

## Repository layout

```
src/
  upstream/binance-mcp.ts     Client for Binance's own MCP server (OAuth 2.1, META-mode discovery)
  policy/                     The write-surface allowlist, the policy schema, the 16 gates
  runtime/                    Governor (gate → orderTest → forward → ledger), live context builder
  ledger/                     Hash-chained, Ed25519-signed append-only ledger
  idea-gate/                  TypeScript bridge to the vendored Python statistics
  proxy/server.ts             The MCP server + console HTTP server
  console/page.ts             The judge-facing page — live feed, attack mode, in-browser verify
  data/binance-klines.ts      Real Binance spot kline fetcher, disk-cached
  ops/                        doctor.ts (environment check), release-audit.ts (adversarial gate)
idea-gate/
  gate.py                     The idea gate CLI (stdin JSON → stdout JSON)
  vendor/                     Vendored Bailey & López de Prado statistics (see Provenance)
scripts/
  demo-reject.ts               The honest-sweep demo, on real Binance data
  demo-accept.ts                The planted-edge demo, through the identical code path
test/                          41 tests: gates, ledger crypto, idea gate, console verification
```

## License

MIT. See [LICENSE](./LICENSE).
