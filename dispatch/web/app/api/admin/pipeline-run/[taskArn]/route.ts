import { proxyRequest } from '@/lib/api';

export const dynamic = 'force-dynamic';

// taskArn is URL-encoded by the browser before reaching Next.js. Next.js
// gives us the decoded value via the route param. The Fastify API uses a
// wildcard route (/admin/pipeline-run/*) so slashes in the ARN are fine —
// just append the raw value to the proxy path. encodeURIComponent here would
// double-encode (Fastify decodes once and would see %2F as a literal).
export async function GET(_req: Request, { params }: { params: Promise<{ taskArn: string }> }) {
  const { taskArn } = await params;
  return proxyRequest('GET', `/admin/pipeline-run/${taskArn}`);
}
