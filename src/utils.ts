import type { IncomingMessage, ServerResponse } from "node:http";

export function sanitizeMeta(input: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value) continue;
    result[key] = String(value);
  }
  return result;
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)} ...[truncated ${text.length - maxLength} chars]`;
}

export function normalizeContent(content: unknown, maxChars: number): string {
  if (typeof content === "string") {
    return truncate(content, maxChars);
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const maybeText = (part as Record<string, unknown>).text;
          if (typeof maybeText === "string") return maybeText;
          return JSON.stringify(part);
        }
        return String(part);
      })
      .join("\n");
    return truncate(parts, maxChars);
  }
  if (content === null || typeof content === "undefined") return "";
  return truncate(JSON.stringify(content), maxChars);
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function sendJSON(res: ServerResponse<IncomingMessage>, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

export function writeSSEData(res: ServerResponse<IncomingMessage>, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeSSEDone(res: ServerResponse<IncomingMessage>) {
  res.write("data: [DONE]\n\n");
}

export async function readJSONBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
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
  if (!text.trim()) return {};
  return JSON.parse(text);
}

export function applyCorsHeaders(
  res: ServerResponse<IncomingMessage>,
  origin: string,
  requestOrigin?: string,
) {
  if (!origin) return;
  const allow = origin === "*" ? (requestOrigin || "*") : origin;
  res.setHeader("access-control-allow-origin", allow);
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-max-age", "86400");
  if (origin !== "*") {
    res.setHeader("vary", "origin");
  }
}
