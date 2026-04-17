#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Server as MCPServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import pkg from "../package.json" with { type: "json" };
import { config } from "./config.js";
import {
  ChannelProtocolError,
  ChannelTimeoutError,
  ChannelTransportError,
  errorToOpenAIPayload,
} from "./errors.js";
import {
  CHANNEL_EVENT_KINDS,
  ChannelDebugEventsSchema,
  ChannelPublishSchema,
  ChannelReplySchema,
  ChannelReplyStreamSchema,
  ChatCompletionRequestSchema,
  StartHttpServerSchema,
  type ChatCompletionRequest,
  type OpenAIMessage,
} from "./schemas.js";
import { splitTextForStreaming, streamChunkExtraPause } from "./streaming.js";
import {
  applyCorsHeaders,
  normalizeContent,
  readJSONBody,
  sanitizeMeta,
  sendJSON,
  sleep,
  truncate,
  writeSSEData,
  writeSSEDone,
} from "./utils.js";

const MODEL_CATALOG = [
  {
    id: config.defaultModelId,
    object: "model",
    created: 0,
    owned_by: "claude-channel",
  },
] as const;

type PendingReply = {
  resolve: (content: string) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  createdAt: number;
};

type PendingStreamReply = {
  onDelta: (delta: string) => void;
  onDone: () => void;
  onError: (reason: Error) => void;
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

type ChannelEventKind = (typeof CHANNEL_EVENT_KINDS)[number];

type ChannelEventSourceRecord = {
  type: string;
  input: Record<string, unknown>;
};

type ChannelEventRecord = {
  event_id: number;
  ts: string;
  kind: ChannelEventKind;
  content: string;
  meta: Record<string, string>;
  source?: ChannelEventSourceRecord;
};

class ClaudeChannelBridge {
  private readonly pending = new Map<string, PendingReply>();
  private readonly pendingStreams = new Map<string, PendingStreamReply>();
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
    debugSource?: ChannelEventSourceRecord;
  }): Promise<{ requestId: string; content: string }> {
    const requestId = randomUUID();

    const replyPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ChannelTimeoutError(this.timeoutMs));
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
    this.recordChannelEvent("request", input.content, meta, input.debugSource);

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
        const wrapped = new ChannelTransportError(
          `Failed to publish Claude channel notification: ${String(error)}`,
          error,
        );
        pending.reject(wrapped);
      }
      throw error;
    }

    const content = await replyPromise;
    return { requestId, content };
  }

  async startStream(input: {
    content: string;
    meta?: Record<string, string>;
    debugSource?: ChannelEventSourceRecord;
    onDelta: (delta: string) => void;
    onDone: () => void;
    onError: (reason: Error) => void;
  }): Promise<{ requestId: string }> {
    const requestId = randomUUID();
    const createdAt = Date.now();

    const armTimeout = () =>
      setTimeout(() => {
        const pending = this.pendingStreams.get(requestId);
        if (!pending) return;
        this.pendingStreams.delete(requestId);
        pending.onError(new ChannelTimeoutError(this.timeoutMs));
      }, this.timeoutMs);

    let timeout = armTimeout();

    const pendingStream: PendingStreamReply = {
      createdAt,
      timeout,
      onDelta: (delta) => {
        clearTimeout(timeout);
        timeout = armTimeout();
        pendingStream.timeout = timeout;
        input.onDelta(delta);
      },
      onDone: () => {
        clearTimeout(timeout);
        this.pendingStreams.delete(requestId);
        input.onDone();
      },
      onError: (reason) => {
        clearTimeout(timeout);
        this.pendingStreams.delete(requestId);
        input.onError(reason);
      },
    };

    this.pendingStreams.set(requestId, pendingStream);

    const meta = sanitizeMeta({
      source: "claude-channel",
      request_id: requestId,
      ...input.meta,
    });
    this.recordChannelEvent("request", input.content, meta, input.debugSource);

    try {
      await this.server.notification({
        method: "notifications/claude/channel",
        params: {
          content: input.content,
          meta,
        },
      });
    } catch (error) {
      const pending = this.pendingStreams.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingStreams.delete(requestId);
        pending.onError(
          new ChannelTransportError(
            `Failed to publish Claude channel notification: ${String(error)}`,
            error,
          ),
        );
      }
      throw error;
    }

    return { requestId };
  }

  async publish(input: {
    content: string;
    meta?: Record<string, string>;
    debugSource?: ChannelEventSourceRecord;
  }) {
    const meta = sanitizeMeta(input.meta || {});
    this.recordChannelEvent("publish", input.content, meta, input.debugSource);
    await this.server.notification({
      method: "notifications/claude/channel",
      params: {
        content: input.content,
        meta,
      },
    });
  }

  resolveReply(args: z.infer<typeof ChannelReplySchema>) {
    const streamPending = this.pendingStreams.get(args.request_id);
    if (streamPending) {
      this.logDebugEvent({
        kind: "reply",
        content: args.content,
        meta: {
          request_id: args.request_id,
          stream: "true",
          mode: "stream_fallback",
        },
        source: {
          type: "mcp.tool.channel_reply",
          input: {
            request_id: args.request_id,
            content: truncate(args.content, 12000),
            mode: "stream_fallback",
          },
        },
      });
      streamPending.onDelta(args.content);
      streamPending.onDone();
      return {
        ok: true,
        message: `Stream reply accepted for request_id=${args.request_id} via channel_reply fallback`,
        mode: "stream_fallback",
        latency_ms: Date.now() - streamPending.createdAt,
      };
    }

    const pending = this.pending.get(args.request_id);
    if (!pending) {
      return {
        ok: false,
        message: `No pending request found for request_id=${args.request_id}`,
      };
    }

    this.logDebugEvent({
      kind: "reply",
      content: args.content,
      meta: {
        request_id: args.request_id,
        stream: "false",
        mode: "final",
      },
      source: {
        type: "mcp.tool.channel_reply",
        input: {
          request_id: args.request_id,
          content: truncate(args.content, 12000),
          mode: "final",
        },
      },
    });
    clearTimeout(pending.timeout);
    this.pending.delete(args.request_id);
    pending.resolve(args.content);

    return {
      ok: true,
      message: `Reply accepted for request_id=${args.request_id}`,
      latency_ms: Date.now() - pending.createdAt,
    };
  }

  resolveStreamReply(args: z.infer<typeof ChannelReplyStreamSchema>) {
    const pending = this.pendingStreams.get(args.request_id);
    if (!pending) {
      return {
        ok: false,
        message: `No pending stream request found for request_id=${args.request_id}`,
      };
    }

    const hasDelta = typeof args.delta === "string" && args.delta.length > 0;
    const done = args.done === true;
    if (!hasDelta && !done) {
      return {
        ok: false,
        message: "Either delta or done=true is required.",
      };
    }

    if (hasDelta) {
      this.logDebugEvent({
        kind: "stream_delta",
        content: args.delta || "",
        meta: {
          request_id: args.request_id,
          stream: "true",
        },
        source: {
          type: "mcp.tool.channel_reply_stream",
          input: {
            request_id: args.request_id,
            delta: truncate(args.delta || "", 12000),
            done,
          },
        },
      });
      pending.onDelta(args.delta || "");
    }
    if (done) {
      this.logDebugEvent({
        kind: "stream_done",
        content: "[DONE]",
        meta: {
          request_id: args.request_id,
          stream: "true",
        },
        source: {
          type: "mcp.tool.channel_reply_stream",
          input: {
            request_id: args.request_id,
            done: true,
          },
        },
      });
      pending.onDone();
    }

    return {
      ok: true,
      message: done
        ? `Stream completed for request_id=${args.request_id}`
        : `Stream delta accepted for request_id=${args.request_id}`,
      done,
    };
  }

  pendingCount() {
    return this.pending.size;
  }

  pendingStreamCount() {
    return this.pendingStreams.size;
  }

  getChannelEvents(filters?: z.infer<typeof ChannelDebugEventsSchema>) {
    let events = [...this.channelEvents];

    if (filters?.request_id) {
      events = events.filter((event) => event.meta.request_id === filters.request_id);
    }

    if (filters?.kind) {
      events = events.filter((event) => event.kind === filters.kind);
    }

    if (filters?.source_type) {
      events = events.filter((event) => event.source?.type === filters.source_type);
    }

    if (typeof filters?.stream === "boolean") {
      events = events.filter((event) => event.meta.stream === String(filters.stream));
    }

    if (typeof filters?.limit !== "number" || !Number.isFinite(filters.limit) || filters.limit <= 0) {
      return events;
    }

    return events.slice(-Math.floor(filters.limit));
  }

  channelEventCount() {
    return this.channelEvents.length;
  }

  cancelStream(requestId: string, reason: string) {
    const pending = this.pendingStreams.get(requestId);
    if (!pending) return false;
    pending.onError(new ChannelProtocolError(reason));
    return true;
  }

  logDebugEvent(input: {
    kind: ChannelEventKind;
    content: string;
    meta?: Record<string, string>;
    source?: ChannelEventSourceRecord;
  }) {
    this.recordChannelEvent(
      input.kind,
      input.content,
      sanitizeMeta(input.meta || {}),
      input.source,
    );
  }

  private recordChannelEvent(
    kind: ChannelEventKind,
    content: string,
    meta: Record<string, string>,
    source?: ChannelEventSourceRecord,
  ) {
    this.channelEvents.push({
      event_id: this.nextEventId++,
      ts: new Date().toISOString(),
      kind,
      content,
      meta,
      source,
    });

    while (this.channelEvents.length > config.channelDebugMaxEvents) {
      this.channelEvents.shift();
    }
  }

  cancelAll(reason: string) {
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new ChannelTransportError(reason));
      this.pending.delete(requestId);
    }

    for (const [requestId, pending] of this.pendingStreams.entries()) {
      clearTimeout(pending.timeout);
      pending.onError(new ChannelTransportError(reason));
      this.pendingStreams.delete(requestId);
    }
  }
}

