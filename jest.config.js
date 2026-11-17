/** @type {import('jest').Config} */
const baseConfig = {
  rootDir: '.',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
};

module.exports = {
  projects: [
    {
      ...baseConfig,
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/unit/**/*.spec.ts'],
    },
    {
      ...baseConfig,
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.spec.ts'],
    },
    {
      ...baseConfig,
      displayName: 'component',
      testMatch: ['<rootDir>/tests/component/**/*.spec.ts'],
    },
  ],
  // Constitution Principle VI: minimum 80% on the domain and application layers (`npm run test:cov`).
  collectCoverageFrom: ['src/domain/**/*.ts', 'src/services/**/*.ts', '!**/index.ts'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  coverageDirectory: 'coverage',
};
