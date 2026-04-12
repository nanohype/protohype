import { get, post, mcpEnvelope, API_TOKEN, API_ENDPOINT } from './helpers';

/**
 * API Gateway HTTP API with HttpLambdaAuthorizer returns:
 *   - 401 when the identity source (Authorization header) is missing entirely
 *   - 403 when the authorizer runs and returns isAuthorized: false
 * Both are auth failures; tests assert the specific behavior to catch regressions.
 */
describe('authorizer — GET /dashboard/api/summary', () => {
  test('no Authorization header → 401', async () => {
    const res = await get('/dashboard/api/summary', { auth: false });
    expect(res.status).toBe(401);
  });

  test('empty bearer token → 403', async () => {
    const raw = await fetch(`${API_ENDPOINT}/dashboard/api/summary`, {
      headers: { Authorization: 'Bearer ' },
    });
    expect(raw.status).toBe(403);
  });

  test('wrong bearer token → 403', async () => {
    const res = await get('/dashboard/api/summary', { auth: 'bogus-token-that-will-never-match' });
    expect(res.status).toBe(403);
  });

  test('wrong auth scheme (Basic) → 403', async () => {
    const res = await get('/dashboard/api/summary', { headers: { Authorization: 'Basic dXNlcjpwYXNz' }, auth: false });
    expect(res.status).toBe(403);
  });

  test('correct bearer token → 200', async () => {
    const res = await get('/dashboard/api/summary');
    expect(res.status).toBe(200);
  });
});

describe('authorizer — POST /memory', () => {
  const listBody = mcpEnvelope('tools/list');

  test('no Authorization header → 401', async () => {
    const res = await post('/memory', listBody, { auth: false });
    expect(res.status).toBe(401);
  });

  test('wrong bearer token → 403', async () => {
    const res = await post('/memory', listBody, { auth: 'bogus-token' });
    expect(res.status).toBe(403);
  });

  test('correct bearer token → 200', async () => {
    const res = await post('/memory', listBody, { auth: API_TOKEN });
    expect(res.status).toBe(200);
  });
});
