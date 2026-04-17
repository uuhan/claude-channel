import { describe, expect, it } from "bun:test";
import { splitTextForStreaming, streamChunkExtraPause } from "../src/streaming";

describe("splitTextForStreaming", () => {
  it("returns empty array for empty string", () => {
    expect(splitTextForStreaming("", 3)).toEqual([]);
  });

  it("returns entire text as one chunk when chunkSize <= 0", () => {
    expect(splitTextForStreaming("hello", 0)).toEqual(["hello"]);
    expect(splitTextForStreaming("hello", -1)).toEqual(["hello"]);
  });

  it("splits ASCII text into chunks of given size", () => {
    expect(splitTextForStreaming("abcdefg", 3)).toEqual(["abc", "def", "g"]);
  });

  it("splits Unicode correctly by code points, not bytes", () => {
    expect(splitTextForStreaming("你好世界", 2)).toEqual(["你好", "世界"]);
  });

  it("handles emojis as single units", () => {
    const result = splitTextForStreaming("a🎉b🚀c", 2);
    expect(result.join("")).toEqual("a🎉b🚀c");
  });

  it("floors non-integer chunk sizes", () => {
    expect(splitTextForStreaming("abcd", 2.7)).toEqual(["ab", "cd"]);
  });
});

describe("streamChunkExtraPause", () => {
  it("returns 0 when punctPauseMs <= 0", () => {
    expect(streamChunkExtraPause("hello.", 0)).toBe(0);
  });

  it("returns 0 for empty or whitespace-only chunks", () => {
    expect(streamChunkExtraPause("", 100)).toBe(0);
    expect(streamChunkExtraPause("   ", 100)).toBe(0);
  });

  it("returns full pause after newline", () => {
    expect(streamChunkExtraPause("line\n", 100)).toBe(100);
  });

  it("returns half pause after minor punctuation (comma)", () => {
    expect(streamChunkExtraPause("hello,", 100)).toBe(50);
    expect(streamChunkExtraPause("你好，", 100)).toBe(50);
  });

  it("returns full pause after sentence terminator", () => {
    expect(streamChunkExtraPause("done.", 100)).toBe(100);
    expect(streamChunkExtraPause("really?", 100)).toBe(100);
    expect(streamChunkExtraPause("Wow!", 100)).toBe(100);
    expect(streamChunkExtraPause("这里。", 100)).toBe(100);
  });

  it("returns 0 for non-punctuation chunks", () => {
    expect(streamChunkExtraPause("hello", 100)).toBe(0);
    expect(streamChunkExtraPause("abc123", 100)).toBe(0);
  });
});
