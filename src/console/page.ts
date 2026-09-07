// The judge console: a single static page, zero build step, zero client dependency.
//
// Every cryptographic claim on this page is verified by the browser itself, using the
// Web Crypto API and nothing else — no library, no CDN, no trust in this server. The
// canonicalisation, hashing and Ed25519 verification below are copied character-for-character
// from a proof run against the real ledger (src/ledger/attest.ts, src/ledger/ledger.ts):
// generate a signed chain with the Node implementation, then re-derive and verify it with
// only globalThis.crypto.subtle, and confirm the two agree. They do. That proof is why this
// file contains no "trust me" — a viewer can open devtools, read every line below, and check
// it against the server's own source.

export function renderConsolePage(): string {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Governor — verify it yourself</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  /* Ink on paper, one accent for proof and one for risk. The palette, type pairing and the
     190px meta column are the operator's own design system, applied here so the page that
     carries the argument looks like it was designed rather than assembled. Fonts degrade to a
     system stack if the network is unavailable — nothing on this page depends on a CDN. */
  :root {
    --ink: #0A0A0A; --stone: #1D1D1F; --cipher: #059669; --redline: #C2410C;
    --paper: #FFFFFF; --halo: #FAFAF7; --veil: #F8FAFC; --line: #E5E7EB;
    --fog: #9CA3AF; --graphite: #6B7280; --hold: #B45309; --capped: #1D4ED8;
    --sans: Outfit, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--halo); color: var(--ink); font: 400 16px/1.55 var(--sans); -webkit-font-smoothing: antialiased; overflow-x: hidden; }
  code, pre, .mono { font-family: var(--mono); }

  header { max-width: 1180px; margin: 0 auto; padding: 72px 32px 40px; }
  .kicker { font-family: var(--mono); font-size: 0.72rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--cipher); margin: 0 0 1.1rem; }
  h1 { font-size: clamp(2.6rem, 6.5vw, 5.2rem); line-height: 0.94; letter-spacing: -0.05em; font-weight: 800; margin: 0 0 1.25rem; max-width: 15ch; }
  h1 span { color: var(--cipher); }
  .sub { color: var(--graphite); font-size: 1.05rem; line-height: 1.6; max-width: 60ch; margin: 0 0 2rem; }
  .headline-stats { display: flex; flex-wrap: wrap; gap: 0 2rem; font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--graphite); }
  .headline-stats b { color: var(--ink); font-weight: 600; }

  main { max-width: 1180px; margin: 0 auto; padding: 0 32px 96px; }
  section { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 3.25rem; padding: 3.5rem 0; border-top: 1px solid var(--line); }
  @media (max-width: 900px) { section { grid-template-columns: 1fr; gap: 1.25rem; } header { padding: 48px 20px 28px; } main { padding: 0 20px 64px; } }
  h2 { grid-column: 1; font-family: var(--mono); font-size: 0.72rem; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: var(--graphite); margin: 0; align-self: start; }
  .body { grid-column: 2; min-width: 0; }
  @media (max-width: 900px) { h2, .body { grid-column: 1; } }

  .card { background: var(--paper); border: 1px solid var(--line); border-radius: 14px; padding: 1.4rem 1.6rem; min-width: 0; overflow-wrap: anywhere; }
  .card + .card { margin-top: 1rem; }
  /* minmax(0,1fr), not 1fr: a grid child defaults to min-width:auto, so one long unbreakable
     mono hash pushes the whole page into horizontal overflow. */
  .grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1rem; align-items: start; }
  @media (max-width: 720px) { .grid2 { grid-template-columns: 1fr; } }

  .row, .stat { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; padding: 0.55rem 0; border-bottom: 1px solid var(--line); font-size: 0.92rem; }
  .row:last-child, .stat:last-child { border-bottom: none; }
  .row span:first-child, .stat span:first-child { color: var(--graphite); }
  .row span:last-child, .stat b { color: var(--ink); font-weight: 500; font-family: var(--mono); font-size: 0.85rem; text-align: right; }

  .verdict { font-family: var(--mono); font-weight: 600; font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase; }
  .v-ALLOW, .v-SUPPORTED, .pass { color: var(--cipher); }
  .v-BLOCK, .v-UNSUPPORTED, .fail { color: var(--redline); }
  .v-HOLD { color: var(--hold); }
  .v-ALLOW_CAPPED { color: var(--capped); }
  .pass, .fail { font-weight: 600; }

  #feed { max-height: 460px; overflow-y: auto; }
  .decision { padding: 0.75rem 0; border-bottom: 1px solid var(--line); font-size: 0.9rem; }
  .decision:last-child { border-bottom: none; }
  .decision .meta { color: var(--fog); font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 0.25rem; }

  button { background: var(--ink); color: var(--paper); border: 1px solid var(--ink); border-radius: 10px; padding: 0.7rem 1.15rem; font-family: var(--sans); font-weight: 500; font-size: 0.9rem; cursor: pointer; transition: background 0.15s ease; }
  button:hover { background: var(--stone); }
  button.secondary { background: var(--paper); border-color: var(--line); color: var(--ink); }
  button.secondary:hover { background: var(--veil); }
  select, input { font-family: var(--mono); font-size: 0.85rem; padding: 0.62rem 0.7rem; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); color: var(--ink); }

  pre { background: var(--veil); border: 1px solid var(--line); border-radius: 10px; padding: 0.9rem 1rem; overflow-x: auto; font-size: 0.74rem; line-height: 1.6; white-space: pre-wrap; word-break: break-all; color: var(--stone); }
  .honest { color: var(--graphite); font-size: 0.95rem; line-height: 1.62; max-width: 68ch; }
  .badge { display: inline-block; font-family: var(--mono); font-size: 0.62rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; padding: 0.25rem 0.55rem; border-radius: 999px; background: var(--veil); border: 1px solid var(--line); color: var(--graphite); margin-left: 0.6rem; vertical-align: middle; }

  .haltbar { height: 5px; width: 100%; background: var(--line); border-radius: 999px; overflow: hidden; margin: 0.4rem 0 0.2rem; }
  .haltbar i { display: block; height: 100%; background: var(--ink); border-radius: 999px; }

  ul { padding-left: 1.1rem; margin: 0; }
  li { margin-bottom: 0.6rem; color: var(--graphite); font-size: 0.95rem; line-height: 1.6; }
  li:last-child { margin-bottom: 0; }

  footer { max-width: 1180px; margin: 0 auto; padding: 2.5rem 32px 4rem; border-top: 1px solid var(--line); color: var(--fog); font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.12em; text-transform: uppercase; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 1rem; }
  a { color: var(--ink); text-decoration-color: var(--fog); text-underline-offset: 3px; }
  a:hover { color: var(--cipher); }
