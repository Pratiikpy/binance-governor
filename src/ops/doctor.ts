#!/usr/bin/env tsx
// Environment sanity check — run before anything else, especially before a demo. Checks the
// things that fail silently and expensively otherwise: the wrong Node version, Python missing
// so the idea gate falls back to "unavailable" without saying why, a malformed policy file, or
// no Binance credential at all. None of this touches the network or Binance.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parsePolicy } from "../policy/config.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function checkNodeVersion(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  return { name: "Node.js version", ok: major >= 22, detail: `${process.version} (need >= 22.0.0)` };
}

function checkPython(): Check {
  try {
    const out = execFileSync("python", ["--version"], { encoding: "utf8" }).trim();
    return { name: "Python", ok: true, detail: out };
  } catch {
    try {
      const out = execFileSync("python3", ["--version"], { encoding: "utf8" }).trim();
      return { name: "Python", ok: true, detail: `${out} (as python3 -- set PYTHONBIN or ensure "python" resolves on PATH for the idea gate)` };
    } catch {
      return { name: "Python", ok: false, detail: "not found on PATH — governor.evaluateIdea will be unavailable" };
    }
  }
}

function checkNumpyScipy(): Check {
  try {
    execFileSync("python", ["-c", "import numpy, scipy"], { encoding: "utf8" });
    return { name: "numpy + scipy", ok: true, detail: "importable" };
  } catch (err) {
    return { name: "numpy + scipy", ok: false, detail: `not importable — the idea gate cannot run: ${String(err).slice(0, 200)}` };
  }
}

function checkIdeaGateVendor(): Check {
  const required = ["deflated_sharpe.py", "breadth.py", "_linalg.py", "cost_model.py", "fees.py", "impact.py", "binance_spot.py"];
  const dir = join(process.cwd(), "idea-gate", "vendor");
  const missing = required.filter((f) => !existsSync(join(dir, f)));
  return { name: "idea gate vendored math", ok: missing.length === 0, detail: missing.length === 0 ? `all ${required.length} files present` : `missing: ${missing.join(", ")}` };
}

function checkPolicyFile(): Check {
  const file = process.env["GOVERNOR_POLICY"] ?? "policy.json";
  if (!existsSync(file)) return { name: "policy.json", ok: true, detail: "not present — defaults will be used (a locked-down starting policy, symbols BTCUSDT/ETHUSDT/BNBUSDT, $25 max order)" };
  try {
    const parsed = parsePolicy(JSON.parse(readFileSync(file, "utf8")));
    return { name: "policy.json", ok: true, detail: `valid — ${parsed.symbolAllowlist.length} symbol(s) allowed, max order $${parsed.maxOrderNotionalUsd}` };
  } catch (err) {
    return { name: "policy.json", ok: false, detail: `INVALID — the server will refuse to start: ${String(err)}` };
  }
}

function checkBinanceCredential(): Check {
  if (process.env["BINANCE_MCP_TOKEN"]) return { name: "Binance credential", ok: true, detail: "BINANCE_MCP_TOKEN is set" };
  const credFile = join(homedir(), ".claude", ".credentials.json");
  if (!existsSync(credFile)) return { name: "Binance credential", ok: false, detail: `no BINANCE_MCP_TOKEN and no ${credFile} — run: claude mcp login binance-mcp-server` };
  try {
    const parsed = JSON.parse(readFileSync(credFile, "utf8")) as { mcpOAuth?: Record<string, { serverUrl?: string; accessToken?: string; expiresAt?: number }> };
    const entry = Object.values(parsed.mcpOAuth ?? {}).find((e) => e.serverUrl === "https://agent.binance.com/mcp/agentic");
    if (!entry?.accessToken) return { name: "Binance credential", ok: false, detail: "credentials file exists but has no Binance MCP token — run: claude mcp login binance-mcp-server" };
    const expiresIn = entry.expiresAt ? Math.round((entry.expiresAt - Date.now()) / 1000 / 3600) : null;
    return { name: "Binance credential", ok: true, detail: expiresIn !== null ? `found, expires in ~${expiresIn}h` : "found" };
  } catch {
    return { name: "Binance credential", ok: false, detail: "credentials file is not valid JSON" };
  }
}

function checkKlineCache(): Check {
  const file = join(process.cwd(), "data", "klines", "BTCUSDT-1d.jsonl");
  if (!existsSync(file)) return { name: "kline cache", ok: true, detail: "empty — will fetch from Binance on first use" };
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  return { name: "kline cache", ok: true, detail: `${lines} cached bar(s)` };
}

function main(): void {
  const checks = [checkNodeVersion(), checkPython(), checkNumpyScipy(), checkIdeaGateVendor(), checkPolicyFile(), checkBinanceCredential(), checkKlineCache()];

  console.log("=== GOVERNOR DOCTOR ===\n");
  let allOk = true;
  for (const c of checks) {
    console.log(`[${c.ok ? "OK" : "FAIL"}] ${c.name} — ${c.detail}`);
    if (!c.ok) allOk = false;
  }
  console.log(`\n${allOk ? "Everything checks out." : "One or more checks failed — fix them before demoing."}`);
  process.exit(allOk ? 0 : 1);
}

main();
