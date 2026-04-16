#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Server as MCPServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const DEFAULT_HTTP_HOST = process.env.BRIDGE_HTTP_HOST?.trim() || "127.0.0.1";
const DEFAULT_HTTP_PORT = parseInt(process.env.BRIDGE_HTTP_PORT || "8787", 10);
const DEFAULT_CHAT_TIMEOUT_MS = parseInt(process.env.BRIDGE_CHAT_TIMEOUT_MS || "180000", 10);
const DEFAULT_API_KEY = process.env.BRIDGE_API_KEY?.trim() || "";
const AUTO_START_HTTP = process.env.BRIDGE_HTTP_AUTO_START === "1";
const DEFAULT_MODEL_ID = "claude-channel";
const DEFAULT_MODEL_CREATED_AT = 0;
const CHANNEL_DEBUG_MAX_EVENTS = parseInt(process.env.BRIDGE_CHANNEL_DEBUG_MAX_EVENTS || "500", 10);
const MODEL_CATALOG = [
  {
    id: DEFAULT_MODEL_ID,
    object: "model",
    created: DEFAULT_MODEL_CREATED_AT,
    owned_by: "claude-channel",
  },
] as const;

const StartHttpServerSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    api_key: z.string().min(1).optional(),
    timeout_ms: z.number().int().min(1000).max(30 * 60 * 1000).optional(),
  })
  .optional();

const ChannelReplySchema = z.object({
  request_id: z.string().min(1),
  content: z.string().min(1),
});

const ChannelPublishSchema = z.object({
  content: z.string().min(1),
  meta: z.record(z.string(), z.string()).optional(),
});

const ChannelDebugEventsSchema = z
  .object({
    limit: z.number().int().min(1).max(500).optional(),
  })
  .optional();

type Role = "system" | "user" | "assistant" | "tool";

type OpenAIMessage = {
  role: Role;
  content: unknown;
  name?: string;
};

type ChatCompletionRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  user?: string;
};

type PendingReply = {
  resolve: (content: string) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  createdAt: number;
};

type OpenAIServerState = {
  running: boolean;
  host: string;
  port: number;
  timeout_ms: number;
  api_key_enabled: boolean;
};

type ChannelEventRecord = {
  event_id: number;
  ts: string;
  kind: "request" | "publish";
  content: string;
  meta: Record<string, string>;
};

class ClaudeChannelBridge {
  private readonly pending = new Map<string, PendingReply>();
  private readonly channelEvents: ChannelEventRecord[] = [];
  private nextEventId = 1;

  constructor(
    private readonly server: MCPServer,
    private timeoutMs: number,
  ) {}

  setTimeoutMs(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  async sendAndWait(input: {
    content: string;
    meta?: Record<string, string>;
  }): Promise<{ requestId: string; content: string }> {
    const requestId = randomUUID();

    const replyPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for Claude Code reply after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(requestId, {
        resolve,
        reject,
        timeout,
        createdAt: Date.now(),
      });
    });

    const meta = sanitizeMeta({
      source: "claude-channel",
      request_id: requestId,
      ...input.meta,
    });
    this.recordChannelEvent("request", input.content, meta);

    try {
      await this.server.notification({
        method: "notifications/claude/channel",
        params: {
          content: input.content,
          meta,
        },
      });
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        pending.reject(new Error(`Failed to publish Claude channel notification: ${String(error)}`));
      }
      throw error;
    }

    const content = await replyPromise;
    return { requestId, content };
  }

  async publish(input: { content: string; meta?: Record<string, string> }) {
    const meta = sanitizeMeta(input.meta || {});
    this.recordChannelEvent("publish", input.content, meta);
    await this.server.notification({
      method: "notifications/claude/channel",
      params: {
        content: input.content,
        meta,
      },
    });
  }

  resolveReply(args: z.infer<typeof ChannelReplySchema>) {
    const pending = this.pending.get(args.request_id);
    if (!pending) {
      return {
        ok: false,
        message: `No pending request found for request_id=${args.request_id}`,
      };
    }

    clearTimeout(pending.timeout);
    this.pending.delete(args.request_id);
    pending.resolve(args.content);

    return {
      ok: true,
      message: `Reply accepted for request_id=${args.request_id}`,
      latency_ms: Date.now() - pending.createdAt,
    };
  }

  pendingCount() {
    return this.pending.size;
  }

  getChannelEvents(limit?: number) {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
      return [...this.channelEvents];
    }
    return this.channelEvents.slice(-Math.floor(limit));
  }

  channelEventCount() {
    return this.channelEvents.length;
  }

  private recordChannelEvent(
    kind: ChannelEventRecord["kind"],
    content: string,
    meta: Record<string, string>,
  ) {
    this.channelEvents.push({
      event_id: this.nextEventId++,
      ts: new Date().toISOString(),
      kind,
      content,
      meta,
    });

    const maxEvents = Number.isFinite(CHANNEL_DEBUG_MAX_EVENTS) && CHANNEL_DEBUG_MAX_EVENTS > 0
      ? CHANNEL_DEBUG_MAX_EVENTS
      : 500;
    while (this.channelEvents.length > maxEvents) {
      this.channelEvents.shift();
    }
  }

  cancelAll(reason: string) {
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      this.pending.delete(requestId);
    }
  }
}