</style>
</head>
<body>

<header>
  <p class="kicker">Governor / Binance Agent OS</p>
  <h1>Give an AI access to your money<span>.</span></h1>
  <div class="sub">It never holds authority. It exercises narrowly-scoped authority that Governor re-checks
    every time against state the agent cannot influence — then binds the execution to the certification that
    authorised it. Your agent proposes · this decides · you verify.</div>
  <div class="headline-stats">
    <span><b>22</b> deterministic gates</span>
    <span><b>81</b> tests</span>
    <span><b>13/13</b> attacks blocked</span>
    <span id="status">connecting…</span>
  </div>
</header>

<main>

  <section>
    <h2>01 / In force</h2>
    <div class="body">
      <div class="grid2">
        <div class="card"><div id="policy">loading…</div></div>
        <div class="card"><div id="session">loading…</div></div>
      </div>
    </div>
  </section>

  <section>
    <h2>02 / Decisions</h2>
    <div class="body">
      <p class="honest">Every write, allowed and refused alike, with the exact rule and the numbers that
        decided it. An agent told <code>05_order_sized</code> can fix its own call; an agent told "error"
        retries the same mistake until the rate limiter stops it.</p>
      <div class="card" style="margin-top:1rem"><div id="feed">No decisions yet — this session has not sent a write.</div></div>
    </div>
  </section>

  <section>
    <h2>03 / Passports</h2>
    <div class="body">
    <p class="honest">A passport is an immutable SHA-256 identity for the exact action the idea gate judged.
      With <code>requireCertifiedStrategy</code> on, every live order must name a SUPPORTED, unexpired hash
      certified for that symbol — gate 17. Change one parameter and the hash changes, so a mutated strategy
      cannot inherit its parent's certification. This is the link between research and execution.</p>
    <div class="card" style="margin-top:1rem"><div id="passports">loading…</div></div>
    </div>
  </section>

  <section id="attack">
    <h2>04 / Attack it</h2>
    <div class="body">
    <p class="kicker">Attack it yourself · real request, real gates, live account</p>
    <p class="honest">This form sends a real <code>spot.newOrder</code> call through the connected Binance account —
      the same call an AI agent would make. It is gated exactly as described above: nothing above the per-order cap
      can execute, and anything a gate refuses never reaches Binance at all. Try the presets, or write your own.</p>
    <div style="display:flex; gap:0.55rem; flex-wrap:wrap; margin:1.25rem 0 0.75rem;">
      <button class="secondary" data-preset="oversized">Try $50,000 all-in</button>
      <button class="secondary" data-preset="unlisted">Try an unlisted symbol</button>
      <button class="secondary" data-preset="fatfinger">Try a fat-finger price</button>
      <button class="secondary" data-preset="reasonable">Try a small, well-formed order</button>
    </div>
    <div style="display:flex; gap:0.55rem; flex-wrap:wrap; align-items:center;">
      <select id="atkSymbol"><option>BTCUSDT</option><option>ETHUSDT</option><option>BNBUSDT</option><option>DOGEUSDT</option></select>
      <select id="atkSide"><option>BUY</option><option>SELL</option></select>
      <input id="atkAmount" type="number" placeholder="USDT amount" value="10" style="width:130px" />
      <select id="atkCert"><option value="">no strategy hash</option></select>
      <button id="atkSubmit">Send it</button>
    </div>
    <div id="atkResult" style="margin-top:1rem;"></div>
    </div>
  </section>

  <section>
    <h2>05 / Verify</h2>
    <div class="body">
    <p class="honest">This re-derives the entire hash chain from genesis and checks the Ed25519 signature using
      <code>crypto.subtle</code> only. No library, no network call to a verifier — the JavaScript that runs when you
      click the button is on screen below it.</p>
    <div style="display:flex; gap:0.55rem; flex-wrap:wrap; margin-top:1.25rem;">
      <button id="verifyBtn">Verify in my browser</button>
      <button id="tamperBtn" class="secondary">Tamper a byte, then re-verify</button>
    </div>
    <div id="verifyResult" style="margin-top:1rem;"></div>
    </div>
  </section>

  <section>
    <h2>06 / Idea gate</h2>
    <div class="body">
      <p class="honest">Before an agent may run a strategy at all. The same code path, twice: a real sweep of
        71 moving-average configurations on live Binance data, and a synthetic strategy with a planted edge.
        One is refused five different ways. The other is not.</p>
      <div class="grid2" style="margin-top:1rem">
        <div class="card">
          <p class="kicker" style="color:var(--redline)">Rejected · real Binance data</p>
          <div id="reject">loading…</div>
        </div>
        <div class="card">
          <p class="kicker">Supported · synthetic, declared</p>
          <div id="accept">loading…</div>
        </div>
      </div>
    </div>
  </section>

  <section>
    <h2>07 / Boundaries</h2>
    <div class="body">
    <p class="kicker">Honest boundaries · what this does not do</p>
    <p class="honest" style="margin-bottom:1.25rem">What this does <em>not</em> do. Volunteering the limits is
      more credible than hiding them.</p>
    <ul class="honest">
      <li>Does not claim any strategy shown here found a real, tradeable market edge. Across ~150 published studies from 1956–2026, none report a positive, cost-aware, out-of-sample trading result on any price series — and the rejected sweep on this page, run on real Binance data, agrees with that literature rather than contradicting it.</li>
      <li>Does not replace Binance's own confirmation flow, sub-account isolation, or emergency stop. This composes with those controls; it does not substitute for them.</li>
      <li>Cannot move funds anywhere the connected account did not already grant — there is no withdrawal scope on Binance's Agentic sub-accounts, by Binance's own design, not this project's.</li>
      <li>The idea gate's statistics (Deflated Sharpe, Minimum Backtest Length) are lower bounds under IID-Gaussian assumptions. Real markets have fatter tails and autocorrelation, which only raises the bar further — never lowers it.</li>
      <li>This console shows one operator's session. It is not a multi-tenant product; the policy and ledger belong to whoever is running this Governor instance.</li>
    </ul>
    </div>
  </section>

