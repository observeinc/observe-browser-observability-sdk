/**
 * Agent-side RED metrics (agent_metrics).
 *
 * The bundle derives traces.span.metrics.{calls,duration} from spans as they end,
 * mirroring Observe's `spanmetrics` connector. These tests load the compiled bundle,
 * drive it to a terminal flush, and read the OTLP payloads back out of the fetch mock.
 *
 * This lives in its own file rather than in bundle-integration.test.js because the
 * environment has to be exact for an OTLP export to complete in jsdom. See the
 * beforeAll notes below.
 */

const fs = require('fs');
const path = require('path');

const BUNDLE_PATH = path.join(__dirname, '../../dist/observe-brum.js');
if (!fs.existsSync(BUNDLE_PATH)) throw new Error('Bundle not found. Run ./build.sh first.');
const BUNDLE = fs.readFileSync(BUNDLE_PATH, 'utf8');

beforeAll(() => {
  // instrumentation-fetch refuses to patch fetch at all when PerformanceObserver is
  // missing ("intended for web usage only"), so a stub is needed to exercise CLIENT
  // spans. Its resource observer never fires here, which is fine: the bundle
  // force-closes still-open spans on pagehide.
  if (typeof global.PerformanceObserver === 'undefined') {
    global.PerformanceObserver = class {
      constructor(cb) { this.callback = cb; }
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    };
    global.PerformanceObserver.supportedEntryTypes = ['resource', 'navigation', 'paint'];
  }

  // Once fetch is patched, the instrumentation's first statement is
  // `args[0] instanceof Request`. jsdom provides no global Request. Without
  // this, every fetch, including each OTLP export, throws ReferenceError, and
  // the transport swallows it as an export failure. Only the global must
  // exist. The tests always pass a string URL, so the class is never
  // constructed.
  if (typeof global.Request === 'undefined') global.Request = class Request {};

  global.PerformanceResourceTiming = class PerformanceResourceTiming {};
  Object.defineProperty(document, 'visibilityState', { writable: true, value: 'visible' });

  // setup.js provides only now() and timeOrigin. web-vitals needs the entry lookups.
  global.performance.getEntriesByType = () => [];
  global.performance.getEntriesByName = () => [];
});

let fetchMock;

// The OTLP serialiser hands the transport a Uint8Array, not a string.
const bodyJson = (body) => {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  return JSON.parse(text);
};

