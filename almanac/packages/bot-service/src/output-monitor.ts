/**
 * LLM output monitor -- blocks prompt injection artifacts before posting to Slack.
 * Required by qa-security threat model (T3 indirect prompt injection).
 */

const SYSTEM_PROMPT_LEAKAGE = [
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

const COMMAND_EXECUTION = [
  /^(sudo|bash|sh|cmd|powershell|curl|wget|rm|cat)\s/im,
  /\$\([^)]+\)/,
];

export interface MonitorResult {
  safe: boolean;
  triggeredPattern?: string;
}

export function monitorOutput(text: string, sessionId: string): MonitorResult {
  for (const p of SYSTEM_PROMPT_LEAKAGE) {
    if (p.test(text)) {
      console.error(`[OutputMonitor] [SECURITY] System prompt leakage session=${sessionId} pattern=${p.source}`);
      return { safe: false, triggeredPattern: `system_prompt_leakage:${p.source}` };
    }
  }
  for (const p of JAILBREAK_INDICATORS) {
    if (p.test(text)) {
      console.error(`[OutputMonitor] [SECURITY] Jailbreak indicator session=${sessionId} pattern=${p.source}`);
      return { safe: false, triggeredPattern: `jailbreak:${p.source}` };
    }
  }
  for (const p of COMMAND_EXECUTION) {
    if (p.test(text)) {
      console.warn(`[OutputMonitor] Command pattern session=${sessionId} pattern=${p.source}`);
      return { safe: false, triggeredPattern: `command_execution:${p.source}` };
    }
  }
  return { safe: true };
}

export const BLOCKED_RESPONSE =
  "I wasn't able to generate a safe response to that question. Please try rephrasing.";
