/**
 * Local Jest config — runs only the Kibana-independent tests under
 * `common/` and `server/es/`. The full plugin lifecycle (server/plugin.ts,
 * public/**) requires a Kibana checkout's Jest preset and is wired up
 * separately in DEVELOPMENT.md.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/common', '<rootDir>/server/es', '<rootDir>/server/audit'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.test.json',
      },
    ],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  clearMocks: true,
};