const attrsOf = (list) => {
  const out = {};
  for (const a of list || []) {
    const v = a.value || {};
    out[a.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
  }
  return out;
};

// Flattens every captured /v1/metrics export into one datapoint list.
const exportedPoints = () => {
  const out = [];
  for (const call of fetchMock.mock.calls) {
    if (!String(call[0]).endsWith('/v1/metrics')) continue;
    let payload;
    try { payload = bodyJson(call[1].body); } catch (_) { continue; }
    for (const rm of payload.resourceMetrics || []) {
      const resourceAttrs = attrsOf((rm.resource || {}).attributes);
      for (const sm of rm.scopeMetrics || []) {
        for (const m of sm.metrics || []) {
          const kind = m.sum ? 'sum' : (m.exponentialHistogram ? 'exponentialHistogram' : 'histogram');
          const dps = (m.sum || m.exponentialHistogram || m.histogram || {}).dataPoints || [];
          for (const dp of dps) {
            out.push({
              name: m.name,
              unit: m.unit,
              type: kind,
              attrs: attrsOf(dp.attributes),
              resourceAttrs,
              value: dp.asInt ?? dp.asDouble,
              count: dp.count,
            });
          }
        }
      }
    }
  }
  return out;
};

const exportedSpans = () => {
  const out = [];
  for (const call of fetchMock.mock.calls) {
    if (!String(call[0]).endsWith('/v1/traces')) continue;
    let payload;
    try { payload = bodyJson(call[1].body); } catch (_) { continue; }
    for (const rs of payload.resourceSpans || []) {
      for (const ss of rs.scopeSpans || []) {
        for (const span of ss.spans || []) out.push(span);
      }
    }
  }
  return out;
};

const settle = async (ticks = 8) => {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * Loads the bundle with the given agent_metrics config, optionally makes an
 * outbound call, then fires pagehide so page_view ends and every provider flushes.
 */
const boot = async ({ agentMetrics, config = {}, call } = {}) => {
  delete window.OBSERVE_BRUM;
  delete window.__ogm;
  // Each eval re-registers the OTel global API. Clearing it keeps loads isolated so
  // instruments are never created against a previous load's provider.
  delete global[Symbol.for('opentelemetry.js.api.1')];
  jest.resetModules();

  fetchMock = jest.fn((input) =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      // A real Response always carries `url`: the final URL of the request.
      // instrumentation-fetch reads response.url in _addFinalSpanAttributes to set
      // server.address, so the mock must supply it or the host resolves to the page.
      url: typeof input === 'string' ? input : (input && input.url) || '',
      headers: { get: () => null },
      text: () => Promise.resolve(''),
      clone() { return this; },
    })
  );
  global.fetch = fetchMock;

  window.OBSERVE_BRUM = {
    endpoint: 'http://localhost:4318',
    service_name: 'test-app',
    traces: true,
    metrics: true,
    logs: false,
    // Silence the other signals so the metrics payload holds RED metrics alone.
    cwv_metrics: false,
    errors: false,
    console_capture: false,
    ...config,
    ...(agentMetrics === undefined ? {} : { agent_metrics: agentMetrics }),
  };

  // eslint-disable-next-line no-eval
  eval(BUNDLE);

  if (call) {
    try { await window.fetch(call, { method: 'GET' }); } catch (_) { /* mock response */ }
    await settle(2);
  }

  // pagehide ends page_view, force-closes any still-open span (so the fetch span is
  // metered), then flushes traces, logs and metrics.
  window.dispatchEvent(new Event('pagehide'));
  await settle();
};

const redPoints = () => exportedPoints().filter((p) => p.name.startsWith('traces.span.metrics.'));

describe('agent_metrics is opt-in', () => {
  test('omitting agent_metrics emits no RED metrics', async () => {
    await boot({ agentMetrics: undefined });
    expect(redPoints()).toHaveLength(0);
  });

  test('agent_metrics.enabled false emits no RED metrics', async () => {
    await boot({ agentMetrics: { enabled: false } });
    expect(redPoints()).toHaveLength(0);
  });

  test('metrics: false suppresses RED metrics even when enabled', async () => {
    await boot({ agentMetrics: { enabled: true }, config: { metrics: false } });
    expect(redPoints()).toHaveLength(0);
  });

  test('existing web.vitals.* metrics still work alongside RED metrics', async () => {
    // Proves the RED Views do not suppress the default aggregation of instruments
    // they do not select. web-vitals needs a Navigation Timing entry to report TTFB,
    // which jsdom does not supply, so stub one. The outbound call makes boot settle
    // before pagehide, so onTTFB's deferred report buffers before the flush.
    const navEntry = { entryType: 'navigation', name: 'http://localhost/test.html', type: 'navigate', startTime: 0, responseStart: 5, activationStart: 0 };
    const origEntries = global.performance.getEntriesByType;
    global.performance.getEntriesByType = (type) => (type === 'navigation' ? [navEntry] : []);
    try {
      await boot({ agentMetrics: { enabled: true }, config: { cwv_metrics: true }, call: 'http://api.example.com/api/accounts' });
      expect(redPoints().length).toBeGreaterThan(0);
      // The RED Views must not shadow web.vitals aggregation: a web.vitals.* point
      // must still be exported alongside the RED streams.
      expect(exportedPoints().some((p) => p.name.startsWith('web.vitals.'))).toBe(true);
    } finally {
      global.performance.getEntriesByType = origEntries;
    }
  });
});

