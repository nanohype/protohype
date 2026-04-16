import type { Pool } from 'pg';
import { createExternalClient } from '../lib/http.js';
import { logger } from '../lib/observability.js';
import { auditLog, type AuditPort } from '../lib/audit.js';
import type { RedactedText } from '../matching/redacted-text.js';

export interface LinearConfig {
  baseUrl?: string;
  getApiToken: () => Promise<string>;
  teamId?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  audit?: AuditPort;
}

export interface LinearSync {
  mirror(deps: { db: Pool }): Promise<{ upserted: number }>;
  addComment(opts: {
    correlationId: string;
    linearIssueId: string;
    redactedText: RedactedText;
    sourceUrl?: string | null;
  }): Promise<void>;
  createIssue(opts: {
    correlationId: string;
    title: string;
    descriptionRedacted: RedactedText;
  }): Promise<{ linearId: string }>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface IssueNode {
  id: string;
  title: string;
  description?: string | null;
}

interface IssuesQueryData {
  issues: {
    nodes: IssueNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface IssueCreateData {
  issueCreate: { success: boolean; issue: { id: string; identifier: string } };
}

interface CommentCreateData {
  commentCreate: { success: boolean };
}

const ISSUES_QUERY = `
  query Issues($first: Int!, $after: String, $teamId: String) {
    issues(first: $first, after: $after, filter: { team: { id: { eq: $teamId } } }) {
      nodes { id title description }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CREATE_ISSUE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier }
    }
  }
`;

const CREATE_COMMENT_MUTATION = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) { success }
  }
`;

export function createLinearSync(config: LinearConfig): LinearSync {
  const baseUrl = config.baseUrl ?? 'https://api.linear.app';
  const teamId = config.teamId ?? process.env['LINEAR_TEAM_ID'];
  const audit = config.audit ?? auditLog;

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await config.getApiToken();
    const http = createExternalClient({
      baseUrl,
      headers: { Authorization: token },
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    });
    const result = await http.request<GraphQLResponse<T>>({
      method: 'POST',
      path: '/graphql',
      body: { query, variables },
    });
    if (result.errors?.length) {
      throw new Error(`Linear GraphQL: ${result.errors[0]!.message}`);
    }
    if (!result.data) {
      throw new Error('Linear GraphQL: empty response');
    }
    return result.data;
  }

  return {
    async mirror({ db }) {
      if (!teamId) {
        logger.warn('LINEAR_TEAM_ID not set — skipping mirror');
        return { upserted: 0 };
      }
      let upserted = 0;
      let after: string | null = null;
      let hasMore = true;

      while (hasMore) {
        const page: IssuesQueryData = await graphql<IssuesQueryData>(ISSUES_QUERY, {
          first: 50,
          after,
          teamId,
        });
        for (const issue of page.issues.nodes) {
          await db.query(
            `INSERT INTO backlog_entries (linear_id, title, description)
             VALUES ($1, $2, $3)
             ON CONFLICT (linear_id) DO UPDATE
               SET title = EXCLUDED.title,
                   description = EXCLUDED.description`,
            [issue.id, issue.title, issue.description ?? null],
          );
          upserted++;
        }
        hasMore = page.issues.pageInfo.hasNextPage;
        after = page.issues.pageInfo.endCursor;
      }

      logger.info('linear mirror complete', { upserted });
      return { upserted };
    },

    async addComment({ correlationId, linearIssueId, redactedText, sourceUrl }) {
      const lines = [String(redactedText)];
      if (sourceUrl) lines.push(`\n[Source](${sourceUrl})`);
      lines.push(`\n---\n_chorus correlation: ${correlationId}_`);

      await graphql<CommentCreateData>(CREATE_COMMENT_MUTATION, {
        input: { issueId: linearIssueId, body: lines.join('') },
      });
    },

    async createIssue({ correlationId, title, descriptionRedacted }) {
      if (!teamId) throw new Error('LINEAR_TEAM_ID is required to create issues');

      const result: IssueCreateData = await graphql<IssueCreateData>(CREATE_ISSUE_MUTATION, {
        input: {
          teamId,
          title,
          description: `${String(descriptionRedacted)}\n\n---\n_chorus correlation: ${correlationId}_`,
        },
      });

      if (!result.issueCreate.success) {
        throw new Error('Linear issueCreate returned success=false');
      }

      const linearId = result.issueCreate.issue.id;

      await audit({
        correlationId,
        stage: 'LINEAR_CREATE',
        actor: 'system',
        detail: { linearId, identifier: result.issueCreate.issue.identifier },
      });

      return { linearId };
    },
  };
}
