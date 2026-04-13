/**
 * Slack Block Kit response formatter.
 * Produces structured message blocks with answer, sources, staleness warnings.
 */
import type { AskResult, RankedChunk } from '../types';

export function formatAskResponse(result: AskResult): object[] {
  const blocks: object[] = [];

  // Answer block
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: result.answer,
    },
  });

  // Connector errors (partial results warning)
  if (result.connectorErrors.length > 0) {
    const errorConnectors = result.connectorErrors
      .map((e) => `*${connectorDisplayName(e.connectorName)}* (${e.reason})`)
      .join(', ');
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `⚠️ *Partial results* — could not reach: ${errorConnectors}`,
        },
      ],
    });
  }

  // Sources section
  if (result.sources.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '*Sources* — filtered to your access permissions',
        },
      ],
    });

    // Deduplicate by docUrl (multiple chunks from same doc → one source entry)
    const seenUrls = new Set<string>();
    const dedupedSources: RankedChunk[] = [];
    for (const source of result.sources) {
      if (!seenUrls.has(source.docUrl)) {
        seenUrls.add(source.docUrl);
        dedupedSources.push(source);
      }
    }

    for (const source of dedupedSources.slice(0, 5)) {
      const freshness = formatFreshness(source);
      const staleIndicator = source.isStale ? '⚠️ ' : '';
      const unknownFreshness = source.freshnessUnknown ? '❓ ' : '';

      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${staleIndicator}${unknownFreshness}<${source.docUrl}|${source.docTitle}> · ${freshness}${source.author ? ` · ${source.author}` : ''} · _${connectorDisplayName(source.connectorName)}_`,
          },
        ],
      });
    }
  }

  // Footer
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `_AcmeAsk · ${result.latencyMs}ms · ${result.modelUsed}_`,
      },
    ],
  });

  return blocks;
}

export function formatConnectMessage(connectedConnectors: string[]): object[] {
  const missing = ['Notion', 'Confluence', 'Google Drive'].filter(
    (c) => !connectedConnectors.includes(c)
  );

  if (missing.length === 0) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '✅ All knowledge sources connected! Ask me anything.',
        },
      },
    ];
  }

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `👋 *Welcome to AcmeAsk!* Connect your knowledge sources to get started.\n\nMissing: *${missing.join(', ')}*`,
      },
    },
    {
      type: 'actions',
      elements: missing.map((connector) => ({
        type: 'button',
        text: { type: 'plain_text', text: `Connect ${connector}` },
        action_id: `connect_${connector.toLowerCase().replace(' ', '_')}`,
        style: 'primary',
      })),
    },
  ];
}

export function formatStaleWarning(staleCount: number): string {
  return `⚠️ *Heads up:* ${staleCount} source${staleCount > 1 ? 's' : ''} hasn't been updated in over ${90} days. Verify before acting on this information.`;
}

export function formatRateLimitMessage(): object[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🚦 You've reached the query limit (20 per hour). Please try again later.`,
      },
    },
  ];
}

function formatFreshness(source: RankedChunk): string {
  if (source.freshnessUnknown) return 'Unknown freshness';
  if (!source.lastModifiedAt) return 'Unknown freshness';
  const daysAgo = Math.floor(
    (Date.now() - source.lastModifiedAt.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (daysAgo === 0) return 'Updated today';
  if (daysAgo === 1) return 'Updated yesterday';
  return `Updated ${daysAgo}d ago`;
}

function connectorDisplayName(name: string): string {
  const map: Record<string, string> = {
    notion: 'Notion',
    confluence: 'Confluence',
    'google-drive': 'Google Drive',
  };
  return map[name] ?? name;
}
