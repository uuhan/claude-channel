import { describe, expect, it } from "bun:test";
import {
  ChannelProtocolError,
  ChannelTimeoutError,
  ChannelTransportError,
  errorToOpenAIPayload,
} from "../src/errors";

describe("ChannelTimeoutError", () => {
  it("includes timeout in message", () => {
    const err = new ChannelTimeoutError(5000);
    expect(err.message).toContain("5000ms");
    expect(err.name).toBe("ChannelTimeoutError");
  });
});

describe("errorToOpenAIPayload", () => {
  it("maps timeout errors to 504", () => {
    const { status, body } = errorToOpenAIPayload(new ChannelTimeoutError(1000));
    expect(status).toBe(504);
    expect(body.type).toBe("timeout_error");
    expect(body.code).toBe("claude_reply_timeout");
  });

  it("maps transport errors to 502", () => {
    const { status, body } = errorToOpenAIPayload(new ChannelTransportError("boom"));
    expect(status).toBe(502);
    expect(body.type).toBe("upstream_error");
  });

  it("maps protocol errors to 502", () => {
    const { status, body } = errorToOpenAIPayload(new ChannelProtocolError("bad"));
    expect(status).toBe(502);
    expect(body.type).toBe("upstream_error");
  });

  it("falls back to 500 for unknown errors", () => {
    const { status, body } = errorToOpenAIPayload(new Error("oops"));
    expect(status).toBe(500);
    expect(body.type).toBe("server_error");
  });
});