class OpenAICompatServer {
  private server: Server | undefined;
  private host = config.httpHost;
  private port = config.httpPort;
  private apiKey = config.apiKey;
  private timeoutMs = config.chatTimeoutMs;

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
    if (this.server) return this.getState();

    if (input?.host) this.host = input.host;
    if (typeof input?.port === "number") this.port = input.port;
    if (typeof input?.timeout_ms === "number") {
      this.timeoutMs = input.timeout_ms;
      this.bridge.setTimeoutMs(input.timeout_ms);
    }
    if (input?.api_key) this.apiKey = input.api_key;

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
    if (!this.server) return this.getState();

    const current = this.server;
    this.server = undefined;

    await new Promise<void>((resolve) => {
      current.close(() => resolve());
    });

    this.bridge.cancelAll("OpenAI compatibility server stopped.");
    return this.getState();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>) {
    if (config.corsOrigin) {
      applyCorsHeaders(res, config.corsOrigin, req.headers.origin as string | undefined);
    }

    if (req.method === "OPTIONS" && config.corsOrigin) {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host ?? `${this.host}:${this.port}`}`);

    if (url.pathname === "/health") {
      const body = config.healthVerbose
        ? { status: "ok", service: "claude-channel", ...this.getState() }
        : { status: "ok" };
      sendJSON(res, 200, body);
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

      if (!this.checkApiKey(req, res)) return;

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

    if (!this.checkApiKey(req, res)) return;

    let body: unknown;
    try {
      body = await readJSONBody(req, config.maxRequestBytes);
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

    const parsed = ChatCompletionRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJSON(res, 400, {
        error: {
          type: "invalid_request_error",
          message: parsed.error.message,
          code: "invalid_request",
        },
      });
      return;
    }

    const request = parsed.data;
    const model = request.model || config.defaultModelId;
    const created = Math.floor(Date.now() / 1000);
    const channelContent = buildChannelContent(request.messages, request.stream === true);
    const debugSource = buildChatCompletionDebugSource(req, request, model);

    if (request.stream) {
      await this.handleStreamChatCompletion({
        req,
        res,
        request,
        model,
        created,
        channelContent,
        debugSource,
      });
      return;
    }

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
        debugSource,
      });
    } catch (error) {
      const { status, body } = errorToOpenAIPayload(
        error instanceof Error ? error : new Error(String(error)),
      );
      sendJSON(res, status, { error: body });
      return;
    }

    const completionId = `chatcmpl-${bridgeResult.requestId}`;
    const promptTokens = estimateTokens(channelContent);
    const completionTokens = estimateTokens(bridgeResult.content);
    const responsePayload = {
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
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
    this.bridge.logDebugEvent({
      kind: "response",
      content: bridgeResult.content,
      meta: {
        request_id: bridgeResult.requestId,
        stream: "false",
        status: "200",
        model,
      },
      source: {
        type: "openai.http.response",
        input: {
          request_id: bridgeResult.requestId,
          payload: cloneDebugValue(responsePayload),
        },
      },
    });
    sendJSON(res, 200, responsePayload);
  }

  private async handleStreamChatCompletion(input: {
    req: IncomingMessage;
    res: ServerResponse<IncomingMessage>;
    request: ChatCompletionRequest;
    model: string;
    created: number;
    channelContent: string;
    debugSource: ChannelEventSourceRecord;
  }) {
    const { req, res, request, model, created, channelContent, debugSource } = input;
    let completionId = `chatcmpl-${randomUUID()}`;
    let streamRequestId = "";
    let streamOpened = false;
    let streamClosed = false;
    let streamFinished = false;
    const bufferedDeltas: string[] = [];
    let bufferedDone = false;
    let bufferedError: Error | null = null;
    const deltaQueue: string[] = [];
    let drainingQueue = false;
    let doneAfterDrain = false;
    let errorAfterDrain: Error | null = null;
    const chunkSize = config.streamEmitChunkSize;
    const emitIntervalMs = config.streamEmitIntervalMs;
    const punctPauseMs = config.streamEmitPunctPauseMs;

    const writeDeltaChunk = (delta: Record<string, unknown>, finishReason: string | null) => {
      if (streamClosed || streamFinished || res.writableEnded) return;
      const payload = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta,
            finish_reason: finishReason,
          },
        ],
      };
      writeSSEData(res, payload);
      this.bridge.logDebugEvent({
        kind: "response_chunk",
        content: summarizeResponseChunk(delta),
        meta: {
          request_id: streamRequestId,
          stream: "true",
          status: "200",
          model,
          finish_reason: finishReason || "",
        },
        source: {
          type: "openai.http.sse.chunk",
          input: {
            request_id: streamRequestId,
            payload: cloneDebugValue(payload),
          },
        },
      });
    };

    const finishStream = () => {
      if (streamFinished || streamClosed || res.writableEnded) return;
      streamFinished = true;
      const payload = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      };
      writeSSEData(res, payload);
      this.bridge.logDebugEvent({
        kind: "response_chunk",
        content: "[stop]",
        meta: {
          request_id: streamRequestId,
          stream: "true",
          status: "200",
          model,
          finish_reason: "stop",
        },
        source: {
          type: "openai.http.sse.chunk",
          input: {
            request_id: streamRequestId,
            payload: cloneDebugValue(payload),
          },
        },
      });
      writeSSEDone(res);
      this.bridge.logDebugEvent({
        kind: "response_done",
        content: "[DONE]",
        meta: {
          request_id: streamRequestId,
          stream: "true",
          status: "200",
          model,
        },
        source: {
          type: "openai.http.sse.done",
          input: {
            request_id: streamRequestId,
          },
        },
      });
      res.end();
    };

    const failStream = (error: Error) => {
      if (streamFinished || streamClosed || res.writableEnded) return;
      streamFinished = true;
      const { body } = errorToOpenAIPayload(error);
      const payload = { error: body };
      writeSSEData(res, payload);
      this.bridge.logDebugEvent({
        kind: "response_error",
        content: error.message,
        meta: {
          request_id: streamRequestId,
          stream: "true",
          status: error instanceof ChannelTimeoutError ? "504" : "502",
          model,
        },
        source: {
          type: "openai.http.sse.error",
          input: {
            request_id: streamRequestId,
            payload: cloneDebugValue(payload),
          },
        },
      });
      writeSSEDone(res);
      this.bridge.logDebugEvent({
        kind: "response_done",
        content: "[DONE]",
        meta: {
          request_id: streamRequestId,
          stream: "true",
          status: error instanceof ChannelTimeoutError ? "504" : "502",
          model,
        },
        source: {
          type: "openai.http.sse.done",
          input: {
            request_id: streamRequestId,
            after_error: true,
          },
        },
      });
      res.end();
    };

    const enqueueDelta = (delta: string) => {
      if (!delta) return;
      const chunks = splitTextForStreaming(delta, chunkSize);
      for (const chunk of chunks) deltaQueue.push(chunk);
      void drainQueue();
    };

    const drainQueue = async () => {
      if (drainingQueue || streamClosed || streamFinished || res.writableEnded) return;
      drainingQueue = true;
      try {
        while (deltaQueue.length > 0) {
          if (streamClosed || streamFinished || res.writableEnded) {
            deltaQueue.length = 0;
            return;
          }
          const delta = deltaQueue.shift();
          if (!delta) continue;
          writeDeltaChunk({ content: delta }, null);
          const delayMs = emitIntervalMs + streamChunkExtraPause(delta, punctPauseMs);
          if (delayMs > 0) await sleep(delayMs);
        }
      } finally {
        drainingQueue = false;
      }

      if (streamClosed || streamFinished || res.writableEnded) return;

      if (errorAfterDrain) {
        const error = errorAfterDrain;
        errorAfterDrain = null;
        failStream(error);
        return;
      }

      if (doneAfterDrain) {
        doneAfterDrain = false;
        finishStream();
      }
    };

    const flushBufferedEvents = () => {
      if (!streamOpened || streamClosed || streamFinished || res.writableEnded) return;

      while (bufferedDeltas.length > 0) {
        const delta = bufferedDeltas.shift();
        if (typeof delta === "string" && delta.length > 0) {
          enqueueDelta(delta);
        }
      }

      if (bufferedError) {
        const error = bufferedError;
        bufferedError = null;
        if (drainingQueue || deltaQueue.length > 0) {
          errorAfterDrain = error;
        } else {
          failStream(error);
        }
        return;
      }

      if (bufferedDone) {
        bufferedDone = false;
        if (drainingQueue || deltaQueue.length > 0) {
          doneAfterDrain = true;
        } else {
          finishStream();
        }
      }
    };

    try {
      const started = await this.bridge.startStream({
        content: channelContent,
        meta: sanitizeMeta({
          source: "claude-channel",
          request_type: "chat.completions",
          model,
          openai_user: request.user || "",
          stream: "true",
        }),
        debugSource,
        onDelta: (delta) => {
          if (streamClosed || streamFinished) return;
          if (!streamOpened) {
            bufferedDeltas.push(delta);
            return;
          }
          enqueueDelta(delta);
        },
        onDone: () => {
          if (streamClosed || streamFinished) return;
          if (!streamOpened) {
            bufferedDone = true;
            return;
          }
          if (drainingQueue || deltaQueue.length > 0) {
            doneAfterDrain = true;
            return;
          }
          finishStream();
        },
        onError: (reason) => {
          if (streamClosed || streamFinished) return;
          if (!streamOpened) {
            bufferedError = reason;
            return;
          }
          if (drainingQueue || deltaQueue.length > 0) {
            errorAfterDrain = reason;
            return;
          }
          failStream(reason);
        },
      });
      streamRequestId = started.requestId;
      completionId = `chatcmpl-${streamRequestId}`;
    } catch (error) {
      const { status, body } = errorToOpenAIPayload(
        error instanceof Error ? error : new Error(String(error)),
      );
      sendJSON(res, status, { error: body });
      return;
    }

    const handleClientClose = () => {
      if (streamClosed) return;
      streamClosed = true;
      if (!streamFinished && streamRequestId) {
        this.bridge.cancelStream(streamRequestId, "Client disconnected from streaming response.");
      }
    };

    res.once("close", handleClientClose);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    streamOpened = true;

    writeDeltaChunk({ role: "assistant" }, null);
    flushBufferedEvents();
  }

  private checkApiKey(req: IncomingMessage, res: ServerResponse<IncomingMessage>) {
    if (!this.apiKey) return true;

    const authorization = req.headers.authorization ?? "";
    const expected = `Bearer ${this.apiKey}`;
    if (authorization === expected) return true;

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

function buildChannelContent(messages: OpenAIMessage[], stream: boolean) {
  const lines: string[] = [];
  lines.push("[OpenAI Chat Request]");
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    const text = normalizeContent(msg.content, config.maxMessageChars);
    const nameLabel = msg.name ? ` (${msg.name})` : "";
    lines.push(`${role}${nameLabel}: ${text}`);
  }
  lines.push("");
  if (stream) {
    lines.push(
      "当前请求为 stream=true。请优先一次性或较大块返回内容（例如每次 80-200 字，或直接整段）。可用 channel_reply_stream 多次发送 delta，最后 done=true；也可以直接用 channel_reply 返回全文。claude-channel 会在服务端自动按打字机效果切片输出。",
    );
  } else {
    lines.push("请直接给出你要返回给 API 调用方的最终回复内容。然后调用 channel_reply 工具，带上 request_id。");
  }
  return lines.join("\n");
}

function buildChatCompletionDebugSource(
  req: IncomingMessage,
  request: ChatCompletionRequest & { messages: OpenAIMessage[] },
  model: string,
): ChannelEventSourceRecord {
  return {
    type: "openai.chat.completions",
    input: {
      http: {
        method: req.method || "POST",
        path: req.url || "/v1/chat/completions",
        remote_address: req.socket.remoteAddress || "",
        headers: selectDebugHeaders(req.headers),
      },
      request: {
        model,
        user: request.user || "",
        stream: request.stream === true,
        message_count: request.messages.length,
        messages: request.messages.map((message) => ({
          role: message.role,
          name: message.name || "",
          content: cloneDebugValue(message.content),
        })),
      },
    },
  };
}

function selectDebugHeaders(headers: IncomingMessage["headers"]) {
  const selected = [
    "content-type",
    "accept",
    "user-agent",
    "x-forwarded-for",
    "x-real-ip",
    "origin",
    "referer",
  ] as const;
  const result: Record<string, string | string[]> = {};
  for (const key of selected) {
    const value = headers[key];
    if (typeof value === "undefined") continue;
    result[key] = value;
  }
  return result;
}

function cloneDebugValue(value: unknown, depth = 0): unknown {
  if (depth >= 6) return "[max_depth]";

  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return truncate(value, 12000);
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => cloneDebugValue(item, depth + 1));
    if (value.length > 100) {
      items.push({ __truncated_items__: value.length - 100 });
    }
    return items;
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [index, [key, entryValue]] of entries.entries()) {
      if (index >= 100) {
        result.__truncated_keys__ = entries.length - 100;
        break;
      }
      result[key] = cloneDebugValue(entryValue, depth + 1);
    }
    return result;
  }

  return String(value);
}

function summarizeResponseChunk(delta: Record<string, unknown>) {
  const content = delta.content;
  if (typeof content === "string" && content.length > 0) return content;

  const role = delta.role;
  if (typeof role === "string" && role.length > 0) return `[role:${role}]`;

  return truncate(JSON.stringify(delta), 2000);
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

const server = new MCPServer(
  {
    name: "claude-channel",
    version: pkg.version,
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
      "当请求为 stream=true 时，可多次调用 channel_reply_stream 返回分段 delta，并在结束时 done=true。" +
      "如果要手动发送测试 channel，可用 channel_publish。",
  },
);

const bridge = new ClaudeChannelBridge(server, config.chatTimeoutMs);
const openaiServer = new OpenAICompatServer(bridge);

function getRuntimeStatus() {
  const http = openaiServer.getState();
  return {
    service: "claude-channel",
    version: pkg.version,
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
      stream_emit_chunk_size: config.streamEmitChunkSize,
      stream_emit_interval_ms: config.streamEmitIntervalMs,
      stream_emit_punct_pause_ms: config.streamEmitPunctPauseMs,
    },
    channel: {
      pending_requests: bridge.pendingCount(),
      pending_stream_requests: bridge.pendingStreamCount(),
      total_events: bridge.channelEventCount(),
      max_events: config.channelDebugMaxEvents,
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
      description:
        "Debug tool: inspect channel input/output events and OpenAI response output, including detailed source snapshots.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            description: "Optional max number of latest events to return.",
          },
          request_id: {
            type: "string",
            description: "Optional exact request_id filter.",
          },
          kind: {
            type: "string",
            enum: [...CHANNEL_EVENT_KINDS],
            description: "Optional event kind filter.",
          },
          source_type: {
            type: "string",
            description: "Optional exact source.type filter, e.g. openai.chat.completions.",
          },
          stream: {
            type: "boolean",
            description: "Optional stream=true/false filter based on original request.",
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
      name: "channel_reply_stream",
      description:
        "Reply to one pending stream request by request_id. Can be called multiple times with delta, and done=true to finish.",
      inputSchema: {
        type: "object",
        properties: {
          request_id: { type: "string" },
          delta: { type: "string" },
          done: { type: "boolean" },
        },
        required: ["request_id"],
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
        content: [{ type: "text", text: "OpenAI API server stopped." }],
        structuredContent: status,
      };
    }

    if (name === "http_server_status") {
      const status = openaiServer.getState();
      return {
        content: [{ type: "text", text: JSON.stringify(status) }],
        structuredContent: status,
      };
    }

    if (name === "runtime_status") {
      const status = getRuntimeStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(status) }],
        structuredContent: status,
      };
    }

    if (name === "channel_debug_events") {
      const args = ChannelDebugEventsSchema.parse(request.params.arguments);
      const events = bridge.getChannelEvents(args);
      const result = {
        count: events.length,
        pending_requests: bridge.pendingCount(),
        pending_stream_requests: bridge.pendingStreamCount(),
        filters: {
          limit: args?.limit,
          request_id: args?.request_id,
          kind: args?.kind,
          source_type: args?.source_type,
          stream: args?.stream,
        },
        events,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }

    if (name === "channel_reply") {
      const args = ChannelReplySchema.parse(request.params.arguments ?? {});
      const result = bridge.resolveReply(args);
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
        isError: !result.ok,
      };
    }

    if (name === "channel_reply_stream") {
      const args = ChannelReplyStreamSchema.parse(request.params.arguments ?? {});
      const result = bridge.resolveStreamReply(args);
      return {
        content: [{ type: "text", text: result.message }],
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
        debugSource: {
          type: "mcp.tool.channel_publish",
          input: {
            meta: args.meta || {},
            content: truncate(args.content, 12000),
          },
        },
      });
      return {
        content: [{ type: "text", text: "channel published" }],
        structuredContent: { ok: true },
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  },
);

await server.connect(new StdioServerTransport());
console.error(`[mcp] claude-channel v${pkg.version} connected over stdio`);

if (config.autoStartHttp) {
  const status = await openaiServer.start();
  console.error(`[openai] auto-start enabled: http://${status.host}:${status.port}`);
}

const shutdown = () => {
  void openaiServer.stop().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
