'use client';
import { useState, useSyncExternalStore } from 'react';
import { hasToken, setToken } from '@/lib/api';

// Subscribe to localStorage 'storage' events so the auth gate reacts to
// token changes in other tabs (and reflects the real value after hydration).
function subscribe(callback: () => void): () => void {
  window.addEventListener('storage', callback);
  return () => window.removeEventListener('storage', callback);
}

function useHasToken(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (hasToken() ? 'yes' : 'no'),
    () => 'no', // Server snapshot: always false, avoids SSR/hydration mismatch
  ) === 'yes';
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const authenticated = useHasToken();
  const [input, setInput] = useState('');
  const [_tick, setTick] = useState(0); // Force re-render after setToken

  if (!authenticated) {
    return (
      <div className="max-w-md mx-auto mt-24 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-white">API Token Required</h1>
          <p className="text-sm text-gray-500 mt-2">
            Paste your bearer token to access the dashboard. Get it from:
          </p>
          <pre className="text-xs text-gray-600 mt-2 bg-gray-900 border border-gray-800 rounded p-3 overflow-x-auto">
            aws secretsmanager get-secret-value \{'\n'}  --secret-id /mcp-gateway/gateway-bearer-token \{'\n'}  --query SecretString --output text
          </pre>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) {
              setToken(input.trim());
              setTick((n) => n + 1);
            }
          }}
          className="space-y-3"
        >
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Bearer token"
            className="w-full bg-gray-900 border border-gray-700 rounded px-4 py-2 text-sm text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none"
            autoFocus
          />
          <button type="submit" className="w-full bg-orange-600 hover:bg-orange-500 text-white font-medium py-2 rounded text-sm transition-colors">
            Connect
          </button>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
