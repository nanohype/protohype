import type { ClientConfig, ClientsPort } from "./types.js";

// ── In-memory clients fake ──────────────────────────────────────────
// Test double for `ClientsPort` — wraps a mutable array. Adopters
// can also use this for local dev / smoke-mode deploys.
//

export interface FakeClients extends ClientsPort {
  put(config: ClientConfig): void;
  remove(clientId: string): void;
  clear(): void;
}

export function createFakeClients(seed: readonly ClientConfig[] = []): FakeClients {
  const rows = new Map<string, ClientConfig>(seed.map((c) => [c.clientId, c]));

  return {
    async listActive() {
      return [...rows.values()].filter((c) => c.active);
    },
    async get(clientId: string) {
      const row = rows.get(clientId);
      return row && row.active ? row : null;
    },
    put(config: ClientConfig) {
      rows.set(config.clientId, config);
    },
    remove(clientId: string) {
      rows.delete(clientId);
    },
    clear() {
      rows.clear();
    },
  };
}
