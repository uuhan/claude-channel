import { describe, expect, it } from "bun:test";
import { normalizeContent, sanitizeMeta, truncate } from "../src/utils";

describe("truncate", () => {
  it("returns unchanged when shorter than max", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  it("truncates with suffix when over max", () => {
    const result = truncate("abcdefghij", 3);
    expect(result.startsWith("abc")).toBe(true);
    expect(result).toContain("truncated");
    expect(result).toContain("7 chars");
  });
});

describe("sanitizeMeta", () => {
  it("drops empty/undefined values", () => {
    expect(sanitizeMeta({ a: "1", b: "", c: undefined, d: "x" })).toEqual({ a: "1", d: "x" });
  });

  it("coerces numbers/booleans via String()", () => {
    expect(sanitizeMeta({ a: "1" as string, b: "true" })).toEqual({ a: "1", b: "true" });
  });
});

describe("normalizeContent", () => {
  it("handles string content", () => {
    expect(normalizeContent("hello", 100)).toBe("hello");
  });

  it("returns empty for null/undefined", () => {
    expect(normalizeContent(null, 100)).toBe("");
    expect(normalizeContent(undefined, 100)).toBe("");
  });

  it("joins array of parts", () => {
    expect(normalizeContent(["a", "b"], 100)).toBe("a\nb");
  });

  it("extracts text field from object parts", () => {
    expect(normalizeContent([{ text: "x" }, { text: "y" }], 100)).toBe("x\ny");
  });

  it("stringifies non-text object parts", () => {
    const result = normalizeContent([{ foo: "bar" }], 100);
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });

  it("stringifies JSON fallback for non-string content", () => {
    expect(normalizeContent({ k: 1 }, 100)).toBe('{"k":1}');
  });

  it("truncates when exceeding max", () => {
    const longStr = "a".repeat(200);
    const result = normalizeContent(longStr, 50);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain("truncated");
  });
});
