import { NextResponse } from 'next/server';
import { approveProposal, rejectProposal, deferProposal } from '@/lib/api';

interface Body {
  newTitle?: string;
  reason?: string;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as Body;
  try {
    if (action === 'approve') {
      const r = await approveProposal(id, body.newTitle ? { newTitle: body.newTitle } : {});
      return NextResponse.json({ proposal: r });
    }
    if (action === 'reject') {
      const r = await rejectProposal(id, body.reason);
      return NextResponse.json({ proposal: r });
    }
    if (action === 'defer') {
      const r = await deferProposal(id, body.reason);
      return NextResponse.json({ proposal: r });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status });
  }
}
