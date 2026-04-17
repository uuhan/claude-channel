export class ChannelTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out waiting for Claude Code reply after ${timeoutMs}ms`);
    this.name = "ChannelTimeoutError";
  }
}

export class ChannelTransportError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ChannelTransportError";
  }
}

export class ChannelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelProtocolError";
  }
}

export function errorToOpenAIPayload(error: Error) {
  if (error instanceof ChannelTimeoutError) {
    return {
      status: 504,
      body: {
        type: "timeout_error",
        message: error.message,
        code: "claude_reply_timeout",
      },
    } as const;
  }
  if (error instanceof ChannelTransportError || error instanceof ChannelProtocolError) {
    return {
      status: 502,
      body: {
        type: "upstream_error",
        message: error.message,
        code: "claude_channel_error",
      },
    } as const;
  }
  return {
    status: 500,
    body: {
      type: "server_error",
      message: error.message || "Internal server error",
      code: "server_error",
    },
  } as const;
}
