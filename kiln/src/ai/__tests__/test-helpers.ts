/** Shared test helper — builds a valid Bedrock TokenUsage mock object. */
export function mockUsage(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  cacheWriteInputTokens = 0,
) {
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

export function defaultMockUsage() {
  return mockUsage(100, 30, 80);
}
