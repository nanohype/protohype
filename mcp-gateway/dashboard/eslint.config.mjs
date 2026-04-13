// ESLint pinned to ^9.7 in package.json — eslint-plugin-react 7.37 (bundled
// by eslint-config-next 16) still uses the pre-v10 context API and crashes
// under ESLint 10. Unpin once a compatible plugin release ships.
import nextConfig from 'eslint-config-next';

const config = [
  ...nextConfig,
  { ignores: ['.next/**', 'out/**', 'node_modules/**', 'next-env.d.ts'] },
];

export default config;
