import { describe, it, expect } from "vitest";
import { normalize, fullPromptSha256 } from "./normalize.js";

function encode(o: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(o));
}

const baseInput = {
  headers: { "content-type": "application/json" },
  identity: { ip: "1.2.3.4" },
  traceId: "t-1",
};

describe("normalize — openai-chat", () => {
  it("flattens string-content messages into segments", () => {
    const p = normalize({
      ...baseInput,
      upstream: "openai-chat",
      rawBody: encode({
        model: "gpt-4o",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      }),
    });
    expect(p.segments.map((s) => s.role)).toEqual(["user", "assistant"]);
    expect(p.text).toBe("hi\nhello");
    expect(p.upstream).toBe("openai-chat");
  });

  it("flattens array-of-content-blocks with mixed types", () => {
    const p = normalize({
      ...baseInput,
      upstream: "openai-chat",
      rawBody: encode({
        messages: [{ role: "user", content: [{ type: "text", text: "part-1" }, { type: "image_url" }, { type: "text", text: "part-2" }] }],
      }),
    });
    expect(p.text).toBe("part-1\n\npart-2");
  });

  it("returns empty segments on malformed JSON without throwing", () => {
    const p = normalize({ ...baseInput, upstream: "openai-chat", rawBody: new TextEncoder().encode("{not-json") });
    expect(p.segments).toEqual([]);
    expect(p.promptHash).toHaveLength(32);
  });
});

describe("normalize — anthropic-messages", () => {
  it("captures system + messages", () => {
    const p = normalize({
      ...baseInput,
      upstream: "anthropic-messages",
      rawBody: encode({
        system: "you are helpful",
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      }),
    });
    expect(p.segments.map((s) => s.role)).toEqual(["system", "user"]);
    expect(p.text).toBe("you are helpful\ngo");
  });

  it("handles string-system alongside string-content messages", () => {
    const p = normalize({
      ...baseInput,
      upstream: "anthropic-messages",
      rawBody: encode({ system: "be concise", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(p.text).toBe("be concise\nhi");
  });
});

describe("normalize — bedrock-invoke", () => {
  it("treats the raw body as opaque and stringifies it", () => {
    const p = normalize({
      ...baseInput,
      upstream: "bedrock-invoke",
      rawBody: encode({ prompt: "tell me a joke", max_tokens: 10 }),
    });
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]?.role).toBe("bedrock");
    expect(p.segments[0]?.text).toContain("tell me a joke");
  });
});

describe("normalize — identity + promptHash", () => {
  it("passes identity through unchanged", () => {
    const identity = { ip: "9.9.9.9", apiKeyHash: "abc", workspaceId: "ws-1" };
    const p = normalize({
      ...baseInput,
      identity,
      upstream: "openai-chat",
      rawBody: encode({ messages: [{ role: "user", content: "x" }] }),
    });
    expect(p.identity).toEqual(identity);
  });

  it("produces stable 32-char promptHash for identical inputs", () => {
    const a = normalize({ ...baseInput, upstream: "openai-chat", rawBody: encode({ messages: [{ role: "user", content: "same" }] }) });
    const b = normalize({ ...baseInput, upstream: "openai-chat", rawBody: encode({ messages: [{ role: "user", content: "same" }] }) });
    expect(a.promptHash).toBe(b.promptHash);
    expect(a.promptHash).toHaveLength(32);
  });

  it("fullPromptSha256 produces a 64-char hex digest over the flat text", () => {
    const p = normalize({ ...baseInput, upstream: "openai-chat", rawBody: encode({ messages: [{ role: "user", content: "x" }] }) });
    expect(fullPromptSha256(p)).toHaveLength(64);
  });
});
