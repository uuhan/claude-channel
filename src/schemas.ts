import { z } from "zod";

export const StartHttpServerSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    api_key: z.string().min(1).optional(),
    timeout_ms: z.number().int().min(1000).max(30 * 60 * 1000).optional(),
  })
  .optional();

export const ChannelReplySchema = z.object({
  request_id: z.string().min(1),
  content: z.string().min(1),
});

export const ChannelReplyStreamSchema = z.object({
  request_id: z.string().min(1),
  delta: z.string().optional(),
  done: z.boolean().optional(),
});

export const ChannelPublishSchema = z.object({
  content: z.string().min(1),
  meta: z.record(z.string(), z.string()).optional(),
});

export const CHANNEL_EVENT_KINDS = [
  "request",
  "publish",
  "reply",
  "stream_delta",
  "stream_done",
  "response",
  "response_chunk",
  "response_done",
  "response_error",
] as const;

export const ChannelDebugEventsSchema = z
  .object({
    limit: z.number().int().min(1).max(500).optional(),
    request_id: z.string().min(1).optional(),
    kind: z.enum(CHANNEL_EVENT_KINDS).optional(),
    source_type: z.string().min(1).optional(),
    stream: z.boolean().optional(),
  })
  .optional();

const OpenAIMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.unknown(),
  name: z.string().optional(),
});

const coerceBool = z.union([z.boolean(), z.literal("true"), z.literal("false")]).transform((v) => {
  if (typeof v === "boolean") return v;
  return v === "true";
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(OpenAIMessageSchema).min(1),
  stream: coerceBool.optional(),
  user: z.string().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  response_format: z.unknown().optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type OpenAIMessage = z.infer<typeof OpenAIMessageSchema>;