describe('emitted streams and instrument shape', () => {
  test('emits all four connector-compatible metric names', async () => {
    await boot({ agentMetrics: { enabled: true } });
    const names = new Set(redPoints().map((p) => p.name));
    expect(names).toContain('traces.span.metrics.calls');
    expect(names).toContain('traces.span.metrics.duration');
    expect(names).toContain('traces.span.metrics.calls.summary');
    expect(names).toContain('traces.span.metrics.duration.summary');
  });

  test('calls is a sum; duration is an exponential histogram in ms', async () => {
    await boot({ agentMetrics: { enabled: true } });
    const points = redPoints();

    const calls = points.find((p) => p.name === 'traces.span.metrics.calls');
    expect(calls.type).toBe('sum');

    const dur = points.find((p) => p.name === 'traces.span.metrics.duration');
    expect(dur.unit).toBe('ms');
    // Observe's collector sets histogram.exponential.max_size: 100.
    expect(dur.type).toBe('exponentialHistogram');
  });

  test('summary_stream: false emits the full streams only', async () => {
    await boot({ agentMetrics: { enabled: true, summary_stream: false } });
    const names = new Set(redPoints().map((p) => p.name));
    expect(names).toContain('traces.span.metrics.calls');
    expect(names).toContain('traces.span.metrics.duration');
    expect(names).not.toContain('traces.span.metrics.calls.summary');
    expect(names).not.toContain('traces.span.metrics.duration.summary');
  });

  test('service identity travels on the resource, not on the datapoints', async () => {
    // Matches resource_metrics_key_attributes: a small, stable resource identity.
    await boot({ agentMetrics: { enabled: true }, config: { service_version: '9.9.9' } });
    const p = redPoints()[0];
    expect(p.resourceAttrs['service.name']).toBe('test-app');
    expect(p.resourceAttrs['service.version']).toBe('9.9.9');
    expect(p.resourceAttrs['deployment.environment.name']).toBe('production');
    expect(p.attrs['service.name']).toBeUndefined();
  });

  test('service.namespace is an empty string on the resource when unconfigured', async () => {
    await boot({ agentMetrics: { enabled: true } });
    const p = redPoints()[0];
    expect(p.resourceAttrs['service.namespace']).toBe('');
  });

  test('service.namespace carries the configured value on the resource', async () => {
    await boot({ agentMetrics: { enabled: true }, config: { service_namespace: 'payments' } });
    const p = redPoints()[0];
    expect(p.resourceAttrs['service.namespace']).toBe('payments');
  });
});

describe('dimensions', () => {
  test('page_view is metered as SPAN_KIND_SERVER with a low-cardinality span.name', async () => {
    await boot({ agentMetrics: { enabled: true } });
    const server = redPoints().find(
      (p) => p.name === 'traces.span.metrics.calls' && p.attrs['span.kind'] === 'SPAN_KIND_SERVER'
    );
    expect(server).toBeDefined();
    // "{method} {route}", never a full URL.
    expect(server.attrs['span.name']).toBe('GET /test.html');
  });

  test('status.code is never emitted - only the post-transform otel.* spelling', async () => {
    // The collector reaches this shape with transform/fix_red_metrics_resource_attributes,
    // which maps status.code and then deletes it. The bundle emits the end state directly.
    await boot({ agentMetrics: { enabled: true } });
    for (const p of redPoints()) {
      expect(p.attrs['status.code']).toBeUndefined();
    }
  });

  test('an outbound call is metered as SPAN_KIND_CLIENT carrying server.address and the HTTP status', async () => {
    await boot({ agentMetrics: { enabled: true }, call: 'http://api.example.com/api/accounts' });
    const client = redPoints().find(
      (p) => p.name === 'traces.span.metrics.calls' && p.attrs['span.kind'] === 'SPAN_KIND_CLIENT'
    );
    expect(client).toBeDefined();
    // Browser equivalent of promote_peer_to_service: the service-map edge target.
    expect(typeof client.attrs['server.address']).toBe('string');
    // transform/add_span_status_code, read off http.response.status_code.
    expect(client.attrs['observe.status_code']).toBe(200);
  });

  // _injectPerSignalAttrs (brum.js) no longer stamps the page url.* over a span
  // that already carries its own url.full. instrumentation-fetch sets url.full to
  // the request URL at span creation, so _fetchHook now derives server.address,
  // url.template and the span name from the real call target. The CLIENT RED
  // metric therefore reports the callee host, not the page host.
  test('server.address on a CLIENT metric is the call target, not the page host', async () => {
    await boot({ agentMetrics: { enabled: true }, call: 'http://api.example.com/api/accounts' });
    const client = redPoints().find(
      (p) => p.name === 'traces.span.metrics.calls' && p.attrs['span.kind'] === 'SPAN_KIND_CLIENT'
    );
    expect(client.attrs['server.address']).toBe('api.example.com');
  });

  test('peer_dimensions: false drops server.address from CLIENT metrics', async () => {
    await boot({
      agentMetrics: { enabled: true, peer_dimensions: false },
      call: 'http://api.example.com/api/accounts',
    });
    for (const p of redPoints()) {
      expect(p.attrs['server.address']).toBeUndefined();
    }
  });

  test('the summary stream drops otel.status_description and server.address', async () => {
    await boot({ agentMetrics: { enabled: true }, call: 'http://api.example.com/api/accounts' });
    const summary = redPoints().filter((p) => p.name.endsWith('.summary'));
    expect(summary.length).toBeGreaterThan(0);
    for (const p of summary) {
      expect(p.attrs['otel.status_description']).toBeUndefined();
      expect(p.attrs['server.address']).toBeUndefined();
    }
  });
});

