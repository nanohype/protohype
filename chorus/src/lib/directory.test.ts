import { describe, it, expect, vi } from 'vitest';
import { createDirectoryClient } from './directory.js';

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const BASE = 'https://api.workos.test';
const DIR = 'directory_01';
const GROUP = 'directory_group_pms';

describe('DirectoryClient.listUsers', () => {
  it('returns [] when WORKOS_DIRECTORY_ID is missing (logs a warning)', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const c = createDirectoryClient({
      baseUrl: BASE,
      directoryId: undefined,
      getApiToken: async () => 't',
      fetchImpl,
    });
    expect(await c.listUsers({ groupId: GROUP })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('queries /directory_users with Bearer auth + directory & group params', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ok({ object: 'list', data: [], list_metadata: { before: null, after: null } }),
    );
    const c = createDirectoryClient({
      baseUrl: BASE,
      directoryId: DIR,
      getApiToken: async () => 'sk_test',
      fetchImpl,
    });
    await c.listUsers({ groupId: GROUP });
    const call = fetchImpl.mock.calls[0]!;
    const url = new URL(String(call[0]));
    expect(url.host).toBe('api.workos.test');
    expect(url.pathname).toBe('/directory_users');
    expect(url.searchParams.get('directory')).toBe(DIR);
    expect(url.searchParams.get('group')).toBe(GROUP);
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('after')).toBeNull();
    expect((call[1]?.headers as Record<string, string>)['Authorization']).toBe('Bearer sk_test');
  });

  it('maps WorkOS DirectoryUser → DirectoryUserRecord, stripping chorus-squad- prefix', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ok({
        object: 'list',
        data: [
          {
            id: 'directory_user_01',
            idp_id: 'idp-001',
            email: 'alice@acme.com',
            groups: [
              { id: 'g1', name: 'chorus-squad-growth' },
              { id: 'g2', name: 'unrelated' },
            ],
            custom_attributes: { slack_user_id: 'U-1' },
          },
        ],
        list_metadata: { before: null, after: null },
      }),
    );
    const c = createDirectoryClient({
      baseUrl: BASE,
      directoryId: DIR,
      getApiToken: async () => 't',
      fetchImpl,
    });
    const r = await c.listUsers({ groupId: GROUP });
    expect(r).toEqual([
      {
        sub: 'idp-001',
        email: 'alice@acme.com',
        squadIds: ['growth'],
        slackUserId: 'U-1',
      },
    ]);
  });

  it('falls back to id when idp_id is missing, and primary email when only emails[] is present', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ok({
        object: 'list',
        data: [
          {
            id: 'directory_user_02',
            emails: [
              { value: 'secondary@acme.com', primary: false },
              { value: 'primary@acme.com', primary: true },
            ],
            groups: [{ id: 'g1', name: 'chorus-squad-billing' }],
          },
        ],
        list_metadata: { before: null, after: null },
      }),
    );
    const c = createDirectoryClient({
      baseUrl: BASE,
      directoryId: DIR,
      getApiToken: async () => 't',
      fetchImpl,
    });
    const r = await c.listUsers({ groupId: GROUP });
    expect(r[0]?.sub).toBe('directory_user_02');
    expect(r[0]?.email).toBe('primary@acme.com');
    expect(r[0]?.squadIds).toEqual(['billing']);
    expect(r[0]?.slackUserId).toBeUndefined();
  });

  it('skips users with no resolvable email', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ok({
        object: 'list',
        data: [{ id: 'directory_user_x', groups: [{ id: 'g1', name: 'chorus-squad-growth' }] }],
        list_metadata: { before: null, after: null },
      }),
    );
    const c = createDirectoryClient({
      baseUrl: BASE,
      directoryId: DIR,
      getApiToken: async () => 't',
      fetchImpl,
    });
    expect(await c.listUsers({ groupId: GROUP })).toEqual([]);
  });

  it('paginates by passing list_metadata.after as the next request cursor', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        ok({
          object: 'list',
          data: [
            {
              id: 'u1',
              email: '1@x.com',
              groups: [{ id: 'g', name: 'chorus-squad-a' }],
            },
            {
              id: 'u2',
              email: '2@x.com',
              groups: [{ id: 'g', name: 'chorus-squad-b' }],
            },
          ],
          list_metadata: { before: null, after: 'cursor_page2' },
        }),
      )
      .mockResolvedValueOnce(
        ok({
          object: 'list',
          data: [
            {
              id: 'u3',
              email: '3@x.com',
              groups: [{ id: 'g', name: 'chorus-squad-c' }],
            },
          ],
          list_metadata: { before: 'cursor_page1', after: null },
        }),
      );
    const c = createDirectoryClient({
      baseUrl: BASE,
      directoryId: DIR,
      getApiToken: async () => 't',
      fetchImpl,
    });
    const r = await c.listUsers({ groupId: GROUP });
    expect(r.map((u) => u.sub)).toEqual(['u1', 'u2', 'u3']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchImpl.mock.calls[1]![0])).searchParams.get('after')).toBe(
      'cursor_page2',
    );
  });

  it('returns a user with empty squadIds when none of their groups carry the chorus-squad- prefix', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ok({
        object: 'list',
        data: [
          {
            id: 'directory_user_03',
            email: 'csm@acme.com',
            groups: [{ id: 'g1', name: 'chorus-csm' }],
          },
        ],
        list_metadata: { before: null, after: null },
      }),
    );
    const c = createDirectoryClient({
      baseUrl: BASE,
      directoryId: DIR,
      getApiToken: async () => 't',
      fetchImpl,
    });
    const r = await c.listUsers({ groupId: GROUP });
    expect(r[0]?.squadIds).toEqual([]);
  });
});
