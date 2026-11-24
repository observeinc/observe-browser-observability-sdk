/**
 * opentelemetry-browser event instrumentations behind their options:
 * cwv_mode, error_source, navigation_events and load_timing.
 *
 * Each test loads the compiled bundle, drives the page, fires pagehide so every
 * provider flushes, and reads the OTLP payloads back out of the fetch mock. The
 * environment setup follows agent-metrics.test.js.
 */

const fs = require('fs');
const path = require('path');

const BUNDLE_PATH = path.join(__dirname, '../../dist/observe-brum.js');
if (!fs.existsSync(BUNDLE_PATH)) throw new Error('Bundle not found. Run ./build.sh first.');
const BUNDLE = fs.readFileSync(BUNDLE_PATH, 'utf8');

// Resource entries the PerformanceObserver stub delivers on observe({ type: 'resource' }).
let resourceEntries = [];

// web-vitals reports TTFB from this entry. loadEventEnd > 0 lets navigation timing emit.
const NAV_ENTRY = {
  entryType: 'navigation', name: 'http://localhost/test.html?token=secret', type: 'navigate',
  startTime: 0, duration: 120, responseStart: 5, activationStart: 0,
  domInteractive: 40, domComplete: 100, loadEventStart: 110, loadEventEnd: 120,
};

beforeAll(() => {
  global.PerformanceObserver = class {
    constructor(cb) { this.callback = cb; }
    observe(opts) {
      if (opts && opts.type === 'resource' && resourceEntries.length) {
        const entries = resourceEntries;
        this.callback({ getEntries: () => entries });
      }
    }
    disconnect() {}
    takeRecords() { return []; }
  };
  global.PerformanceObserver.supportedEntryTypes = ['resource', 'navigation', 'paint'];
  if (typeof global.Request === 'undefined') global.Request = class Request {};
  global.PerformanceResourceTiming = class PerformanceResourceTiming {};
  // The web-vitals attribution build checks entries against this class.
  global.PerformanceNavigationTiming = class PerformanceNavigationTiming {};
  Object.defineProperty(document, 'visibilityState', { writable: true, value: 'visible' });
  global.performance.getEntriesByType = (type) => (type === 'navigation' ? [NAV_ENTRY] : []);
  global.performance.getEntriesByName = () => [];
});

let fetchMock;

afterEach(() => {
  // Event instrumentations hold window listeners and history patches. Disable them so
  // the next load starts clean.
  try { window.__ogm._internal.unregisterInstrumentations(); } catch (_) {}
  resourceEntries = [];
});

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

const exportsTo = (signal) => fetchMock.mock.calls
  .filter((c) => String(c[0]).endsWith(`/v1/${signal}`))
  .map((c) => { try { return bodyJson(c[1].body); } catch (_) { return {}; } });

const logRecords = () => {
  const out = [];
  for (const p of exportsTo('logs')) {
    for (const rl of p.resourceLogs || []) {
      for (const sl of rl.scopeLogs || []) {
        for (const lr of sl.logRecords || []) {
          out.push({ eventName: lr.eventName, attrs: attrsOf(lr.attributes), traceId: lr.traceId, scope: sl.scope && sl.scope.name });
        }
      }
    }
  }
  return out;
};

const events = (name) => logRecords().filter((r) => r.eventName === name);

const metricNames = () => {
  const out = [];
  for (const p of exportsTo('metrics')) {
    for (const rm of p.resourceMetrics || []) {
      for (const sm of rm.scopeMetrics || []) {
        for (const m of sm.metrics || []) out.push(m.name);
      }
    }
  }
  return out;
};

const spanNames = () => {
  const out = [];
  for (const p of exportsTo('traces')) {
    for (const rs of p.resourceSpans || []) {
      for (const ss of rs.scopeSpans || []) {
        for (const s of ss.spans || []) out.push(s.name);
      }
    }
  }
  return out;
};

