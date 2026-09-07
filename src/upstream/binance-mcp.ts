// Client for Binance's own MCP server at agent.binance.com/mcp/agentic.
//
// Everything the Governor knows about Binance goes through here. There is no REST client and no API
// key anywhere in this project: Binance's Agent OS exposes the exchange as MCP tools behind an
// OAuth 2.1 session, and that is the only door we use. That matters for the guarantee we make —
// the Governor cannot reach a capability the user did not grant on the consent screen, because it
// has no other transport.
//
// Transport notes, learned by probing the live server rather than from docs:
//   * Streamable HTTP, JSON-RPC 2.0. Stateless — no Mcp-Session-Id is returned or required.
//   * `Accept` must list both application/json and text/event-stream or the server refuses.
//   * The server runs in META mode: tools/list exposes 69 tools, but tool_search over its 15
//     categories reveals 256. Anything not in tools/list must be invoked via tool_execute.
//   * serverInfo reports itself as "Tesla-MCP-Server".

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BINANCE_MCP_URL = "https://agent.binance.com/mcp/agentic";
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** The 15 categories tool_search accepts. Any other value is rejected by the server. */
export const TOOL_CATEGORIES = [
  "account",
  "ai-analysis",
  "asset",
  "asset-management",
  "borrow-repay",
  "capital",
  "convert",
  "general",
  "market",
  "market-data",
  "others",
  "portfolio-margin-endpoints",
  "trade",
  "transfer",
  "travel-rule",
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface CallResult {
  /** Parsed JSON when the tool returned JSON text, otherwise the raw text. */
  data: unknown;
  /** The raw text exactly as the server sent it, for the ledger. */
  raw: string;
  isError: boolean;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/**
 * Resolve the upstream bearer token.
 *
 * Preference order:
 *   1. BINANCE_MCP_TOKEN — how the Governor runs in production or in CI.
 *   2. Claude Code's own MCP credential store — a convenience for local development, so a developer
 *      who already ran `claude mcp login binance-mcp-server` does not have to re-authorise.
 *
 * The token is read, never written, never logged, and never leaves this process.
 */
export function resolveToken(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env.BINANCE_MCP_TOKEN;
  if (fromEnv) return fromEnv;

  const credFile = join(homedir(), ".claude", ".credentials.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(credFile, "utf8"));
  } catch {
    throw new UpstreamError(
      "No Binance MCP token. Set BINANCE_MCP_TOKEN, or run: claude mcp login binance-mcp-server",
    );
  }
  const store = (parsed as { mcpOAuth?: Record<string, { accessToken?: string; serverUrl?: string }> }).mcpOAuth ?? {};
  for (const entry of Object.values(store)) {
    if (entry?.serverUrl === BINANCE_MCP_URL && entry.accessToken) return entry.accessToken;
  }
  throw new UpstreamError(
    "Claude Code has no credential for agent.binance.com. Run: claude mcp login binance-mcp-server",
  );
}

export interface UpstreamOptions {
  token?: string;
  url?: string;
  timeoutMs?: number;
  /** Injected in tests so the client can be exercised without touching the network. */
  fetchImpl?: typeof fetch;
}

export class BinanceUpstream {
  private readonly token: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private nextId = 1;

  constructor(opts: UpstreamOptions = {}) {
    this.token = resolveToken(opts.token);
    this.url = opts.url ?? BINANCE_MCP_URL;
    this.timeoutMs = opts.timeoutMs ?? 45_000;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  private async rpc<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(this.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.token}`,
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }),
      });
    } catch (err) {
      throw new UpstreamError(
        controller.signal.aborted ? `upstream timed out after ${this.timeoutMs}ms` : `upstream unreachable: ${String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) {
      throw new UpstreamError("upstream rejected the token (401) — re-run: claude mcp login binance-mcp-server", 401);
    }
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(`upstream HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);

    let body: { result?: T; error?: { code: number; message: string; data?: unknown } };
    try {
      body = JSON.parse(text);
    } catch {
      throw new UpstreamError(`upstream returned non-JSON: ${text.slice(0, 300)}`);
    }
    if (body.error) throw new UpstreamError(body.error.message, body.error.code, body.error.data);
    return body.result as T;
  }

  /** MCP handshake. Also the cheapest liveness + token check we have. */
  async initialize(clientName = "binance-governor", clientVersion = "0.1.0"): Promise<Record<string, unknown>> {
    return this.rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: clientVersion },
    });
  }

  /** Every always-exposed tool, following nextCursor to the end. */
  async listTools(): Promise<ToolDescriptor[]> {
    const out: ToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.rpc<{ tools?: ToolDescriptor[]; nextCursor?: string }>(
        "tools/list",
        cursor ? { cursor } : {},
      );
      out.push(...(res.tools ?? []));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /** Call a tool by name. Tools hidden by META mode are routed through tool_execute automatically. */
  async callTool(name: string, args: Record<string, unknown> = {}, viaMeta = false): Promise<CallResult> {
    const params = viaMeta
      ? { name: "tool_execute", arguments: { toolName: name, arguments: args } }
      : { name, arguments: args };
    const res = await this.rpc<{ content?: { type: string; text?: string }[]; isError?: boolean }>("tools/call", params);
    const first = res.content?.[0];
    const raw = first?.type === "text" && first.text !== undefined ? first.text : JSON.stringify(res);
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* not JSON — keep the text */
    }
    return { data, raw, isError: res.isError === true };
  }

  /** The hidden catalogue, one category at a time. Paginates until the server stops offering a cursor. */
  async searchTools(category: ToolCategory): Promise<ToolDescriptor[]> {
    const out: ToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.callTool("tool_search", cursor ? { category, cursor } : { category });
      const payload = res.data as { tools?: ToolDescriptor[]; nextCursor?: string } | undefined;
      out.push(...(payload?.tools ?? []));
      cursor = payload?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /** Union of the exposed list and every category — the full 256-tool surface. */
  async allTools(): Promise<ToolDescriptor[]> {
    const byName = new Map<string, ToolDescriptor>();
    for (const t of await this.listTools()) byName.set(t.name, t);
    for (const category of TOOL_CATEGORIES) {
      for (const t of await this.searchTools(category)) {
        const name = t.name ?? (t as { toolName?: string }).toolName;
        if (typeof name === "string") byName.set(name, { ...t, name });
      }
    }
    return [...byName.values()];
  }
}
