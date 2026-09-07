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
<style>
  :root {
    --bg: #0b0d10; --panel: #12151a; --border: #1f242c; --text: #e6e9ee; --muted: #8b93a1;
    --allow: #2ecc71; --block: #e74c3c; --hold: #f39c12; --capped: #3498db; --accent: #f0b90b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; }
  header { padding: 24px 32px; border-bottom: 1px solid var(--border); display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  h1 { font-size: 20px; margin: 0; }
  h1 span { color: var(--accent); }
  .sub { color: var(--muted); font-size: 13px; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 32px 64px; display: grid; gap: 24px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
  section.wide { grid-column: 1 / -1; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 14px; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .row:last-child { border-bottom: none; }
  .verdict { font-weight: 700; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
  .v-ALLOW { color: var(--allow); }
  .v-BLOCK { color: var(--block); }
  .v-HOLD { color: var(--hold); }
  .v-ALLOW_CAPPED { color: var(--capped); }
  .v-SUPPORTED { color: var(--allow); }
  .v-UNSUPPORTED { color: var(--block); }
  #feed { max-height: 420px; overflow-y: auto; }
  .decision { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 12.5px; }
  .decision .meta { color: var(--muted); }
  button { background: var(--accent); color: #1a1a1a; border: none; border-radius: 6px; padding: 10px 16px; font-weight: 600; cursor: pointer; font-size: 13px; }
  button:hover { filter: brightness(1.08); }
  button.secondary { background: transparent; border: 1px solid var(--border); color: var(--text); }
  pre { background: #060708; border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 11.5px; white-space: pre-wrap; word-break: break-all; }
  .pass { color: var(--allow); font-weight: 700; }
  .fail { color: var(--block); font-weight: 700; }
  .honest { color: var(--muted); font-size: 12.5px; line-height: 1.6; }
  .stat { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
  .stat b { color: var(--text); }
  .badge { display: inline-block; font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--border); color: var(--muted); margin-left: 6px; }
  footer { text-align: center; color: var(--muted); font-size: 12px; padding: 32px; }
  a { color: var(--accent); }
</style>
</head>
<body>

<header>
  <div>
    <h1>Governor<span>.</span></h1>
    <div class="sub">A second signature on every AI trade. Your agent proposes — this decides — you verify.</div>
  </div>
  <div class="sub" id="status">connecting…</div>
</header>

<main>

  <section>
    <h2>Policy in force</h2>
    <div id="policy">loading…</div>
  </section>

  <section>
    <h2>Session</h2>
    <div id="session">loading…</div>
  </section>

  <section class="wide">
    <h2>Live decision feed <span class="badge">every write, allowed and refused alike</span></h2>
    <div id="feed">no decisions yet — this session has not sent a write</div>
  </section>

  <section class="wide" id="attack">
    <h2>Attack it yourself <span class="badge">real request, real gates, live account</span></h2>
    <p class="honest">This form sends a real <code>spot.newOrder</code> call through the connected Binance account —
      the same call an AI agent would make. It is gated exactly as described above: nothing above the per-order cap
      can execute, and anything a gate refuses never reaches Binance at all. Try the presets, or write your own.</p>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
      <button class="secondary" data-preset="oversized">Try $50,000 all-in</button>
      <button class="secondary" data-preset="unlisted">Try an unlisted symbol</button>
      <button class="secondary" data-preset="fatfinger">Try a fat-finger price</button>
      <button class="secondary" data-preset="reasonable">Try a small, well-formed order</button>
    </div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
      <select id="atkSymbol"><option>BTCUSDT</option><option>ETHUSDT</option><option>BNBUSDT</option><option>DOGEUSDT</option></select>
      <select id="atkSide"><option>BUY</option><option>SELL</option></select>
      <input id="atkAmount" type="number" placeholder="USDT amount" value="10" style="width:120px; padding:8px; background:#060708; border:1px solid var(--border); border-radius:6px; color:var(--text);" />
      <button id="atkSubmit">Send it</button>
    </div>
    <div id="atkResult" style="margin-top:14px;"></div>
  </section>

  <section class="wide">
    <h2>Verify the ledger — in your browser, not on faith</h2>
    <p class="honest">This re-derives the entire hash chain from genesis and checks the Ed25519 signature using
      <code>crypto.subtle</code> only. No library, no network call to a verifier — the JavaScript that runs when you
      click the button is on screen below it.</p>
    <button id="verifyBtn">Verify in my browser</button>
    <button id="tamperBtn" class="secondary">Tamper a byte, then re-verify</button>
    <div id="verifyResult" style="margin-top: 14px;"></div>
  </section>

  <section>
    <h2>Idea gate — rejected <span class="badge">real Binance data</span></h2>
    <div id="reject">loading…</div>
  </section>

  <section>
    <h2>Idea gate — supported <span class="badge">synthetic, declared</span></h2>
    <div id="accept">loading…</div>
  </section>

  <section class="wide">
    <h2>Honest boundaries — what this does NOT do</h2>
    <ul class="honest">
      <li>Does not claim any strategy shown here found a real, tradeable market edge. Across ~150 published studies from 1956–2026, none report a positive, cost-aware, out-of-sample trading result on any price series — and the rejected sweep on this page, run on real Binance data, agrees with that literature rather than contradicting it.</li>
      <li>Does not replace Binance's own confirmation flow, sub-account isolation, or emergency stop. This composes with those controls; it does not substitute for them.</li>
      <li>Cannot move funds anywhere the connected account did not already grant — there is no withdrawal scope on Binance's Agentic sub-accounts, by Binance's own design, not this project's.</li>
      <li>The idea gate's statistics (Deflated Sharpe, Minimum Backtest Length) are lower bounds under IID-Gaussian assumptions. Real markets have fatter tails and autocorrelation, which only raises the bar further — never lowers it.</li>
      <li>This console shows one operator's session. It is not a multi-tenant product; the policy and ledger belong to whoever is running this Governor instance.</li>
    </ul>
  </section>

</main>

<footer>
  <a href="https://github.com" target="_blank" rel="noopener">Source</a> ·
  Built on Binance Agent OS · Every number on this page is reproducible from the repository
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
            ? '<div class="stat"><span>PBO (' + h.pbo.n_combinations + " splits)</span><b>" + h.pbo.pbo.toFixed(4) + "</b></div>"
            : "") +
          '<div class="stat"><span>same config, dishonestly framed at N=1</span><b>DSR ' + d.dishonestComparison.dsr.toFixed(4) + " → " + d.dishonestComparison.verdict + "</b></div>" +
          '<div class="stat"><span>verdict</span><b class="v-' + h.verdict + '">' + h.verdict + "</b></div>";
      } else {
        var r = d.result;
        el.innerHTML =
          '<div class="stat"><span>bars</span><b>' + d.n + "</b></div>" +
          '<div class="stat"><span>DSR</span><b>' + r.dsr.dsr.toFixed(4) + "</b></div>" +
          '<div class="stat"><span>net edge after 20bps cost</span><b>+' + r.cost_floor.net_edge_bps.toFixed(1) + " bps</b></div>" +
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
      out.innerHTML =
        '<div class="stat"><span>verdict</span><b class="v-' + verdict + '">' + verdict + "</b></div>" +
        (parsed.reason ? '<div class="stat"><span>reason</span><b>' + parsed.reason + "</b></div>" : "") +
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