const settle = async (ticks = 8) => {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
};

let pageViewTraceId;

// Loads the bundle, runs drive(), then fires pagehide so every provider flushes.
const boot = async (config = {}, drive) => {
  delete window.OBSERVE_BRUM;
  delete window.__ogm;
  delete global[Symbol.for('opentelemetry.js.api.1')];
  document.querySelectorAll('meta[name="traceparent"]').forEach((m) => m.remove());
  jest.resetModules();

  fetchMock = jest.fn((input) => Promise.resolve({
    ok: true, status: 200, statusText: 'OK',
    url: typeof input === 'string' ? input : (input && input.url) || '',
    headers: { get: () => null },
    text: () => Promise.resolve(''),
    clone() { return this; },
  }));
  global.fetch = fetchMock;

  window.OBSERVE_BRUM = {
    endpoint: 'http://localhost:4318',
    service_name: 'test-app',
    traces: true, metrics: true, logs: true,
    cwv_metrics: false, errors: false, console_capture: false, network_requests: false,
    compress: false,
    ...config,
  };

  // eslint-disable-next-line no-eval
  eval(BUNDLE);
  pageViewTraceId = window.__ogm.pageViewTraceId;

  // web-vitals and the idle-callback shim report on later macrotasks.
  await new Promise((r) => setTimeout(r, 20));
  if (drive) { await drive(); await new Promise((r) => setTimeout(r, 20)); }

  window.dispatchEvent(new Event('pagehide'));
  await settle();
};

describe('cwv_mode', () => {
  test('default is metrics: web.vitals.* histograms, no web vital events', async () => {
    await boot({ cwv_metrics: true });
    expect(metricNames()).toContain('web.vitals.ttfb');
    expect(events('browser.web_vital')).toHaveLength(0);
    expect(window.__ogm._internal.eventInstrumentations).toHaveLength(0);
  });

  test("'events': browser.web_vital log events, no web.vitals.* metrics", async () => {
    await boot({ cwv_metrics: true, cwv_mode: 'events' });
    const ttfb = events('browser.web_vital').find((e) => e.attrs['browser.web_vital.name'] === 'ttfb');
    expect(ttfb).toBeDefined();
    expect(ttfb.attrs['browser.web_vital.value']).toBe(5);
    expect(ttfb.attrs['browser.web_vital.rating']).toBe('good');
    // Agent identity and page_view correlation apply to the instrumentation's events too.
    expect(ttfb.attrs['session.id']).toBeTruthy();
    expect(ttfb.traceId).toBe(pageViewTraceId);
    expect(metricNames().filter((n) => n.startsWith('web.vitals.'))).toHaveLength(0);
  });

  test("cwv_metrics false turns off 'events' too", async () => {
    await boot({ cwv_metrics: false, cwv_mode: 'events' });
    expect(events('browser.web_vital')).toHaveLength(0);
  });

  test("'events' with logs off emits nothing and does not throw", async () => {
    await boot({ cwv_metrics: true, cwv_mode: 'events', logs: false });
    expect(window.__ogm._internal.eventInstrumentations).toHaveLength(0);
    expect(metricNames().filter((n) => n.startsWith('web.vitals.'))).toHaveLength(0);
  });
});

