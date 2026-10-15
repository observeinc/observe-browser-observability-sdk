/**
 * @jest-environment node
 */

/**
 * Gzip transport (`_gzipFetchTransport` in src/brum.js) and the exporter
 * override point it relies on (`_mkOtlpExporter` setting `_delegate._transport`).
 *
 * brum.js does not export `_gzipFetchTransport`. It is a single
 * self-executing bundle entry point, not a module with a public surface.
 * This file extracts the function's own source text out of src/brum.js and
 * runs it directly, so the test exercises the real compression logic rather
 * than a re-implementation of it. The test needs a real `CompressionStream`,
 * `fetch`, and `Response`. The project's default jsdom test environment does
 * not provide these (see setup.js's TextEncoder/TextDecoder polyfill for the
 * same reason). Node 18+ implements all three natively, so this file
 * overrides the test environment to plain Node instead of jsdom.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BRUM_SRC_PATH = path.join(__dirname, '../../src/brum.js');
const BRUM_SRC = fs.readFileSync(BRUM_SRC_PATH, 'utf8');

// Pulls a top-level `function <name>(...) { ... }` out of brum.js by counting
// braces from its opening one. This is good enough for this one well-known
// function. It is not a general JS parser.
function extractFunctionSource(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) {
    throw new Error(`${name} not found in brum.js. Check for a rename or removal.`);
  }
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let end = braceStart;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}') {
      depth--;
      if (depth === 0) { end++; break; }
    }
  }
  return src.slice(start, end);
}

// Builds a runnable `_gzipFetchTransport` from the extracted source, supplying
// the two free variables the function closes over in brum.js itself.
function loadGzipFetchTransport() {
  const source = extractFunctionSource(BRUM_SRC, '_gzipFetchTransport');
  // eslint-disable-next-line no-new-func
  const factory = new Function('_RETRYABLE_STATUS', '_isUnloading', `${source}\nreturn _gzipFetchTransport;`);
  return factory(new Set([429, 502, 503, 504]), false);
}

describe('_gzipFetchTransport round-trip', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('compresses the body, sets Content-Encoding: gzip, and gunzips back to the original bytes', async () => {
    const gzipFetchTransport = loadGzipFetchTransport();
    const originalText = JSON.stringify({ resourceSpans: [{ resource: {}, scopeSpans: [] }] });
    const originalBytes = new TextEncoder().encode(originalText);

    let capturedUrl;
    let capturedInit;
    global.fetch = jest.fn((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve({ status: 200, headers: { get: () => null } });
    });

    const transport = gzipFetchTransport('http://localhost:4318/v1/traces', { 'Content-Type': 'application/json' });
    const result = await transport.send(originalBytes, 30000);

    expect(result.status).toBe('success');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toBe('http://localhost:4318/v1/traces');
    expect(capturedInit.headers['Content-Encoding']).toBe('gzip');

    const sentBytes = Buffer.from(capturedInit.body);
    // A real gzip stream never equals its plaintext input for a payload this size.
    expect(sentBytes.equals(Buffer.from(originalBytes))).toBe(false);

    const decompressed = zlib.gunzipSync(sentBytes);
    expect(decompressed.equals(Buffer.from(originalBytes))).toBe(true);
    expect(JSON.parse(decompressed.toString('utf8'))).toEqual(JSON.parse(originalText));
  });

  test('reports a retryable result for a 503, without treating it as success', async () => {
    const gzipFetchTransport = loadGzipFetchTransport();
    global.fetch = jest.fn(() =>
      Promise.resolve({ status: 503, headers: { get: (h) => (h === 'Retry-After' ? '2' : null) } })
    );

    const transport = gzipFetchTransport('http://localhost:4318/v1/traces', {});
    const result = await transport.send(new TextEncoder().encode('{}'), 30000);

    expect(result.status).toBe('retryable');
    expect(result.retryInMillis).toBe(2000);
  });
});

describe('_mkOtlpExporter gzip override point', () => {
  // _mkOtlpExporter splices the gzip transport in at exp._delegate._transport.
  // This locks that assumption against the real, installed SDK class: if a
  // future SDK upgrade moves the transport elsewhere, this fails loudly
  // instead of gzip silently going dead again (the original Bug 1).
  test('OTLPTraceExporter stores its transport at _delegate._transport, and export() reaches it', async () => {
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const exp = new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces', headers: {} });

    expect(exp._delegate).toBeDefined();
    expect(exp._delegate._transport).toBeDefined();
    expect(typeof exp._delegate._transport.send).toBe('function');

    const sendSpy = jest.fn().mockResolvedValue({ status: 'success' });
    exp._delegate._transport = { send: sendSpy, shutdown: () => {} };

    const result = await new Promise((resolve) => {
      exp.export([], (r) => resolve(r));
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(0); // ExportResultCode.SUCCESS
  });
});
