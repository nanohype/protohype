import { createExternalClient } from './http.js';
import { getSecretString } from './secrets.js';
import { logger } from './observability.js';

export interface DirectoryUserRecord {
  sub: string;
  email: string;
  squadIds: string[];
  slackUserId?: string | undefined;
}

export interface CreateDirectoryClientDeps {
  /** WorkOS REST base URL. Defaults to `WORKOS_API_BASE_URL` (which
   *  defaults to `https://api.workos.com`). */
  baseUrl?: string | undefined;
  /** WorkOS Directory ID. Defaults to `WORKOS_DIRECTORY_ID`. */
  directoryId?: string | undefined;
  /** Async accessor for the WorkOS API key; defaults to Secrets
   *  Manager (chorus/workos/api-key). */
  getApiToken?: () => Promise<string>;
  /** Inject the fetch implementation; defaults to native fetch. */
  fetchImpl?: typeof fetch;
}

export interface DirectoryClient {
  /**
   * List directory users in `groupId`. Squad IDs are extracted from
   * each user's group memberships by stripping the `chorus-squad-`
   * prefix from the group name — same convention the SQL ACL stores,
   * so the directory and the database agree on squad identifiers.
   */
  listUsers(filter: { groupId: string }): Promise<DirectoryUserRecord[]>;
}

interface WorkOSDirectoryUser {
  id: string;
  idp_id?: string;
  email?: string;
  emails?: Array<{ value: string; primary?: boolean }>;
  groups?: Array<{ id: string; name: string }>;
  custom_attributes?: { slack_user_id?: string };
}

interface WorkOSListResponse {
  object: 'list';
  data: WorkOSDirectoryUser[];
  list_metadata: { before: string | null; after: string | null };
}

const SQUAD_PREFIX = 'chorus-squad-';

export function createDirectoryClient(deps: CreateDirectoryClientDeps = {}): DirectoryClient {
  const baseUrl = deps.baseUrl ?? process.env['WORKOS_API_BASE_URL'] ?? 'https://api.workos.com';
  const directoryId = deps.directoryId ?? process.env['WORKOS_DIRECTORY_ID'];
  const getApiToken = deps.getApiToken ?? (() => getSecretString('chorus/workos/api-key'));
  const fetchImpl = deps.fetchImpl;

  return {
    async listUsers({ groupId }) {
      if (!directoryId) {
        logger.warn('WORKOS_DIRECTORY_ID not set');
        return [];
      }
      const token = await getApiToken();
      const http = createExternalClient({
        baseUrl,
        headers: { Authorization: `Bearer ${token}` },
        ...(fetchImpl ? { fetchImpl } : {}),
      });

      const users: DirectoryUserRecord[] = [];
      let after: string | null = null;
      do {
        const r: WorkOSListResponse = await http.request<WorkOSListResponse>({
          path: '/directory_users',
          params: {
            directory: directoryId,
            group: groupId,
            limit: 100,
            ...(after ? { after } : {}),
          },
        });
        for (const u of r.data ?? []) {
          const squadIds = (u.groups ?? [])
            .filter((g) => g.name.startsWith(SQUAD_PREFIX))
            .map((g) => g.name.slice(SQUAD_PREFIX.length));
          const email = u.email ?? u.emails?.find((e) => e.primary)?.value ?? u.emails?.[0]?.value;
          if (!email) continue;
          const record: DirectoryUserRecord = {
            sub: u.idp_id ?? u.id,
            email,
            squadIds,
          };
          const slackUserId = u.custom_attributes?.slack_user_id;
          if (slackUserId) record.slackUserId = slackUserId;
          users.push(record);
        }
        after = r.list_metadata?.after ?? null;
      } while (after);
      return users;
    },
  };
}