describe('span-kind filtering', () => {
  test('span_kinds: [CLIENT] excludes the page_view SERVER span', async () => {
    await boot({
      agentMetrics: { enabled: true, span_kinds: ['CLIENT'] },
      call: 'http://api.example.com/api/accounts',
    });
    const kinds = new Set(redPoints().map((p) => p.attrs['span.kind']));
    expect(kinds).not.toContain('SPAN_KIND_SERVER');
    expect(kinds).toContain('SPAN_KIND_CLIENT');
  });

  test('INTERNAL spans are excluded by default', async () => {
    // documentLoad, resourceFetch, and user_interaction are INTERNAL and are not
    // "requests", so counting them makes the rate meaningless.
    await boot({ agentMetrics: { enabled: true }, call: 'http://api.example.com/api/accounts' });
    for (const p of redPoints()) {
      expect(p.attrs['span.kind']).not.toBe('SPAN_KIND_INTERNAL');
    }
  });

  test('an unrecognised span kind falls back to the SERVER + CLIENT default', async () => {
    await boot({ agentMetrics: { enabled: true, span_kinds: ['NOT_A_KIND'] } });
    const kinds = new Set(redPoints().map((p) => p.attrs['span.kind']));
    expect(kinds).toContain('SPAN_KIND_SERVER');
  });

  test('max_span_duration_ms drops over-long spans (filter/drop_long_spans)', async () => {
    // page_view is anchored to performance.timeOrigin, so it always outlives 1 ms.
    await boot({ agentMetrics: { enabled: true, max_span_duration_ms: 1 } });
    expect(redPoints()).toHaveLength(0);
  });
});

describe('call counting', () => {
  test('each span counts once as an integer at the default sample rate', async () => {
    await boot({ agentMetrics: { enabled: true } });
    const server = redPoints().find(
      (p) => p.name === 'traces.span.metrics.calls' && p.attrs['span.kind'] === 'SPAN_KIND_SERVER'
    );
    // asInt, not asDouble: the connector emits calls as an integer sum.
    expect(server.value).toBe(1);
  });

  test('scale_by_sample_rate weights the count by 1/rate', async () => {
    // Sampling is parent-based on a ratio of the trace ID, so a given page_view is
    // sampled or not at random. The metric processor's onEnd only fires for sampled
    // spans, so re-boot until one is sampled. That guarantees the assertion runs and
    // keeps the test off a coin flip. When it is sampled, its count must carry the
    // 1/rate weight (Math.round(1 / 0.5) = 2).
    let calls = [];
    for (let attempt = 0; attempt < 30 && calls.length === 0; attempt++) {
      await boot({ agentMetrics: { enabled: true }, config: { trace_sample_rate: 0.5 } });
      calls = redPoints().filter((p) => p.name === 'traces.span.metrics.calls');
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.value).toBe(2);
  });
});

