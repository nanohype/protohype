import { get } from './helpers';

describe('health', () => {
  test('GET /health returns 200 without auth', async () => {
    const res = await get<{ status: string; service: string; ts: string }>('/health', { auth: false });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('mcp-gateway');
    expect(Number.isNaN(Date.parse(res.body.ts))).toBe(false);
  });
});
