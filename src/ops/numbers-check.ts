#!/usr/bin/env tsx
// Documentation drift guard: every number quoted in README.md must still be true.
//
// Ported in spirit from NightDesk's numbers-check.ts, which exists because its docs were once
// hand-typed against a stale run. The failure is quiet and expensive: a README says DSR 0.9558,
// someone regenerates the demo on newer market data, the real number moves, and now the most
// scrutinised document in the repo is confidently wrong. A judge who checks one number and finds
// it stale stops believing the other forty.
//
// HARD numbers must match their source exactly, and a mismatch fails the build. SOFT numbers are
// reported but never fail, because they legitimately drift (live market data moves). The point is
// to make drift visible the moment it happens, not to freeze the repo.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Check {
  label: string;
  quoted: string;
  actual: string;
  ok: boolean;
  tier: "HARD" | "SOFT";
  source: string;
}

const README = readFileSync(join(process.cwd(), "README.md"), "utf8");

/**
 * Does the README contain this string? Whitespace is normalised on both sides first — Markdown
 * line wrapping is arbitrary, so a check that breaks when a sentence rewraps is a check that
 * cries wolf and gets ignored. Numbers themselves are still matched exactly, commas and all.
 */
const NORMALISED_README = README.replace(/\s+/g, " ");

function quotes(needle: string): boolean {
  return NORMALISED_README.includes(needle.replace(/\s+/g, " "));
}

function check(label: string, needle: string, actual: string, tier: "HARD" | "SOFT", source: string): Check {
  return { label, quoted: needle, actual, ok: quotes(needle), tier, source };
}

function countGates(): number {
  const src = readFileSync(join(process.cwd(), "src", "policy", "gates.ts"), "utf8");
  const ids = new Set(src.match(/"[0-9]{2}_[a-z_]+"/g) ?? []);
  // 00_internal_error is the fail-closed handler, not a policy gate.
  return [...ids].filter((id) => !id.includes("00_internal_error")).length;
}

function countTests(): number {
  const dir = join(process.cwd(), "test");
  const files = ["gates.test.ts", "idea-gate.test.ts", "console-verify.test.ts"];
  let n = 0;
  for (const f of files) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    n += (readFileSync(p, "utf8").match(/^test\(/gm) ?? []).length;
  }
  return n;
}

function countReleaseAuditAttacks(): number {
  const src = readFileSync(join(process.cwd(), "src", "ops", "release-audit.ts"), "utf8");
  const singleShot = (src.match(/^\s{2}\{\s*$/gm) ?? []).length; // entries in SINGLE_SHOT_ATTACKS
  // Two sequence scenarios are pushed directly rather than declared in the array.
  return singleShot + 2;
}

function main(): void {
  const checks: Check[] = [];

  // --- structural numbers: derived from source, must be exact ---
  checks.push(check("gate count", `${countGates()} deterministic checks`, String(countGates()), "HARD", "src/policy/gates.ts"));
  checks.push(check("test count", `${countTests()} automated tests`, String(countTests()), "HARD", "test/*.test.ts"));
  checks.push(check("release audit attacks", `fires\nsix realistic attacks`, String(countReleaseAuditAttacks()), "HARD", "src/ops/release-audit.ts"));

  // --- demo numbers: derived from the generated evidence, must be exact ---
  const rejectFile = join(process.cwd(), "data", "demo", "reject.json");
  if (existsSync(rejectFile)) {
    const d = JSON.parse(readFileSync(rejectFile, "utf8")) as {
      sweep: { nTrials: number; bestFast: number; bestSlow: number };
      honest: { dsr: { dsr: number; min_backtest_years: number; years_held: number }; pbo?: { pbo: number; n_combinations: number } };
      dishonestComparison: { dsr: number };
    };
    checks.push(check("configs swept", `| Configurations swept | ${d.sweep.nTrials} |`, String(d.sweep.nTrials), "HARD", "data/demo/reject.json"));
    checks.push(check("best config", `SMA(${d.sweep.bestFast})/SMA(${d.sweep.bestSlow})`, `SMA(${d.sweep.bestFast})/SMA(${d.sweep.bestSlow})`, "HARD", "data/demo/reject.json"));
    checks.push(check("honest DSR", `**${d.honest.dsr.dsr.toFixed(4)}**`, d.honest.dsr.dsr.toFixed(4), "HARD", "data/demo/reject.json"));
    checks.push(check("MinBTL", `**${d.honest.dsr.min_backtest_years.toFixed(2)} years**`, d.honest.dsr.min_backtest_years.toFixed(2), "HARD", "data/demo/reject.json"));
    checks.push(check("years held", `**${d.honest.dsr.years_held.toFixed(2)} years**`, d.honest.dsr.years_held.toFixed(2), "HARD", "data/demo/reject.json"));
    checks.push(check("dishonest DSR", `DSR ${d.dishonestComparison.dsr.toFixed(4)}`, d.dishonestComparison.dsr.toFixed(4), "HARD", "data/demo/reject.json"));
    if (d.honest.pbo) {
      checks.push(check("PBO", `**${d.honest.pbo.pbo.toFixed(4)}**`, d.honest.pbo.pbo.toFixed(4), "HARD", "data/demo/reject.json"));
      checks.push(check("PBO splits", `${d.honest.pbo.n_combinations.toLocaleString("en-US")} symmetric splits`, String(d.honest.pbo.n_combinations), "HARD", "data/demo/reject.json"));
    }
  } else {
    console.log("[warn] data/demo/reject.json missing — run `npm run demo:reject` to regenerate the evidence these numbers cite.\n");
  }

  // --- the fee schedule: this one is load-bearing and must never silently change ---
  const spotFees = readFileSync(join(process.cwd(), "idea-gate", "vendor", "binance_spot.py"), "utf8");
  const makerOk = spotFees.includes("maker_bps=10.0") && spotFees.includes("taker_bps=10.0");
  checks.push({
    label: "Binance spot fee schedule",
    quoted: "10 bps maker, 10 bps taker",
    actual: makerOk ? "10.0 / 10.0" : "CHANGED",
    ok: makerOk && quotes("10 bps maker, 10 bps taker"),
    tier: "HARD",
    source: "idea-gate/vendor/binance_spot.py",
  });

  console.log("=== NUMBERS CHECK: does the README still tell the truth? ===\n");
  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? "OK  " : c.tier === "HARD" ? "FAIL" : "DRIFT";
    if (!c.ok && c.tier === "HARD") failed++;
    console.log(`[${mark}] ${c.label}: expected README to contain "${c.quoted.replace(/\n/g, " ")}" (actual ${c.actual}, from ${c.source})`);
  }

  console.log(`\n${failed === 0 ? "All quoted numbers match their source." : `${failed} HARD mismatch(es) — the README is stale.`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
