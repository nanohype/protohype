/**
 * Tests for the auth layer (Secrets Manager client + per-service credential loaders).
 * Mocks the AWS SDK — never makes real AWS calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearSecretCache } from '../src/auth.js';

// ─── Mock AWS SDK ─────────────────────────────────────────────────────────────

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => {
  class MockSecretsManagerClient {
    send = mockSend;
  }
  class MockGetSecretValueCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    SecretsManagerClient: MockSecretsManagerClient,
    GetSecretValueCommand: MockGetSecretValueCommand,
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockSecret(value: Record<string, string>): void {
  mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify(value) });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('auth', () => {
  beforeEach(() => {
    clearSecretCache();
    mockSend.mockReset();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('getSecret', () => {
    it('fetches and parses a secret', async () => {
      mockSecret({ apiKey: 'test-key' });
      const { getSecret } = await import('../src/auth.js');
      const result = await getSecret('mcp-switchboard/hubspot');
      expect(result).toEqual({ apiKey: 'test-key' });
    });

    it('caches the secret on second call', async () => {
      mockSecret({ apiKey: 'test-key' });
      const { getSecret } = await import('../src/auth.js');
      await getSecret('mcp-switchboard/hubspot');
      await getSecret('mcp-switchboard/hubspot');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('throws when SecretString is missing', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: undefined });
      const { getSecret } = await import('../src/auth.js');
      await expect(getSecret('mcp-switchboard/missing')).rejects.toThrow("has no string value");
    });

    it('throws when SecretString is not valid JSON', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'not-json' });
      const { getSecret } = await import('../src/auth.js');
      await expect(getSecret('mcp-switchboard/bad')).rejects.toThrow("not valid JSON");
    });
  });

  describe('hubspotCredentials', () => {
    it('returns apiKey from secret', async () => {
      mockSecret({ apiKey: 'pat-na1-abc' });
      const { hubspotCredentials } = await import('../src/auth.js');
      const creds = await hubspotCredentials();
      expect(creds.apiKey).toBe('pat-na1-abc');
    });

    it('throws when apiKey is missing', async () => {
      mockSecret({ wrongKey: 'value' });
      const { hubspotCredentials } = await import('../src/auth.js');
      await expect(hubspotCredentials()).rejects.toThrow('missing apiKey');
    });
  });

  describe('gcseCredentials', () => {
    it('returns apiKey and engineId', async () => {
      mockSecret({ apiKey: 'AIza...', engineId: 'engine123' });
      const { gcseCredentials } = await import('../src/auth.js');
      const creds = await gcseCredentials();
      expect(creds.apiKey).toBe('AIza...');
      expect(creds.engineId).toBe('engine123');
    });

    it('throws when engineId is missing', async () => {
      mockSecret({ apiKey: 'AIza...' });
      const { gcseCredentials } = await import('../src/auth.js');
      await expect(gcseCredentials()).rejects.toThrow('missing engineId');
    });
  });

  describe('stripeCredentials', () => {
    it('returns secretKey', async () => {
      mockSecret({ secretKey: 'sk_test_abc' });
      const { stripeCredentials } = await import('../src/auth.js');
      const creds = await stripeCredentials();
      expect(creds.secretKey).toBe('sk_test_abc');
    });

    it('throws when secretKey is missing', async () => {
      mockSecret({ wrong: 'value' });
      const { stripeCredentials } = await import('../src/auth.js');
      await expect(stripeCredentials()).rejects.toThrow('missing secretKey');
    });
  });

  describe('analyticsCredentials', () => {
    it('returns serviceAccountKey and propertyId', async () => {
      const saKey = { client_email: 'sa@project.iam.gserviceaccount.com', private_key: 'key' };
      mockSecret({ serviceAccountKey: JSON.stringify(saKey), propertyId: '123456789' });
      const { analyticsCredentials } = await import('../src/auth.js');
      const creds = await analyticsCredentials();
      expect(creds.propertyId).toBe('123456789');
      expect(creds.serviceAccountKey).toEqual(saKey);
    });

    it('throws when propertyId is missing', async () => {
      const saKey = { client_email: 'sa@project.iam.gserviceaccount.com', private_key: 'key' };
      mockSecret({ serviceAccountKey: JSON.stringify(saKey) });
      const { analyticsCredentials } = await import('../src/auth.js');
      await expect(analyticsCredentials()).rejects.toThrow('missing propertyId');
    });
  });
});