class OpenAICompatServer {
  private server: Server | undefined;
  private host = DEFAULT_HTTP_HOST;
  private port = Number.isFinite(DEFAULT_HTTP_PORT) ? DEFAULT_HTTP_PORT : 8787;
  private apiKey = DEFAULT_API_KEY;
  private timeoutMs = Number.isFinite(DEFAULT_CHAT_TIMEOUT_MS)
    ? DEFAULT_CHAT_TIMEOUT_MS
    : 180_000;

  constructor(private readonly bridge: ClaudeChannelBridge) {}

  getState(): OpenAIServerState {
    return {
      running: Boolean(this.server),
      host: this.host,
      port: this.port,
      timeout_ms: this.timeoutMs,
      api_key_enabled: Boolean(this.apiKey),
    };
  }

  async start(input?: z.infer<typeof StartHttpServerSchema>) {
    if (this.server) {
      return this.getState();
    }

    if (input?.host) {
      this.host = input.host;
    }
    if (typeof input?.port === "number") {
      this.port = input.port;
    }
    if (typeof input?.timeout_ms === "number") {
      this.timeoutMs = input.timeout_ms;
      this.bridge.setTimeoutMs(input.timeout_ms);
    }
    if (input?.api_key) {
      this.apiKey = input.api_key;
    }

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        console.error(`[openai] request failed: ${String(error)}`);
        if (!res.headersSent) {
          sendJSON(res, 500, {
            error: {
              type: "server_error",
              message: "Internal server error",
              code: "server_error",
            },
          });
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, this.host, () => resolve());
    });

    console.error(`[openai] listening on http://${this.host}:${this.port}`);
    return this.getState();
  }

  async stop() {
    if (!this.server) {
      return this.getState();
    }

    const current = this.server;
    this.server = undefined;

    await new Promise<void>((resolve) => {
      current.close(() => resolve());
    });

    this.bridge.cancelAll("OpenAI compatibility server stopped.");
    return this.getState();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>) {
    const url = new URL(req.url || "/", `http://${req.headers.host ?? `${this.host}:${this.port}`}`);

    if (url.pathname === "/health") {
      sendJSON(res, 200, {
        status: "ok",
        service: "claude-channel",
        ...this.getState(),
      });
      return;
    }

    if (url.pathname === "/v1/models") {
      if (req.method !== "GET") {
        sendJSON(res, 405, {
          error: {
            type: "method_not_allowed",
            message: "Use GET /v1/models",
            code: "method_not_allowed",
          },
        });
        return;
      }

      if (!this.checkApiKey(req, res)) {
        return;
      }

      sendJSON(res, 200, buildModelListResponse());
      return;
    }

    if (url.pathname !== "/v1/chat/completions") {
      sendJSON(res, 404, {
        error: {
          type: "not_found",
          message: "Route not found",
          code: "not_found",
        },
      });
      return;
    }

    if (req.method !== "POST") {
      sendJSON(res, 405, {
        error: {
          type: "method_not_allowed",
          message: "Use POST /v1/chat/completions",
          code: "method_not_allowed",
        },
      });
      return;
    }

    if (!this.checkApiKey(req, res)) {
      return;
    }

    let body: unknown;
    try {
      body = await readJSONBody(req, 2 * 1024 * 1024);
    } catch (error) {
      sendJSON(res, 400, {
        error: {
          type: "invalid_request_error",
          message: `Invalid JSON body: ${String(error)}`,
          code: "invalid_json",
        },
      });
      return;
    }

    const parsed = parseChatCompletionRequest(body);
    if (!parsed.ok) {
      sendJSON(res, 400, {
        error: {
          type: "invalid_request_error",
          message: parsed.error,
          code: "invalid_request",
        },
      });
      return;
    }

    const request = parsed.value;
    const model = request.model || DEFAULT_MODEL_ID;
    const created = Math.floor(Date.now() / 1000);
    const channelContent = buildChannelContent(request.messages);

    let bridgeResult: { requestId: string; content: string };
    try {
      bridgeResult = await this.bridge.sendAndWait({
        content: channelContent,
        meta: sanitizeMeta({
          source: "claude-channel",
          request_type: "chat.completions",
          model,
          openai_user: request.user || "",
          stream: String(Boolean(request.stream)),
        }),
      });
    } catch (error) {
      const message = String(error);
      const isTimeout = message.includes("Timed out");
      sendJSON(res, isTimeout ? 504 : 502, {
        error: {
          type: isTimeout ? "timeout_error" : "upstream_error",
          message,
          code: isTimeout ? "claude_reply_timeout" : "claude_channel_error",
        },
      });
      return;
    }

    const completionId = `chatcmpl-${bridgeResult.requestId}`;
    if (request.stream) {
      sendStreamResponse(res, {
        id: completionId,
        model,
        created,
        content: bridgeResult.content,
      });
      return;
    }

    sendJSON(res, 200, {
      id: completionId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: bridgeResult.content,
          },
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  }

  private checkApiKey(req: IncomingMessage, res: ServerResponse<IncomingMessage>) {
    if (!this.apiKey) {
      return true;
    }

    const authorization = req.headers.authorization ?? "";
    const expected = `Bearer ${this.apiKey}`;
    if (authorization === expected) {
      return true;
    }

    sendJSON(res, 401, {
      error: {
        type: "invalid_api_key",
        message: "Missing or invalid Bearer API key",
        code: "invalid_api_key",
      },
    });
    return false;
  }
}

