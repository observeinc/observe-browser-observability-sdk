/**
 * Jest setup. Runs before all tests.
 */

// jsdom does not supply TextEncoder or TextDecoder as globals, but the OTel
// 2.x OTLP transformer needs them at startup. This file polyfills both from
// Node's util module.
const { TextEncoder, TextDecoder } = require('util');
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

global.performance = {
  now: () => Date.now(),
  timeOrigin: Date.now(),
};

global.sessionStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};

global.localStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};

// This silences console output during tests, unless the DEBUG environment variable is set.
if (!process.env.DEBUG) {
  global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}
