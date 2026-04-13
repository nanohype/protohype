/**
 * LLM output monitor for Almanac bot service.
 *
 * Detects and blocks prompt injection artifacts in LLM responses before
 * posting to Slack. Required by qa-security (gate feedback item).
 *
 * Detection strategy:
 * 1. System prompt leakage: response contains system prompt keywords
 * 2. Context leakage: response contains "[CONTEXT START]" or "[CONTEXT END]"
 * 3. Jailbreak success indicators: response claims to bypass its instructions
 * 4. Unusual instruction-following: response starts executing embedded commands
 */

const SYSTEM_PROMPT_LEAKAGE_PATTERNS = [
  /\[CONTEXT START\]/i,
  /\[CONTEXT END\]/i,
  /you are almanac/i,
  /NanoCorp'?s? internal knowledge assistant/i,
  /rules:\s*1\./i,
  /only use information from the provided excerpts/i,
];

const JAILBREAK_INDICATORS = [
  /ignore.{0,20}previous instructions/i,
  /disregard.{0,20}instructions/i,
  /my new instructions/i,
  /DAN mode/i,
  /pretend.{0,20}you are/i,
  /bypass.{0,20}restrictions/i,
];

const COMMAND_EXECUTION_PATTERNS = [
  /^(sudo|bash|sh|cmd|powershell|curl|wget|rm|cat)\s/im,
  /\$\([^)]+\)/,
  /`[^`]+`/,
];

export interface MonitorResult {
  safe: boolean;
  triggeredPattern?: string;
  sanitizedText?: string;
}

export function monitorOutput(
  text: string,
  sessionId: string
): MonitorResult {
  for (const pattern of SYSTEM_PROMPT_LEAKAGE_PATTERNS) {
    if (pattern.test(text)) {
      console.error(
        `[OutputMonitor] [SECURITY] System prompt leakage detected in session ${sessionId}. Pattern: ${pattern}`
      );
      return { safe: false, triggeredPattern: `system_prompt_leakage:${pattern.source}` };
    }
  }

  for (const pattern of JAILBREAK_INDICATORS) {
    if (pattern.test(text)) {
      console.error(
        `[OutputMonitor] [SECURITY] Jailbreak indicator in LLM output for session ${sessionId}. Pattern: ${pattern}`
      );
      return { safe: false, triggeredPattern: `jailbreak:${pattern.source}` };
    }
  }

  for (const pattern of COMMAND_EXECUTION_PATTERNS) {
    if (pattern.test(text)) {
      console.warn(
        `[OutputMonitor] Command pattern in output for session ${sessionId}. Pattern: ${pattern}`
      );
      return { safe: false, triggeredPattern: `command_execution:${pattern.source}` };
    }
  }

  return { safe: true };
}

export const BLOCKED_RESPONSE =
  "I wasn't able to generate a safe response to that question. Please try rephrasing.";