function buildModelListResponse() {
  return {
    object: "list",
    data: MODEL_CATALOG,
  };
}

function parseChatCompletionRequest(input: unknown):
  | {
      ok: true;
      value: ChatCompletionRequest & { messages: OpenAIMessage[] };
    }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const req = input as Record<string, unknown>;
  const rawMessages = req.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { ok: false, error: "messages must be a non-empty array." };
  }

  const messages: OpenAIMessage[] = [];
  for (const item of rawMessages) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "Each message must be an object." };
    }
    const record = item as Record<string, unknown>;
    const role = record.role;
    const content = record.content;
    const name = typeof record.name === "string" ? record.name : undefined;

    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      return { ok: false, error: "message.role must be one of system|user|assistant|tool." };
    }

    messages.push({
      role,
      content,
      name,
    });
  }

  return {
    ok: true,
    value: {
      model: typeof req.model === "string" ? req.model : undefined,
      user: typeof req.user === "string" ? req.user : undefined,
      stream: req.stream === true,
      messages,
    },
  };
}

function buildChannelContent(messages: OpenAIMessage[]) {
  const lines: string[] = [];

  lines.push("[OpenAI Chat Request]");
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    const text = normalizeContent(msg.content);
    const nameLabel = msg.name ? ` (${msg.name})` : "";
    lines.push(`${role}${nameLabel}: ${text}`);
  }
  lines.push("");
  lines.push("请直接给出你要返回给 API 调用方的最终回复内容。然后调用 channel_reply 工具，带上 request_id。");

  return lines.join("\n");
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") {
    return truncate(content, 5000);
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          const maybeText = (part as Record<string, unknown>).text;
          if (typeof maybeText === "string") {
            return maybeText;
          }
          return JSON.stringify(part);
        }
        return String(part);
      })
      .join("\n");
    return truncate(parts, 5000);
  }

  if (content === null || typeof content === "undefined") {
    return "";
  }

  return truncate(JSON.stringify(content), 5000);
}