describe('existing telemetry stays immutable', () => {
  test('derived dimensions never appear as span attributes', async () => {
    await boot({ agentMetrics: { enabled: true }, call: 'http://api.example.com/api/accounts' });
    const spans = exportedSpans();
    expect(spans.length).toBeGreaterThan(0);

    // The collector produces this shape by rewriting spans with transform/*. The bundle
    // derives it in memory instead, so no span gains any of these keys.
    const derived = ['span.name', 'span.kind', 'otel.status_code', 'otel.status_description', 'observe.status_code'];
    for (const span of spans) {
      const keys = (span.attributes || []).map((a) => a.key);
      for (const d of derived) expect(keys).not.toContain(d);
    }
  });

  test('enabling agent_metrics does not change the exported spans', async () => {
    await boot({ agentMetrics: { enabled: false } });
    const withoutRed = exportedSpans().map((s) => ({
      name: s.name,
      kind: s.kind,
      keys: (s.attributes || []).map((a) => a.key).sort(),
    }));

    await boot({ agentMetrics: { enabled: true } });
    const withRed = exportedSpans().map((s) => ({
      name: s.name,
      kind: s.kind,
      keys: (s.attributes || []).map((a) => a.key).sort(),
    }));

    expect(withRed).toEqual(withoutRed);
  });
});

describe('RED metric View mechanics', () => {
  // Guards the trap _redViews() calls out: the SDK only falls back to an instrument's
  // default aggregation when no view matches it, so registering just the .summary
  // views silently suppresses the full-cardinality stream. Validated against the
  // real SDK, mirroring the shape _redViews() builds.
  const {
    MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader,
    AggregationType, AggregationTemporality, createAllowListAttributesProcessor,
  } = require('@opentelemetry/sdk-metrics');

  const collect = async (views) => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60000 });
    const provider = new MeterProvider({ readers: [reader], ...(views ? { views } : {}) });
    const meter = provider.getMeter('test');
    meter.createCounter('traces.span.metrics.calls')
      .add(1, { 'span.name': 'GET /x', 'server.address': 'api.example.com' });
    meter.createHistogram('web.vitals.lcp', { unit: 'ms' }).record(1200, { page: '/x' });
    await reader.forceFlush();
    const out = [];
    for (const rm of exporter.getMetrics()) {
      for (const sm of rm.scopeMetrics) for (const m of sm.metrics) out.push(m);
    }
    return out;
  };

  const summaryOnly = [{
    instrumentName: 'traces.span.metrics.calls',
    name: 'traces.span.metrics.calls.summary',
    aggregation: { type: AggregationType.SUM },
    attributesProcessors: [createAllowListAttributesProcessor(['span.name'])],
  }];

  const fullView = {
    instrumentName: 'traces.span.metrics.calls',
    aggregation: { type: AggregationType.SUM },
  };

  test('a summary-only view suppresses the full stream', async () => {
    const names = (await collect(summaryOnly)).map((m) => m.descriptor.name);
    expect(names).toContain('traces.span.metrics.calls.summary');
    expect(names).not.toContain('traces.span.metrics.calls');
  });

  test('the explicit full-stream view restores it, and the allow list still filters', async () => {
    const metrics = await collect([fullView, ...summaryOnly]);
    const names = metrics.map((m) => m.descriptor.name);
    expect(names).toContain('traces.span.metrics.calls');
    expect(names).toContain('traces.span.metrics.calls.summary');

    const full = metrics.find((m) => m.descriptor.name === 'traces.span.metrics.calls');
    expect(full.dataPoints[0].attributes['server.address']).toBe('api.example.com');

    const summary = metrics.find((m) => m.descriptor.name === 'traces.span.metrics.calls.summary');
    expect(summary.dataPoints[0].attributes['span.name']).toBe('GET /x');
    expect(summary.dataPoints[0].attributes['server.address']).toBeUndefined();
  });

  test('instruments with no matching view keep their default aggregation', async () => {
    const metrics = await collect([fullView, ...summaryOnly]);
    const lcp = metrics.find((m) => m.descriptor.name === 'web.vitals.lcp');
    expect(lcp).toBeDefined();
    expect(lcp.dataPoints[0].value.count).toBe(1);
  });
});
