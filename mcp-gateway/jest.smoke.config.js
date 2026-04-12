/** Smoke test config — runs against a deployed stack, not included in `npm test`. */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/smoke'],
  testMatch: ['**/*.smoke.ts'],
  transform: { '^.+\\.tsx?$': 'ts-jest' },
  testTimeout: 60000,
  maxWorkers: 1, // sequential — avoid authorizer cache thrashing + rate limit noise
};
