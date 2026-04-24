import type { LlmUpstreamPort, UpstreamResponse } from "../ports/index.js";
import type { NormalizedPrompt, UpstreamShape } from "../types/prompt.js";

export interface UpstreamMap {
  readonly "openai-chat": string;
  readonly "anthropic-messages": string;
  readonly "bedrock-invoke": string;
}

export interface FetchUpstreamDeps {
  readonly upstreams: UpstreamMap;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}

/**
 * Concrete upstream forwarder over WHATWG fetch. Streams the response body
 * back so caller can stream to the client. AbortController enforces the
 * deadline. Detection happens OUTSIDE this module — by the time we forward,
 * the prompt has cleared the pipeline.
 */
export function createFetchUpstream(deps: FetchUpstreamDeps): LlmUpstreamPort {
  return {
    async forward(prompt: NormalizedPrompt): Promise<UpstreamResponse> {
      const url = resolveUpstreamUrl(deps.upstreams, prompt.upstream);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
      timer.unref?.();

      try {
        const headers: Record<string, string> = {};
        // Preserve auth + content-type on the forwarded request; drop palisade-
        // scoped headers. We do NOT add/alter authorization — palisade is a
        // prompt-injection gate, not a credential rewriter.
        for (const [k, v] of Object.entries(prompt.headers)) {
          if (k.startsWith("x-palisade-")) continue;
          if (k === "host" || k === "content-length") continue;
          headers[k] = v;
        }

        const response = await deps.fetchImpl(url, {
          method: "POST",
          headers,
          body: prompt.rawBody,
          signal: controller.signal,
        });

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        return {
          status: response.status,
          headers: responseHeaders,
          body: response.body,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function resolveUpstreamUrl(map: UpstreamMap, shape: UpstreamShape): string {
  switch (shape) {
    case "openai-chat":
      return `${map["openai-chat"]}/v1/chat/completions`;
    case "anthropic-messages":
      return `${map["anthropic-messages"]}/v1/messages`;
    case "bedrock-invoke":
      return `${map["bedrock-invoke"]}/model/invoke`;
  }
}
