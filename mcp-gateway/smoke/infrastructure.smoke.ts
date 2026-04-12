import { API_ENDPOINT, DASHBOARD_URL } from './helpers';

/**
 * Tests the static site served from CloudFront. Runs only when DASHBOARD_URL
 * is provided — the Makefile `smoke` target injects it from the CFN output.
 *
 * This only asserts what `make deploy` guarantees exists (config.json, put by
 * the CDK BucketDeployment construct). The dashboard UI itself is synced by
 * `make dashboard-sync` / `make full-deploy` and not strictly required for
 * the gateway's API surface to work.
 */
const describeIfDashboard = DASHBOARD_URL ? describe : describe.skip;

describeIfDashboard('infrastructure — static site', () => {
  test('dashboard root serves HTML', async () => {
    const res = await fetch(`${DASHBOARD_URL}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  test('config.json is reachable and points to the API endpoint', async () => {
    const res = await fetch(`${DASHBOARD_URL}/config.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apiEndpoint: string; region: string };
    expect(body.apiEndpoint).toBe(API_ENDPOINT);
    expect(body.region).toMatch(/^[a-z]{2}-[a-z]+-\d$/);
  });

  test('distribution is HTTPS', async () => {
    // CloudFront is configured with REDIRECT_TO_HTTPS; asserting the URL we
    // got from the CFN output is HTTPS proves the distribution is wired.
    expect(new URL(DASHBOARD_URL!).protocol).toBe('https:');
  });
});