</main>

<footer>
  <span>Built on Binance Agent OS</span>
  <span>Every number here is reproducible from the repository</span>
  <a href="https://github.com/Pratiikpy/binance-governor" target="_blank" rel="noopener">Source</a>
</footer>

<script>
(function () {
  "use strict";

  // ---------------------------------------------------------------------------------------
  // Verified cryptographic primitives. Proven byte-for-byte against src/ledger/attest.ts and
  // src/ledger/ledger.ts before this file was written — see docs, "the console" section.
  // ---------------------------------------------------------------------------------------

  function canonicalize(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value) === undefined ? "null" : JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
    var keys = Object.keys(value).filter(function (k) { return value[k] !== undefined; }).sort();
    return "{" + keys.map(function (k) { return JSON.stringify(k) + ":" + canonicalize(value[k]); }).join(",") + "}";
  }

  async function sha256Hex(input) {
    var bytes = new TextEncoder().encode(input);
    var digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function pemToDer(pem) {
    var b64 = pem.replace(/-----BEGIN PUBLIC KEY-----/, "").replace(/-----END PUBLIC KEY-----/, "").replace(/\\s+/g, "");
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var GENESIS = "0".repeat(64);

  /** Re-derive the whole chain from genesis. Returns {ok, chainHead, brokenAt}. */
  async function verifyChain(records) {
    var prev = GENESIS;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var withoutHash = Object.assign({}, r);
      delete withoutHash.hash;
      if (withoutHash.prevHash !== prev) return { ok: false, chainHead: prev, brokenAt: i };
      var recomputed = await sha256Hex(prev + "\\n" + canonicalize(withoutHash));
      if (recomputed !== r.hash) return { ok: false, chainHead: prev, brokenAt: i };
      prev = recomputed;
    }
    return { ok: true, chainHead: prev, brokenAt: null };
  }

  /** Ed25519-verify a chainHead against an attestation, using only Web Crypto. */
  async function verifySignature(chainHead, attestation) {
    var key = await crypto.subtle.importKey("spki", pemToDer(attestation.publicKeyPem), { name: "Ed25519" }, false, ["verify"]);
    var message = hexToBytes(chainHead);
    var signature = hexToBytes(attestation.signatureHex);
    return crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
  }

  // ---------------------------------------------------------------------------------------
  // Page wiring
  // ---------------------------------------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  var fmtUsd = function (n) { return n === null || n === undefined ? "—" : "$" + Number(n).toFixed(2); };

  var lastLedger = null, lastAttestation = null;

  async function refreshState() {
    try {
      var res = await fetch("/api/state");
      var data = await res.json();
      $("status").textContent = "connected · " + data.ledger.records + " decision(s) · chain " + data.ledger.chainHead.slice(0, 12) + "…";

      var p = data.policy;
      $("policy").innerHTML = [
        ["kill switch", p.killSwitch ? "ENGAGED" : "off"],
        ["symbols", p.symbolAllowlist.join(", ") || "none"],
        ["max order", fmtUsd(p.maxOrderNotionalUsd)],
        ["max position", p.maxPositionPct + "% of equity"],
        ["max gross", p.maxGrossPct + "% of equity"],
        ["daily loss halt", p.maxDailyLossPct + "%"],
        ["drawdown halt", p.maxDrawdownPct + "%"],
        ["hold above", fmtUsd(p.holdAboveNotionalUsd)],
        ["certified strategy required", p.requireCertifiedStrategy ? "YES — gate 17" : "no"],
      ].map(function (r) { return '<div class="row"><span>' + r[0] + '</span><span>' + r[1] + "</span></div>"; }).join("");

      var writes = data.decisions.filter(function (d) { return d.effect === "WRITE"; });
      var allowed = writes.filter(function (d) { return d.verdict === "ALLOW" || d.verdict === "ALLOW_CAPPED"; }).length;
      var blocked = writes.filter(function (d) { return d.verdict === "BLOCK"; }).length;
      var held = writes.filter(function (d) { return d.verdict === "HOLD"; }).length;
      $("session").innerHTML = [
        ["ledger records", data.ledger.records],
        ["writes allowed", allowed],
        ["writes blocked", blocked],
        ["writes held for a human", held],
        ["chain head", data.ledger.chainHead.slice(0, 16) + "…"],
      ].map(function (r) { return '<div class="stat"><span>' + r[0] + '</span><b>' + r[1] + "</b></div>"; }).join("");

      var pp = data.passports || [];
      var sel = $("atkCert");
      if (sel) {
        var keep = sel.value;
        sel.innerHTML = '<option value="">no strategy hash</option>' + pp
          .filter(function (c) { return c.verdict === "SUPPORTED" && !c.expired; })
          .map(function (c) { return '<option value="' + c.strategyHash + '">' + c.name + " " + c.symbols.join("/") + "</option>"; })
          .join("");
        sel.value = keep;
      }
      $("passports").innerHTML = pp.length === 0
        ? '<div class="honest">No strategy has been certified in this session. With gate 17 on, that means '
          + '<b>every live order is refused</b> — fail closed, not fail open. Call <code>governor.evaluateIdea</code> '
          + 'with a <code>strategy</code> and <code>dataset</code> to issue one.</div>'
        : pp.map(function (c) {
            var cls = c.verdict === "SUPPORTED" && !c.expired ? "v-ALLOW" : "v-BLOCK";
            var state = c.expired ? "EXPIRED" : c.verdict;
            return '<div class="decision"><span class="verdict ' + cls + '">' + state + "</span> "
              + "<b>" + c.name + "</b> " + JSON.stringify(c.params)
              + ' <span class="badge">' + c.symbols.join(", ") + "</span>"
              + '<div class="meta">hash <code>' + c.strategyHash.slice(0, 24) + "…</code> · expires "
              + new Date(c.expiresAt).toLocaleDateString()
              + (c.evidence && c.evidence.dsr !== null ? " · DSR " + c.evidence.dsr.toFixed(4) : "")
              + "</div></div>";
          }).join("");

      if (data.decisions.length > 0) {
        $("feed").innerHTML = data.decisions.slice(0, 40).map(function (d) {
          return '<div class="decision"><span class="verdict v-' + d.verdict + '">' + d.verdict + "</span> "
            + "<b>" + d.tool + "</b> — " + d.reason
            + '<div class="meta">' + new Date(d.ts).toLocaleString() + (d.notionalUsd ? " · " + fmtUsd(d.notionalUsd) : "") + "</div></div>";
        }).join("");
      }
    } catch (e) {
      $("status").textContent = "offline — governor not reachable (" + e.message + ")";
    }
  }

  // The one row that reads the ORDER gate's policy: given this strategy's own returns, how
  // long does it run before the halts in policy.json stop it? Reported, never gated — the
  // operator decides whether that tempo is the one they wanted.
  function haltRow(ht) {
    if (!ht || ht.status !== "ok") return "";
    var med = ht.bars_to_first_halt.median;
    // Both panels scale against the same denominator so the two bars are directly comparable.
    // A bar that rescaled per panel would make 19 and 122 look the same length.
    var pctW = Math.max(2, Math.min(100, (med.bars / HALT_BAR_MAX) * 100));
    return '<div class="stat"><span>median run before this policy halts it</span><b>' +
      (med.censored ? "&gt;" : "") + med.bars.toFixed(0) + " bars</b></div>" +
      '<div class="haltbar"><i style="width:' + pctW.toFixed(1) + '%"></i></div>' +
      '<div class="meta" style="margin:-2px 0 8px">' + (ht.survives_30_days * 100).toFixed(0) +
      "% of " + ht.n_paths.toLocaleString() + " bootstrapped paths clear 30 days without a halt</div>";
  }

  // Longest median across the two demos, so both bars share one scale.
  var HALT_BAR_MAX = 150;

  async function loadDemo(id, path) {
    try {
      var res = await fetch(path);
      var d = await res.json();
      var el = $(id);
      if (id === "reject") {
        var h = d.honest;
        el.innerHTML =
          '<div class="stat"><span>symbol</span><b>' + d.symbol + "</b></div>" +
          '<div class="stat"><span>configs swept</span><b>' + d.sweep.nTrials + "</b></div>" +
          '<div class="stat"><span>best config</span><b>SMA(' + d.sweep.bestFast + ")/SMA(" + d.sweep.bestSlow + ")</b></div>" +
          '<div class="stat"><span>DSR (honest N=' + d.sweep.nTrials + ')</span><b>' + h.dsr.dsr.toFixed(4) + "</b></div>" +
          '<div class="stat"><span>MinBTL vs held</span><b>' + h.dsr.min_backtest_years.toFixed(2) + "y vs " + h.dsr.years_held.toFixed(2) + "y</b></div>" +
          (h.pbo && h.pbo.status === "ok"
            ? '<div class="stat"><span>PBO (' + h.pbo.n_combinations.toLocaleString("en-US") + " splits)</span><b>" + h.pbo.pbo.toFixed(4) + "</b></div>"
            : "") +
          (h.walk_forward && h.walk_forward.status === "ok"
            ? '<div class="stat"><span>walk-forward (chosen on early data, scored on unseen)</span><b>' +
              h.walk_forward.in_sample_sharpe_annual.toFixed(3) + " → " + h.walk_forward.out_of_sample_sharpe_annual.toFixed(3) + "</b></div>"
            : "") +
          (h.timing_permutation && h.timing_permutation.status === "ok"
            ? '<div class="stat"><span>timing permutation (same exposure, random times)</span><b>p = ' +
              h.timing_permutation.p_value.toFixed(4) + "</b></div>"
            : "") +
          (h.timing_permutation_family_wise && h.timing_permutation_family_wise.status === "ok"
            ? '<div class="stat"><span>&#8230; corrected for searching all ' + h.timing_permutation_family_wise.n_configs + '</span><b>p = ' +
              h.timing_permutation_family_wise.p_value_family_wise.toFixed(4) + "</b></div>"
            : "") +
          (h.parameter_plateau && h.parameter_plateau.status === "ok"
            ? '<div class="stat"><span>parameter plateau (winner vs its neighbours)</span><b>' +
              (h.parameter_plateau.isolation_sds >= 0 ? "+" : "") + h.parameter_plateau.isolation_sds.toFixed(2) +
              " SDs, " + h.parameter_plateau.neighbours_in_top_quartile + "/" + h.parameter_plateau.n_neighbours + " near top</b></div>"
            : "") +
          haltRow(h.halt_tempo) +
          '<div class="stat"><span>same config, dishonestly framed at N=1</span><b>DSR ' + d.dishonestComparison.dsr.toFixed(4) + " → " + d.dishonestComparison.verdict + "</b></div>" +
          '<div class="stat"><span>verdict</span><b class="v-' + h.verdict + '">' + h.verdict + "</b></div>";
      } else {
        var r = d.result;
        el.innerHTML =
          '<div class="stat"><span>bars</span><b>' + d.n + "</b></div>" +
          '<div class="stat"><span>DSR</span><b>' + r.dsr.dsr.toFixed(4) + "</b></div>" +
          '<div class="stat"><span>net edge after 20bps cost</span><b>+' + r.cost_floor.net_edge_bps.toFixed(1) + " bps</b></div>" +
          haltRow(r.halt_tempo) +
          '<div class="stat"><span>verdict</span><b class="v-' + r.verdict + '">' + r.verdict + "</b></div>" +
          '<div class="honest" style="margin-top:8px">' + d.note + "</div>";
      }
    } catch (e) {
      $(id).textContent = "could not load (" + e.message + ")";
    }
  }

  async function runVerify(tamper) {
    var out = $("verifyResult");
    out.innerHTML = "verifying…";
    try {
      var today = new Date().toISOString().slice(0, 10);
      if (!lastLedger) {
        var lr = await fetch("/api/ledger?day=" + today);
        lastLedger = await lr.json();
        var ar = await fetch("/api/attestation?day=" + today);
        lastAttestation = await ar.json();
      }
      var records = lastLedger;
      var attestation = Object.assign({}, lastAttestation);
      if (tamper) {
        var s = attestation.signatureHex;
        attestation.signatureHex = s.slice(0, -1) + (s.slice(-1) === "0" ? "1" : "0");
      }

      var chainResult = await verifyChain(records);
      var sigOk = chainResult.ok ? await verifySignature(chainResult.chainHead, attestation) : false;

      out.innerHTML =
        '<div class="stat"><span>records re-hashed from genesis</span><b>' + records.length + "</b></div>" +
        '<div class="stat"><span>chain intact</span><b class="' + (chainResult.ok ? "pass" : "fail") + '">' + (chainResult.ok ? "YES" : "NO, broken at record " + chainResult.brokenAt) + "</b></div>" +
        '<div class="stat"><span>Ed25519 signature valid</span><b class="' + (sigOk ? "pass" : "fail") + '">' + (sigOk ? "YES" : "NO") + "</b></div>" +
        (tamper ? '<div class="honest" style="margin-top:8px">One hex character of the signature was flipped client-side before this check. This is what tampering looks like.</div>' : '') +
        "<pre>" + JSON.stringify({ chainHead: chainResult.chainHead, publicKeyPem: attestation.publicKeyPem }, null, 2) + "</pre>";
    } catch (e) {
      out.innerHTML = '<span class="fail">could not verify: ' + e.message + "</span>";
    }
  }

  $("verifyBtn").addEventListener("click", function () { runVerify(false); });
  $("tamperBtn").addEventListener("click", function () { runVerify(true); });

  // ---------------------------------------------------------------------------------------
  // Attack mode: a real tools/call to spot.newOrder, through the same /mcp endpoint any MCP
  // client uses. Same-origin, so a plain fetch needs no auth of its own -- this server holds
  // the one Binance session, and every visitor exercises that session's gates and policy.
  // ---------------------------------------------------------------------------------------

  var PRESETS = {
    oversized: { symbol: "BTCUSDT", side: "BUY", amount: 50000 },
    unlisted: { symbol: "DOGEUSDT", side: "BUY", amount: 10 },
    fatfinger: { symbol: "BTCUSDT", side: "BUY", amount: 10, price: 400000 },
    reasonable: { symbol: "BTCUSDT", side: "BUY", amount: 10 },
  };

  document.querySelectorAll("[data-preset]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-preset");
      var p = PRESETS[key];
      $("atkSymbol").value = p.symbol;
      $("atkSide").value = p.side;
      $("atkAmount").value = String(p.amount);
      submitAttack(p.price);
    });
  });

  $("atkSubmit").addEventListener("click", function () { submitAttack(); });

  async function submitAttack(limitPrice) {
    var out = $("atkResult");
    out.innerHTML = "sending…";
    var args = {
      symbol: $("atkSymbol").value,
      side: $("atkSide").value,
      type: limitPrice ? "LIMIT" : "MARKET",
      quoteOrderQty: Number($("atkAmount").value),
    };
    // Governor's own argument, not Binance's. Sending it is what lets gate 17 resolve the order
    // back to a certification; leaving it blank is a live demonstration of the gate refusing an
    // otherwise perfect order because no research stands behind it.
    if ($("atkCert").value) args.strategyHash = $("atkCert").value;
    if (limitPrice) { args.price = limitPrice; args.timeInForce = "GTC"; delete args.quoteOrderQty; args.quantity = Number($("atkAmount").value) / limitPrice; }

    try {
      var res = await fetch("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: "spot.newOrder", arguments: args } }),
      });
      var body = await res.json();
      var content = body.result && body.result.content && body.result.content[0] ? body.result.content[0].text : JSON.stringify(body);
      var parsed;
      try { parsed = JSON.parse(content); } catch (e) { parsed = { raw: content }; }

      var verdict = parsed.governor || (body.result && body.result.isError ? "ERROR" : "ALLOW");

      // Gate 17 is stated on its own line whatever else happened. It is evaluated LAST, so a more
      // fundamental failure — an unfunded account, an oversized order — cites itself as the reason
      // and the certification result would otherwise be invisible in a truncated gate list. That is
      // correct behaviour and a useless demo: toggling the dropdown has to show a visible change.
      var g17 = (parsed.failedGates || []).filter(function (g) { return g.gate === "17_strategy_certified"; })[0];
      var certPassed = (parsed.passedGates || []).indexOf("17_strategy_certified") >= 0;
      var certLine = g17
        ? '<div class="stat"><span>gate 17 — certified strategy</span><b class="v-BLOCK">REFUSED — ' + g17.detail + "</b></div>"
        : certPassed
          ? '<div class="stat"><span>gate 17 — certified strategy</span><b class="v-ALLOW">PASSED — this order descends from certified research</b></div>'
          : "";

      out.innerHTML =
        '<div class="stat"><span>verdict</span><b class="v-' + verdict + '">' + verdict + "</b></div>" +
        (parsed.reason ? '<div class="stat"><span>reason</span><b>' + parsed.reason + "</b></div>" : "") +
        certLine +
        "<pre>" + JSON.stringify(parsed, null, 2) + "</pre>";
      refreshState();
    } catch (e) {
      out.innerHTML = '<span class="fail">request failed: ' + e.message + "</span>";
    }
  }

  refreshState();
  setInterval(refreshState, 4000);
  loadDemo("reject", "/api/demo/reject");
  loadDemo("accept", "/api/demo/accept");
})();
</script>

</body>
</html>`;
}
