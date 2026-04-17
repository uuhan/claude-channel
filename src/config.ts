function parseIntEnv(name: string, fallback: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (typeof min === "number" && parsed < min) return min;
  if (typeof max === "number" && parsed > max) return max;
  return parsed;
}

function parseBoolEnv(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function parseStringEnv(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export const config = {
  httpHost: parseStringEnv("BRIDGE_HTTP_HOST", "127.0.0.1"),
  httpPort: parseIntEnv("BRIDGE_HTTP_PORT", 8787, 1, 65535),
  chatTimeoutMs: parseIntEnv("BRIDGE_CHAT_TIMEOUT_MS", 180_000, 1_000, 30 * 60 * 1000),
  apiKey: parseStringEnv("BRIDGE_API_KEY", ""),
  autoStartHttp: parseBoolEnv("BRIDGE_HTTP_AUTO_START", false),
  channelDebugMaxEvents: parseIntEnv("BRIDGE_CHANNEL_DEBUG_MAX_EVENTS", 500, 1, 100_000),
  streamEmitChunkSize: parseIntEnv("BRIDGE_STREAM_EMIT_CHUNK_SIZE", 3, 0, 1024),
  streamEmitIntervalMs: parseIntEnv("BRIDGE_STREAM_EMIT_INTERVAL_MS", 28, 0, 10_000),
  streamEmitPunctPauseMs: parseIntEnv("BRIDGE_STREAM_EMIT_PUNCT_PAUSE_MS", 90, 0, 10_000),
  maxMessageChars: parseIntEnv("BRIDGE_MAX_MESSAGE_CHARS", 5000, 100, 1_000_000),
  maxRequestBytes: parseIntEnv("BRIDGE_MAX_REQUEST_BYTES", 2 * 1024 * 1024, 1024, 64 * 1024 * 1024),
  corsOrigin: parseStringEnv("BRIDGE_CORS_ORIGIN", ""),
  healthVerbose: parseBoolEnv("BRIDGE_HEALTH_VERBOSE", false),
  defaultModelId: "claude-channel",
} as const;

export type Config = typeof config;
