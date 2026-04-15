/**
 * Pii-redactor service tests. Uses port injection (no
 * `vi.mock('@aws-sdk/client-comprehend')`): `createPiiRedactor`
 * accepts `comprehend: ComprehendPort` and `audit: AuditPort`; the
 * test passes `vi.fn` impls and asserts on the parsed return value
 * AND the AuditLogEntry shape forwarded to audit.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import { createPiiRedactor, type ComprehendPort } from './pii-redactor.js';
import type { AuditPort, AuditLogEntry } from '../lib/audit.js';

function fakeComprehend(
  responses: Array<{ Entities?: Array<Record<string, unknown>> }> = [{ Entities: [] }],
): ComprehendPort {
  let i = 0;
  return {
    send: vi.fn(async (_cmd: DetectPiiEntitiesCommand) => {
      const r = responses[Math.min(i, responses.length - 1)] ?? { Entities: [] };
      i++;
      return r;
    }),
  };
}

function fakeAudit(): { audit: AuditPort; calls: AuditLogEntry[] } {
  const calls: AuditLogEntry[] = [];
  const audit: AuditPort = async (entry) => {
    calls.push(entry);
  };
  return { audit, calls };
}

describe('createPiiRedactor', () => {
  it('returns RedactedText (branded) and audits a REDACT entry on every call', async () => {
    const { audit, calls } = fakeAudit();
    const redact = createPiiRedactor({ comprehend: fakeComprehend(), audit });
    const r = await redact('corr-1', 'no PII here');
    expect(r.piiDetected).toBe(false);
    expect(r.entitiesFound).toEqual([]);
    expect(typeof r.redactedText).toBe('string');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      correlationId: 'corr-1',
      stage: 'REDACT',
      detail: { piiDetected: false, entityTypes: [] },
    });
  });

  it('replaces emails via regex before invoking Comprehend', async () => {
    const comprehend = fakeComprehend();
    const { audit } = fakeAudit();
    const redact = createPiiRedactor({ comprehend, audit });
    const r = await redact('corr-2', 'Contact alice@example.com about the bug');
    expect(String(r.redactedText)).toContain('[EMAIL]');
    expect(String(r.redactedText)).not.toContain('alice@example.com');
    const sendMock = comprehend.send as ReturnType<typeof vi.fn>;
    const cmd = sendMock.mock.calls[0]?.[0] as { input: { Text?: string } };
    expect(cmd.input.Text).toContain('[EMAIL]');
  });

  it('replaces phone numbers via regex', async () => {
    const { audit } = fakeAudit();
    const redact = createPiiRedactor({ comprehend: fakeComprehend(), audit });
    const r = await redact('corr-3', 'Call us at 415-555-0199');
    expect(String(r.redactedText)).toContain('[PHONE]');
    expect(String(r.redactedText)).not.toContain('555-0199');
  });

  it('applies Comprehend NAME entity replacement at the byte offsets returned by the SDK', async () => {
    const { audit, calls } = fakeAudit();
    const comprehend = fakeComprehend([
      { Entities: [{ Type: 'NAME', Score: 0.99, BeginOffset: 6, EndOffset: 11 }] },
    ]);
    const redact = createPiiRedactor({ comprehend, audit });
    const r = await redact('corr-4', 'Hello Alice, your ticket is open');
    expect(String(r.redactedText)).toContain('[NAME]');
    expect(r.entitiesFound).toContain('NAME');
    expect(r.piiDetected).toBe(true);
    expect(calls[0]?.detail).toMatchObject({ piiDetected: true, entityTypes: ['NAME'] });
  });

  it('drops Comprehend entities below the 0.9 confidence threshold', async () => {
    const { audit } = fakeAudit();
    const comprehend = fakeComprehend([
      { Entities: [{ Type: 'NAME', Score: 0.5, BeginOffset: 0, EndOffset: 5 }] },
    ]);
    const redact = createPiiRedactor({ comprehend, audit });
    const r = await redact('corr-5', 'Smith is here');
    expect(r.piiDetected).toBe(false);
    expect(String(r.redactedText)).not.toContain('[NAME]');
  });

  it('short-circuits on empty input without calling Comprehend or audit', async () => {
    const { audit, calls } = fakeAudit();
    const comprehend = fakeComprehend();
    const redact = createPiiRedactor({ comprehend, audit });
    const r = await redact('corr-6', '   ');
    expect(String(r.redactedText)).toBe('');
    expect(r.piiDetected).toBe(false);
    expect(comprehend.send).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('rethrows after logging when Comprehend errors so the pipeline DLQ catches the failure', async () => {
    const { audit } = fakeAudit();
    const comprehend: ComprehendPort = {
      send: vi.fn(async () => {
        throw new Error('Comprehend 503');
      }),
    };
    const redact = createPiiRedactor({ comprehend, audit });
    await expect(redact('corr-7', 'has @ to find')).rejects.toThrow('Comprehend 503');
  });
});
