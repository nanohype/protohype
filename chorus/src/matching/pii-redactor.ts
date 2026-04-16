import { ComprehendClient, DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import { logger, withCorrelation } from '../lib/observability.js';
import { auditLog, type AuditPort } from '../lib/audit.js';
import { awsRegion, AWS_MAX_ATTEMPTS } from '../lib/aws.js';
import type { RedactedText } from './redacted-text.js';

// The redactor is the trusted producer of `RedactedText`. Branding
// happens locally so no other module needs access to this cast.
const brand = (s: string): RedactedText => s as RedactedText;

const PII_PATTERNS = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, placeholder: '[EMAIL]' },
  { pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, placeholder: '[PHONE]' },
  { pattern: /(?:user|email|id)=[^&\s"'<>]+/gi, placeholder: '[URL_PARAM_REDACTED]' },
];
const COMPREHEND_PII_TYPES = new Set([
  'NAME',
  'EMAIL',
  'PHONE',
  'ADDRESS',
  'URL',
  'USERNAME',
  'PASSWORD',
]);

export interface RedactionResult {
  redactedText: RedactedText;
  piiDetected: boolean;
  entitiesFound: string[];
}

/**
 * Tiny port over the Comprehend SDK. Only the `send` shape we use:
 * `send(new DetectPiiEntitiesCommand(...))` returning a value with an
 * `.Entities` array. Tests pass a `vi.fn(async (cmd) => ({ Entities }))`
 * — they never `vi.mock('@aws-sdk/client-comprehend')`.
 */
export interface ComprehendPort {
  send(command: DetectPiiEntitiesCommand): Promise<{
    Entities?: Array<{
      Type?: string;
      Score?: number;
      BeginOffset?: number;
      EndOffset?: number;
    }>;
  }>;
}

export interface PiiRedactorDeps {
  comprehend: ComprehendPort;
  audit: AuditPort;
}

function defaultComprehend(): ComprehendPort {
  return new ComprehendClient({ region: awsRegion(), maxAttempts: AWS_MAX_ATTEMPTS });
}

export function createPiiRedactor(
  deps: Partial<PiiRedactorDeps> = {},
): (correlationId: string, text: string) => Promise<RedactionResult> {
  const comprehend = deps.comprehend ?? defaultComprehend();
  const audit = deps.audit ?? auditLog;
  return async (correlationId, text) =>
    withCorrelation(correlationId, 'REDACT', async () => {
      if (!text?.trim()) return { redactedText: brand(''), piiDetected: false, entitiesFound: [] };
      let working = text;
      for (const { pattern, placeholder } of PII_PATTERNS)
        working = working.replace(pattern, placeholder);
      const entitiesFound: string[] = [];
      try {
        const response = await comprehend.send(
          new DetectPiiEntitiesCommand({ Text: working.slice(0, 5000), LanguageCode: 'en' }),
        );
        const relevant = (response.Entities ?? [])
          .filter((e) => e.Type && COMPREHEND_PII_TYPES.has(e.Type) && (e.Score ?? 0) >= 0.9)
          .sort((a, b) => (b.BeginOffset ?? 0) - (a.BeginOffset ?? 0));
        for (const e of relevant) {
          working =
            working.slice(0, e.BeginOffset ?? 0) + `[${e.Type}]` + working.slice(e.EndOffset ?? 0);
          entitiesFound.push(e.Type ?? 'UNKNOWN');
        }
      } catch (err) {
        logger.error('Comprehend failed', { correlationId, error: String(err) });
        throw err;
      }
      await audit({
        correlationId,
        stage: 'REDACT',
        detail: { piiDetected: entitiesFound.length > 0, entityTypes: entitiesFound },
      });
      return {
        redactedText: brand(working),
        piiDetected: entitiesFound.length > 0,
        entitiesFound,
      };
    });
}

/** Backwards-compatible default singleton — uses the real Comprehend
 *  client and the real auditLog. Production code calls this; tests
 *  build their own redactor via `createPiiRedactor({ comprehend, audit })`. */
export const redactPii = createPiiRedactor();
