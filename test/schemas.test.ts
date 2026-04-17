import { describe, expect, it } from "bun:test";
import { ChatCompletionRequestSchema } from "../src/schemas";

describe("ChatCompletionRequestSchema", () => {
  it("parses a minimal valid request", () => {
    const parsed = ChatCompletionRequestSchema.parse({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.stream).toBeUndefined();
  });

  it("rejects empty messages", () => {
    expect(() =>
      ChatCompletionRequestSchema.parse({ messages: [] }),
    ).toThrow();
  });

  it("rejects invalid roles", () => {
    expect(() =>
      ChatCompletionRequestSchema.parse({
        messages: [{ role: "admin", content: "x" }],
      }),
    ).toThrow();
  });

  it("coerces string 'true' into boolean stream=true", () => {
    const parsed = ChatCompletionRequestSchema.parse({
      messages: [{ role: "user", content: "hi" }],
      stream: "true",
    });
    expect(parsed.stream).toBe(true);
  });

  it("coerces string 'false' into boolean stream=false", () => {
    const parsed = ChatCompletionRequestSchema.parse({
      messages: [{ role: "user", content: "hi" }],
      stream: "false",
    });
    expect(parsed.stream).toBe(false);
  });

  it("accepts boolean stream=true as-is", () => {
    const parsed = ChatCompletionRequestSchema.parse({
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(parsed.stream).toBe(true);
  });

  it("accepts and preserves optional OpenAI params", () => {
    const parsed = ChatCompletionRequestSchema.parse({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      max_tokens: 1000,
      top_p: 0.9,
      user: "alice",
    });
    expect(parsed.temperature).toBe(0.7);
    expect(parsed.max_tokens).toBe(1000);
    expect(parsed.user).toBe("alice");
  });

  it("accepts tools array without validating structure", () => {
    const parsed = ChatCompletionRequestSchema.parse({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "foo" } }],
    });
    expect(parsed.tools).toBeDefined();
    expect(parsed.tools).toHaveLength(1);
  });
});
