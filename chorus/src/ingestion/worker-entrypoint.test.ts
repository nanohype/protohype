import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { mirrorOnce, runOnce, type WorkerDeps } from './worker-entrypoint.js';
import type { LinearSync } from './linear-sync.js';

function makeLinear(): LinearSync {
  return {
    mirror: vi.fn(),
    addComment: vi.fn(),
    createIssue: vi.fn(),
  };
}

function makeDeps(): { deps: WorkerDeps; linear: LinearSync } {
  const linear = makeLinear();
  const deps: WorkerDeps = {
    db: {} as Pool,
    linear,
    config: { linearMirrorIntervalSeconds: 3600, oneshot: true },
  };
  return { deps, linear };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mirrorOnce', () => {
  it('calls linear.mirror', async () => {
    const h = makeDeps();
    await mirrorOnce(h.deps);
    expect(h.linear.mirror).toHaveBeenCalledOnce();
  });

  it('logs and returns when mirror fails (does not throw)', async () => {
    const h = makeDeps();
    (h.linear.mirror as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Linear 500'));
    await expect(mirrorOnce(h.deps)).resolves.toBeUndefined();
  });
});

describe('runOnce', () => {
  it('runs the mirror', async () => {
    const h = makeDeps();
    await runOnce(h.deps);
    expect(h.linear.mirror).toHaveBeenCalledOnce();
  });
});
