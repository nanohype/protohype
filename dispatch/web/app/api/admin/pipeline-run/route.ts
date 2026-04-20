import { proxyRequest } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function POST() {
  return proxyRequest('POST', '/admin/pipeline-run');
}
