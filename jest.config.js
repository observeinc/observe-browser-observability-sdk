module.exports = {
  testEnvironment: 'jsdom',
  testEnvironmentOptions: {
    // Gives window.location a real, correct value (pathname '/test.html')
    // without the tests reassigning it (which jsdom rejects as navigation).
    url: 'http://localhost/test.html',
  },
  testMatch: ['**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/tests/functional/'],
  setupFilesAfterEnv: ['<rootDir>/tests/non-functional/setup.js'],
  testTimeout: 10000,
  verbose: true,
  transform: {},
  transformIgnorePatterns: [
    'node_modules/(?!(@opentelemetry)/)',
  ],
  // Coverage config (opt-in via --coverage flag)
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.d.ts',
    '!**/node_modules/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary'],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/tests/',
    '/dist/',
  ],
};
