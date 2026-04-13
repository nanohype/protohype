import type { AlmanacAnswer, Citation, ConnectorName, DocumentChunk, StaleWarning } from './types.js';

const STALE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function buildCitations(topChunks: DocumentChunk[]): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const chunk of topChunks) {
    if (!seen.has(chunk.docId)) {
      seen.add(chunk.docId);
      citations.push({
        docId: chunk.docId,
        title: chunk.title,
        url: chunk.url,
        lastModified: chunk.lastModified,
        source: chunk.source,
      });
    }
  }
  return citations;
}

export function computeStaleWarnings(citations: Citation[]): StaleWarning[] {
  const now = Date.now();
  return citations
    .filter(c => now - new Date(c.lastModified).getTime() > STALE_THRESHOLD_MS)
    .map(c => ({
      docTitle: c.title,
      lastModified: c.lastModified,
      daysAgo: Math.floor((now - new Date(c.lastModified).getTime()) / (24 * 60 * 60 * 1000)),
    }));
}

export function formatForSlack(answer: AlmanacAnswer): object {
  const blocks: object[] = [
    { type: 'section', text: { type: 'mrkdwn', text: answer.text } },
  ];

  if (answer.citations.length > 0) {
    const citationLines = answer.citations
      .map(c => {
        const dateStr = new Date(c.lastModified).toISOString().split('T')[0];
        return `• *<${c.url}|${c.title}>* — ${capitalize(c.source)} — Last updated: ${dateStr}`;
      })
      .join('\n');
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Sources:*\n${citationLines}` } });
  }

  if (answer.staleWarnings.length > 0) {
    const warnLines = answer.staleWarnings
      .map(w => `⚠️ *${w.docTitle}* was last updated ${w.daysAgo} days ago. Verify before acting.`)
      .join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: warnLines } });
  }

  const unavailable = Object.entries(answer.connectorStatuses)
    .filter(([, status]) => status === 'unavailable')
    .map(([name]) => capitalize(name as ConnectorName));

  if (unavailable.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `ℹ️ Could not reach ${unavailable.join(', ')} — results may be incomplete.` }],
    });
  }

  return { blocks };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