describe('error_source', () => {
  const throwError = () => {
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));
  };

  // The agent's own error listeners stay on window after a load, so the agent test runs
  // last. The ErrorsInstrumentation listeners go away in afterEach.

  test("'otel': one 'exception' event from the instrumentation, none from the agent", async () => {
    await boot({ errors: true, error_source: 'otel' }, throwError);
    const recs = logRecords().filter((r) => r.attrs['exception.message'] === 'boom');
    expect(recs).toHaveLength(1);
    expect(recs[0].eventName).toBe('exception');
    expect(recs[0].attrs['exception.type']).toBe('Error');
    expect(recs[0].attrs['page.pathname']).toBe('/test.html');
    expect(recs[0].attrs['error.source']).toBeUndefined();
    expect(recs[0].traceId).toBe(pageViewTraceId);
  });

  test("'otel' with error_mode 'span' writes no log record", async () => {
    await boot({ errors: true, error_source: 'otel', error_mode: 'span' }, throwError);
    expect(logRecords().filter((r) => r.attrs['exception.message'] === 'boom')).toHaveLength(0);
  });

  test("default is agent: one log record with error.source", async () => {
    await boot({ errors: true }, throwError);
    const recs = logRecords().filter((r) => r.attrs['exception.message'] === 'boom');
    expect(recs).toHaveLength(1);
    expect(recs[0].attrs['error.source']).toBe('window.error');
    expect(recs[0].eventName).toBeFalsy();
  });
});

describe('navigation_events', () => {
  test('off by default', async () => {
    await boot({});
    expect(events('browser.navigation')).toHaveLength(0);
  });

  test('hard load and pushState each emit one event, with url.full scrubbed', async () => {
    try {
      await boot({ navigation_events: true }, () => {
        history.pushState({}, '', '/next?token=abc');
      });
      const nav = events('browser.navigation');
      expect(nav).toHaveLength(2);
      expect(nav[0].attrs['browser.navigation.same_document']).toBe(false);
      const push = nav[1];
      expect(push.attrs['browser.navigation.type']).toBe('push');
      expect(push.attrs['url.full']).toBe('http://localhost/next?token=%3Credacted%3E');
    } finally {
      history.replaceState({}, '', '/test.html');
    }
  });
});

describe('load_timing', () => {
  test('default is spans: no timing events', async () => {
    await boot({});
    expect(events('browser.navigation_timing')).toHaveLength(0);
    expect(events('browser.resource_timing')).toHaveLength(0);
  });

  test("'events': navigation and resource timing events, no documentLoad span", async () => {
    resourceEntries = [
      { name: 'http://localhost/app.js', initiatorType: 'script', duration: 10, fetchStart: 1, responseEnd: 11 },
    ];
    await boot({ load_timing: 'events' });

    const navTiming = events('browser.navigation_timing');
    expect(navTiming).toHaveLength(1);
    expect(navTiming[0].attrs['browser.navigation_timing.load_event_end']).toBe(120);
    expect(navTiming[0].attrs['url.full']).toBe('http://localhost/test.html?token=%3Credacted%3E');

    const res = events('browser.resource_timing');
    expect(res.map((e) => e.attrs['url.full'])).toEqual(['http://localhost/app.js']);
    expect(res[0].traceId).toBe(pageViewTraceId);

    expect(spanNames()).not.toContain('documentLoad');
  });

  test("'events' drops fetch and XHR resource entries when network spans exist", async () => {
    resourceEntries = [
      { name: 'http://localhost/app.css', initiatorType: 'link', duration: 5, fetchStart: 1, responseEnd: 6 },
      { name: 'http://api.example.com/a', initiatorType: 'fetch', duration: 5, fetchStart: 1, responseEnd: 6 },
      { name: 'http://api.example.com/b', initiatorType: 'xmlhttprequest', duration: 5, fetchStart: 1, responseEnd: 6 },
    ];
    await boot({ load_timing: 'events', network_requests: true });
    expect(events('browser.resource_timing').map((e) => e.attrs['url.full'])).toEqual(['http://localhost/app.css']);
  });

  test("'events' keeps fetch and XHR resource entries when network spans are off", async () => {
    resourceEntries = [
      { name: 'http://api.example.com/a', initiatorType: 'fetch', duration: 5, fetchStart: 1, responseEnd: 6 },
    ];
    await boot({ load_timing: 'events', network_requests: false });
    expect(events('browser.resource_timing').map((e) => e.attrs['url.full'])).toEqual(['http://api.example.com/a']);
  });
});