function truncate(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)} ...[truncated ${text.length - maxLength} chars]`;
}

function sanitizeMeta(input: Record<string, string | undefined>) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value) {
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

function sendJSON(res: ServerResponse<IncomingMessage>, status: number, payload: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
  });
  res.end(JSON.stringify(payload));
}

function sendStreamResponse(
  res: ServerResponse<IncomingMessage>,
  input: { id: string; model: string; created: number; content: string },
) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const chunk = {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: input.content,
        },
        finish_reason: null,
      },
    ],
  };

  const doneChunk = {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };

  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

async function readJSONBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error(`Request body too large. Max bytes: ${maxBytes}`);
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

const server = new MCPServer(
  {
    name: "claude-channel",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
      },
    },
    instructions:
      'OpenAI 请求会通过 <channel source="claude-channel" request_id="..."> 发送到会话。' +
      "你需要基于 channel 内容生成回复，并调用 channel_reply 工具把文本返回给桥接服务。" +
      "如果要手动发送测试 channel，可用 channel_publish。",
  },
);

const bridge = new ClaudeChannelBridge(server, DEFAULT_CHAT_TIMEOUT_MS);
const openaiServer = new OpenAICompatServer(bridge);

function getRuntimeStatus() {
  const http = openaiServer.getState();
  return {
    service: "claude-channel",
    now: new Date().toISOString(),
    mcp: {
      connected: true,
      transport: "stdio",
      pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
    },
    http: {
      ...http,
      listen_url: http.running ? `http://${http.host}:${http.port}` : undefined,
    },
    openai_api: {
      routes: ["/health", "/v1/models", "/v1/chat/completions"],
      models: MODEL_CATALOG,
    },
    channel: {
      pending_requests: bridge.pendingCount(),
      total_events: bridge.channelEventCount(),
      max_events: Number.isFinite(CHANNEL_DEBUG_MAX_EVENTS) && CHANNEL_DEBUG_MAX_EVENTS > 0
        ? CHANNEL_DEBUG_MAX_EVENTS
        : 500,
    },
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "http_server_start",
      description: "Start OpenAI-compatible HTTP API service.",
      inputSchema: {
        type: "object",
        properties: {
          host: { type: "string", description: "Host, default 127.0.0.1" },
          port: { type: "integer", description: "Port, default 8787" },
          api_key: { type: "string", description: "Optional Bearer token for API auth" },
          timeout_ms: {
            type: "integer",
            description: "Timeout for waiting Claude channel reply in milliseconds",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "http_server_stop",
      description: "Stop OpenAI-compatible HTTP API service.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "http_server_status",
      description: "Get OpenAI-compatible HTTP API service status.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "runtime_status",
      description:
        "Get runtime status of this MCP service, including OpenAI HTTP listen address/port and channel queue.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "channel_debug_events",
      description: "Debug tool: list channel messages that were sent into Claude channels.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Optional max number of latest events to return.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "channel_reply",
      description: "Reply to one pending channel request by request_id.",
      inputSchema: {
        type: "object",
        properties: {
          request_id: { type: "string" },
          content: { type: "string" },
        },
        required: ["request_id", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "channel_publish",
      description: "Send an arbitrary channel notification to Claude Code for testing.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
          meta: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(
  CallToolRequestSchema,
  async (request: { params: { name: string; arguments?: unknown } }) => {
    const name = request.params.name;

    if (name === "http_server_start") {
      const args = StartHttpServerSchema.parse(request.params.arguments);
      const status = await openaiServer.start(args);
      return {
        content: [
          {
            type: "text",
            text: `OpenAI API server is running at http://${status.host}:${status.port}`,
          },
        ],
        structuredContent: status,
      };
    }

    if (name === "http_server_stop") {
      const status = await openaiServer.stop();
      return {
        content: [
          {
            type: "text",
            text: "OpenAI API server stopped.",
          },
        ],
        structuredContent: status,
      };
    }

    if (name === "http_server_status") {
      const status = openaiServer.getState();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(status),
          },
        ],
        structuredContent: status,
      };
    }

    if (name === "runtime_status") {
      const status = getRuntimeStatus();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(status),
          },
        ],
        structuredContent: status,
      };
    }

    if (name === "channel_debug_events") {
      const args = ChannelDebugEventsSchema.parse(request.params.arguments);
      const events = bridge.getChannelEvents(args?.limit);
      const result = {
        count: events.length,
        pending_requests: bridge.pendingCount(),
        events,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
        structuredContent: result,
      };
    }

    if (name === "channel_reply") {
      const args = ChannelReplySchema.parse(request.params.arguments ?? {});
      const result = bridge.resolveReply(args);
      return {
        content: [
          {
            type: "text",
            text: result.message,
          },
        ],
        structuredContent: result,
        isError: !result.ok,
      };
    }

    if (name === "channel_publish") {
      const args = ChannelPublishSchema.parse(request.params.arguments ?? {});
      await bridge.publish({
        content: args.content,
        meta: {
          source: "manual",
          ...(args.meta || {}),
        },
      });
      return {
        content: [
          {
            type: "text",
            text: "channel published",
          },
        ],
        structuredContent: {
          ok: true,
        },
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  },
);

await server.connect(new StdioServerTransport());
console.error("[mcp] claude-channel connected over stdio");

if (AUTO_START_HTTP) {
  const status = await openaiServer.start();
  console.error(`[openai] auto-start enabled: http://${status.host}:${status.port}`);
}

const shutdown = () => {
  void openaiServer.stop().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
