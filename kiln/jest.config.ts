import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'lambda/**/*.ts',
    '!lambda/**/*.d.ts',
  ],
  coverageThreshold: {
    global: {
      lines: 70,
      branches: 60,
      functions: 70,
      statements: 70,
    },
  },
  coverageReporters: ['text', 'lcov'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        target: 'ES2022',
        esModuleInterop: true,
        strict: true,
        skipLibCheck: true,
      },
    }],
  },
  // Transform jose (ESM-only) and other ESM packages through ts-jest
  transformIgnorePatterns: [
    'node_modules/(?!(jose)/)',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};

export default config;
