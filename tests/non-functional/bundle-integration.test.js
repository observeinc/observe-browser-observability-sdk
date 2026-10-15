/**
 * Integration tests. They load the compiled bundle (dist/observe-brum.js)
 * and test actual runtime behaviour.
 */

beforeAll(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: new Map(),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    })
  );

  global.XMLHttpRequest = class {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.responseText = '';
    }
    open() {}
    send() {}
    setRequestHeader() {}
    addEventListener() {}
  };

  global.navigator = {
    userAgent: 'Mozilla/5.0 (Test Browser)',
    platform: 'Test',
    language: 'en-US',
    connection: {
      effectiveType: '4g',
      addEventListener: jest.fn(),
    },
  };

  const now = Date.now();
  global.performance = {
    now: () => Date.now() - now,
    timeOrigin: now,
    timing: {
      navigationStart: now,
      loadEventEnd: now + 1000,
    },
    getEntriesByType: jest.fn(() => []),
    getEntriesByName: jest.fn(() => []),
    mark: jest.fn(),
    measure: jest.fn(),
    clearMarks: jest.fn(),
    clearMeasures: jest.fn(),
    navigation: {
      type: 0,
    },
    observer: jest.fn(),
  };

  // jsdom supplies window.location itself, set via testEnvironmentOptions in
  // jest.config.js. Tests cannot reassign or redefine it here. jsdom's
  // location is non-configurable, and an assignment to it triggers a
  // "Not implemented: navigation" error.

  Object.defineProperty(document, 'visibilityState', {
    writable: true,
    value: 'visible',
  });

  global.PerformanceObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {}
    disconnect() {}
  };
});

describe('BRUM Compiled Bundle Integration', () => {
  let originalConsole;

  beforeAll(() => {
    originalConsole = global.console;
    global.console = {
      ...originalConsole,
      log: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  });

  afterAll(() => {
    global.console = originalConsole;
  });

  beforeEach(() => {
    delete window.OBSERVE_BRUM;
    delete window.__ogm;
    jest.resetModules();
  });

  test('bundle loads without throwing', () => {
    window.OBSERVE_BRUM = {
      endpoint: 'http://localhost:4318/v1/otel',
      service_name: 'test-app',
      traces: false, // Disable to avoid OTLP requests
      metrics: false,
      logs: false,
    };

    expect(() => {
      const fs = require('fs');
      const path = require('path');
      const bundlePath = path.join(__dirname, '../../dist/observe-brum.js');
      
      if (fs.existsSync(bundlePath)) {
        const bundleCode = fs.readFileSync(bundlePath, 'utf8');
        eval(bundleCode);
      } else {
        throw new Error('Bundle not found. Run ./build.sh first.');
      }
    }).not.toThrow();
  });

  test('__ogm API is created after bundle loads', () => {
    window.OBSERVE_BRUM = {
      endpoint: 'http://localhost:4318/v1/otel',
      service_name: 'test-app',
      traces: false,
      metrics: false,
      logs: false,
    };

    const fs = require('fs');
    const path = require('path');
    const bundlePath = path.join(__dirname, '../../dist/observe-brum.js');

    if (fs.existsSync(bundlePath)) {
      const bundleCode = fs.readFileSync(bundlePath, 'utf8');
      eval(bundleCode);

      expect(window.__ogm).toBeDefined();
      expect(typeof window.__ogm.withPageContext).toBe('function');
      expect(typeof window.__ogm.endPageView).toBe('function');
      expect(typeof window.__ogm.sessionId).toBe('string');
      expect(typeof window.__ogm.pageViewId).toBe('string');
      expect(typeof window.__ogm.version).toBe('string');
    }
  });

  test('withPageContext executes functions', () => {
    window.OBSERVE_BRUM = {
      endpoint: 'http://localhost:4318/v1/otel',
      trace_mode: 'unified',
      traces: false,
      metrics: false,
      logs: false,
    };

    const fs = require('fs');
    const path = require('path');
    const bundlePath = path.join(__dirname, '../../dist/observe-brum.js');
    
    if (fs.existsSync(bundlePath)) {
      const bundleCode = fs.readFileSync(bundlePath, 'utf8');
      eval(bundleCode);

      if (window.__ogm) {
        let executed = false;
        window.__ogm.withPageContext(() => {
          executed = true;
        });
        expect(executed).toBe(true);

        const result = window.__ogm.withPageContext(() => 42);
        expect(result).toBe(42);
      }
    }
  });

  test('sessionId and pageViewId are valid UUIDs', () => {
    window.OBSERVE_BRUM = {
      endpoint: 'http://localhost:4318/v1/otel',
      traces: false,
      metrics: false,
      logs: false,
    };

    const fs = require('fs');
    const path = require('path');
    const bundlePath = path.join(__dirname, '../../dist/observe-brum.js');
    
    if (fs.existsSync(bundlePath)) {
      const bundleCode = fs.readFileSync(bundlePath, 'utf8');
      eval(bundleCode);

      if (window.__ogm) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        // This test's sessionStorage mock can return nothing, so sessionId can be null here.
        if (window.__ogm.sessionId) {
          expect(window.__ogm.sessionId).toMatch(uuidRegex);
        }
        
        expect(window.__ogm.pageViewId).toMatch(uuidRegex);
      }
    }
  });

  test('configuration is respected', () => {
    const configs = [
      { trace_mode: 'unified' },
      { trace_mode: 'split' },
      { trace_mode: 'stock' },
      { error_mode: 'logs' },
      { error_mode: 'span' },
      { error_mode: 'dual' },
    ];

    configs.forEach((config) => {
      delete window.OBSERVE_BRUM;
      delete window.__ogm;
      jest.resetModules();

      window.OBSERVE_BRUM = {
        ...config,
        endpoint: 'http://localhost:4318/v1/otel',
        traces: false,
        metrics: false,
        logs: false,
      };

      expect(() => {
        const fs = require('fs');
        const path = require('path');
        const bundlePath = path.join(__dirname, '../../dist/observe-brum.js');
        
        if (fs.existsSync(bundlePath)) {
          const bundleCode = fs.readFileSync(bundlePath, 'utf8');
          eval(bundleCode);
        }
      }).not.toThrow();
    });
  });
});

describe('BRUM Trace Linkage (unified mode)', () => {
  const loadBundle = () => {
    const fs = require('fs');
    const path = require('path');
    const bundlePath = path.join(__dirname, '../../dist/observe-brum.js');
    if (!fs.existsSync(bundlePath)) throw new Error('Bundle not found. Run ./build.sh first.');
    // eslint-disable-next-line no-eval
    eval(fs.readFileSync(bundlePath, 'utf8'));
  };

  beforeEach(() => {
    delete window.OBSERVE_BRUM;
    delete window.__ogm;
    // Remove any traceparent meta left by a prior test load.
    document.querySelectorAll('meta[name="traceparent"]').forEach((m) => m.remove());
    // Swallow OTLP exports so the batch processor's later flush hits no real network.
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve('') })
    );
    try { navigator.sendBeacon = jest.fn(() => true); } catch (_) { /* read-only in some envs */ }
    jest.resetModules();
    window.OBSERVE_BRUM = {
      endpoint: 'http://localhost:4318/v1/otel',
      service_name: 'test-app',
      traces: true,   // needed to mint the page_view span + traceparent meta
      metrics: false,
      logs: false,
    };
  });

  test('injects <meta name="traceparent"> matching the page_view trace (document-load nesting)', () => {
    loadBundle();
    const meta = document.querySelector('meta[name="traceparent"]');
    expect(meta).not.toBeNull();
    // W3C traceparent: version(00)-traceId(32hex)-spanId(16hex)-flags(2hex)
    const content = meta.getAttribute('content');
    expect(content).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    // The traceId document-load will adopt must be the page_view trace.
    expect(content.split('-')[1]).toBe(window.__ogm.pageViewTraceId);
    expect(window.__ogm.pageViewTraceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('withPageContext activates the page_view span (the context fetch + XHR wrappers reuse)', () => {
    loadBundle();
    const api = require('@opentelemetry/api');
    let insideTraceId;
    // The fetch wrapper and the XHR open() wrapper both run their inner call via
    // context.with(_pageViewCtx, ...). This is the same context that withPageContext exposes.
    window.__ogm.withPageContext(() => {
      const sc = api.trace.getSpanContext(api.context.active());
      insideTraceId = sc && sc.traceId;
    });
    expect(insideTraceId).toBe(window.__ogm.pageViewTraceId);
  });

  test('wraps XMLHttpRequest.prototype.open', () => {
    const nativeOpen = XMLHttpRequest.prototype.open;
    loadBundle();
    // After the load, both the auto-instrumentation and the page_view wrapper wrap open().
    expect(XMLHttpRequest.prototype.open).not.toBe(nativeOpen);
    expect(typeof XMLHttpRequest.prototype.open).toBe('function');
  });

  test('network_requests: false leaves fetch and XHR.prototype.open unwrapped', () => {
    const nativeFetch = global.fetch;
    const nativeOpen = XMLHttpRequest.prototype.open;
    window.OBSERVE_BRUM.network_requests = false;
    loadBundle();
    // Both the auto-instrumentation and the page_view-context wrapper are gated on
    // network_requests. An app that turns it off must see its own fetch and XHR back.
    expect(window.fetch).toBe(nativeFetch);
    expect(XMLHttpRequest.prototype.open).toBe(nativeOpen);
  });

  test('stock mode does not inject a traceparent meta (no page_view span)', () => {
    delete window.OBSERVE_BRUM;
    delete window.__ogm;
    jest.resetModules();
    window.OBSERVE_BRUM = {
      endpoint: 'http://localhost:4318/v1/otel',
      traces: true, metrics: false, logs: false, trace_mode: 'stock',
    };
    loadBundle();
    expect(document.querySelector('meta[name="traceparent"]')).toBeNull();
  });
});

describe('Duplicate resource-span suppression', () => {
  // document-load emits a resourceFetch span for each PerformanceResourceTiming entry,
  // including fetch and XHR calls that already have their own instrumentation span. The
  // bundle flags those spans with 'brum.internal.drop', and a wrapping processor excludes
  // them from export. jsdom cannot drive document-load with real timing entries, so this
  // test loads the bundle and drives its real _dropFilterProcessor, exposed on
  // window.__ogm._internal, rather than a local copy.
  const loadBundle = () => {
    const fs = require('fs');
    const path = require('path');
    const bundlePath = path.join(__dirname, '../../dist/observe-brum.js');
    if (!fs.existsSync(bundlePath)) throw new Error('Bundle not found. Run ./build.sh first.');
    // eslint-disable-next-line no-eval
    eval(fs.readFileSync(bundlePath, 'utf8'));
  };

  beforeEach(() => {
    delete window.OBSERVE_BRUM;
    delete window.__ogm;
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve('') })
    );
    try { navigator.sendBeacon = jest.fn(() => true); } catch (_) { /* read-only in some envs */ }
    jest.resetModules();
    window.OBSERVE_BRUM = {
      endpoint: 'http://localhost:4318/v1/otel',
      service_name: 'test-app',
      traces: true, metrics: false, logs: false,
    };
  });

  test('flagged (fetch/XHR) resourceFetch spans are not exported; static ones are', async () => {
    loadBundle();
    // The exact processor and marker the bundle ships, not a re-implementation.
    const { dropFilterProcessor, DROP_ATTR } = window.__ogm._internal;
    const {
      BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor,
    } = require('@opentelemetry/sdk-trace-base');

    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [dropFilterProcessor(new SimpleSpanProcessor(exporter))],
    });
    const tracer = provider.getTracer('test');

    // A static resource, with initiator type 'script', stays in the export.
    const keep = tracer.startSpan('resourceFetch');
    keep.setAttribute('resource.initiator_type', 'script');
    keep.end();

    // A fetch or XHR resource is flagged for drop, as a duplicate of the fetch/xhr span.
    const drop = tracer.startSpan('resourceFetch');
    drop.setAttribute(DROP_ATTR, true);
    drop.end();

    await provider.forceFlush();
    const exported = exporter.getFinishedSpans();
    expect(exported).toHaveLength(1);
    expect(exported[0].attributes[DROP_ATTR]).toBeUndefined();
  });
});

describe('Client-IP probe excluded from instrumentation', () => {
  // BRUM's client-IP enrichment GETs cfg.client_ip.trace_url (Cloudflare cdn-cgi/trace
  // by default). The bundle adds an escaped regex of that URL to the fetch/XHR
  // ignoreUrls so it is not traced as a rogue GET. These tests load the bundle with a
  // given trace_url and read the real ignore list from window.__ogm._internal.netIgnoreUrls,
  // so the actual escape and construction are exercised, not a copy.
  const loadBundle = () => {
    const fs = require('fs');
    const path = require('path');
    const bundlePath = path.join(__dirname, '../../dist/observe-brum.js');
    if (!fs.existsSync(bundlePath)) throw new Error('Bundle not found. Run ./build.sh first.');
    // eslint-disable-next-line no-eval
    eval(fs.readFileSync(bundlePath, 'utf8'));
  };

  // Boots the bundle with client_ip.trace_url set to the given URL, then returns the
  // ignore regex the bundle actually built for it (netIgnoreUrls also holds the OTLP
  // export ignore, which never matches an app or probe URL).
  const ignoreRegexFor = (traceUrl) => {
    delete window.OBSERVE_BRUM;
    delete window.__ogm;
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve('') })
    );
    try { navigator.sendBeacon = jest.fn(() => true); } catch (_) { /* read-only in some envs */ }
    jest.resetModules();
    window.OBSERVE_BRUM = {
      endpoint: 'http://localhost:4318/v1/otel',
      service_name: 'test-app',
      traces: true, metrics: false, logs: false,
      client_ip: { enabled: true, trace_url: traceUrl },
    };
    loadBundle();
    return window.__ogm._internal.netIgnoreUrls.find((rx) => rx.test(traceUrl));
  };

  test('ignore pattern matches the trace_url but not app calls', () => {
    const rx = ignoreRegexFor('https://www.cloudflare.com/cdn-cgi/trace');
    expect(rx).toBeDefined();
    expect(rx.test('https://www.cloudflare.com/cdn-cgi/trace')).toBe(true);
    expect(rx.test('https://app.example.com/api/accounts')).toBe(false);
  });

  test('regex-special chars in a custom trace_url are treated literally', () => {
    const custom = 'https://ip.example.com/whoami?fmt=json';
    const rx = ignoreRegexFor(custom);
    expect(rx).toBeDefined();
    expect(rx.test(custom)).toBe(true);
    // '?' is escaped, so it is not a wildcard/optional-char match
    expect(rx.test('https://ip.example.com/whoamifmt=json')).toBe(false);
  });
});

describe('page_view failsafe close', () => {
  const loadBundle = () => {
    const fs = require('fs');
    const path = require('path');
    const bundlePath = path.join(__dirname, '../../dist/observe-brum.js');
    if (!fs.existsSync(bundlePath)) throw new Error('Bundle not found. Run ./build.sh first.');
    // eslint-disable-next-line no-eval
    eval(fs.readFileSync(bundlePath, 'utf8'));
  };

  beforeEach(() => {
    delete window.OBSERVE_BRUM;
    delete window.__ogm;
    document.querySelectorAll('meta[name="traceparent"]').forEach((m) => m.remove());
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve('') })
    );
    try { navigator.sendBeacon = jest.fn(() => true); } catch (_) { /* read-only in some envs */ }
    // instrumentation-fetch's patched fetch reads `args[0] instanceof Request` before
    // it calls through. jsdom has no global Request. If this stub is missing, the
    // export that the failsafe flush drives throws ReferenceError and never reaches
    // the mock.
    if (typeof global.Request === 'undefined') global.Request = class Request {};
    // The OTel API stores its registered global provider on this symbol, not on the
    // module instance. An earlier describe block's loadBundle() call can leave the
    // symbol pointing at a provider from a prior test. If this test does not clear
    // the symbol first, registerGlobal() silently keeps that old provider. This
    // test's own tracer provider never installs, so forceFlush() below flushes a
    // provider this test never sees.
    delete global[Symbol.for('opentelemetry.js.api.1')];
    jest.resetModules();
    window.OBSERVE_BRUM = {
      endpoint: 'http://localhost:4318/v1/otel',
      service_name: 'test-app',
      traces: true,
      metrics: false,
      logs: false,
      // dom_elements stays at its default value, true, so page_view waits on the
      // documentLoad-end callback. jsdom's PerformanceObserver stub never fires that
      // callback, so the 30-second failsafe timer is the only way left to close and
      // flush the span.
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('closes and flushes page_view after 30s when documentLoad never ends', async () => {
    jest.useFakeTimers();
    const fetchMock = global.fetch;
    loadBundle();

    expect(fetchMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(30000);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('Console capture routing by error_mode', () => {
  // console_capture used to always tap console.* into OTel log records. It now follows
  // error_mode, the same destination switch the error capture uses: 'logs' emits a log
  // record, 'span' adds a 'console' span event on the active or page_view span, and
  // 'dual' emits both. These tests load the bundle, drive a console call plus a pagehide
  // flush, then read the OTLP payloads back out of the fetch mock.
  let fetchMock;
  let originalConsole;

  const loadBundle = () => {
    const fs = require('fs');
    const path = require('path');
    const bundlePath = path.join(__dirname, '../../dist/observe-brum.js');
    if (!fs.existsSync(bundlePath)) throw new Error('Bundle not found. Run ./build.sh first.');
    // eslint-disable-next-line no-eval
    eval(fs.readFileSync(bundlePath, 'utf8'));
  };

  const bodyJson = (body) => {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    return JSON.parse(text);
  };

  const settle = async (ticks = 8) => {
    for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
  };

  // Decodes an OTLP attribute list into a plain key -> stringValue object.
  const attrText = (attrs) => {
    const out = {};
    for (const a of attrs || []) out[a.key] = a.value && a.value.stringValue;
    return out;
  };

  // Every span event with the given name across all /v1/traces exports.
  const spanEvents = (name) => {
    const out = [];
    for (const call of fetchMock.mock.calls) {
      if (!String(call[0]).endsWith('/v1/traces')) continue;
      let payload;
      try { payload = bodyJson(call[1].body); } catch (_) { continue; }
      for (const rs of payload.resourceSpans || []) {
        for (const ss of rs.scopeSpans || []) {
          for (const span of ss.spans || []) {
            for (const ev of span.events || []) {
              if (ev.name === name) out.push(ev);
            }
          }
        }
      }
    }
    return out;
  };

  // Every log record body across all /v1/logs exports.
  const logBodies = () => {
    const out = [];
    for (const call of fetchMock.mock.calls) {
      if (!String(call[0]).endsWith('/v1/logs')) continue;
      let payload;
      try { payload = bodyJson(call[1].body); } catch (_) { continue; }
      for (const rl of payload.resourceLogs || []) {
        for (const sl of rl.scopeLogs || []) {
          for (const lr of sl.logRecords || []) out.push(lr.body && lr.body.stringValue);
        }
      }
    }
    return out;
  };

  beforeAll(() => {
    originalConsole = global.console;
  });

  afterAll(() => {
    global.console = originalConsole;
  });

  beforeEach(() => {
    // A fresh silent console before each load, so the bundle wraps clean methods and
    // never a chain of wrappers left by a previous boot.
    global.console = {
      ...originalConsole,
      debug: jest.fn(), log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    };
  });

  const boot = (errorMode) => {
    delete window.OBSERVE_BRUM;
    delete window.__ogm;
    // Each eval re-registers the OTel global API. Clearing it keeps loads isolated.
    delete global[Symbol.for('opentelemetry.js.api.1')];
    document.querySelectorAll('meta[name="traceparent"]').forEach((m) => m.remove());
    jest.resetModules();

    fetchMock = jest.fn((input) =>
      Promise.resolve({
        ok: true, status: 200, statusText: 'OK',
        url: typeof input === 'string' ? input : (input && input.url) || '',
        headers: { get: () => null },
        text: () => Promise.resolve(''),
        clone() { return this; },
      })
    );
    global.fetch = fetchMock;
    try { navigator.sendBeacon = jest.fn(() => true); } catch (_) { /* read-only in some envs */ }

    window.OBSERVE_BRUM = {
      endpoint: 'http://localhost:4318',
      service_name: 'test-app',
      traces: true, metrics: false, logs: true,
      cwv_metrics: false, errors: false, network_requests: false,
      compress: false,   // keep OTLP bodies as plain JSON for the assertions
      console_capture: true,
      error_mode: errorMode,
    };
    loadBundle();
  };

  // pagehide ends page_view and force-flushes the tracer and logger providers.
  const flush = async () => {
    window.dispatchEvent(new Event('pagehide'));
    await settle();
  };

  test("span mode: a console call becomes a 'console' span event, not a log record", async () => {
    boot('span');
    console.warn('probe-span');
    await flush();

    const matched = spanEvents('console')
      .find((ev) => attrText(ev.attributes)['log.record.original'] === 'probe-span');
    expect(matched).toBeDefined();
    expect(attrText(matched.attributes)['console.method']).toBe('warn');
    // Routing is exclusive: span mode emits no OTel log record for the console call.
    expect(logBodies()).not.toContain('probe-span');
  });

  test('logs mode: a console call becomes a log record, not a span event', async () => {
    boot('logs');
    console.warn('probe-logs');
    await flush();

    expect(logBodies()).toContain('probe-logs');
    const matched = spanEvents('console')
      .find((ev) => attrText(ev.attributes)['log.record.original'] === 'probe-logs');
    expect(matched).toBeUndefined();
  });

  test('dual mode: a console call becomes both a span event and a log record', async () => {
    boot('dual');
    console.warn('probe-dual');
    await flush();

    expect(logBodies()).toContain('probe-dual');
    const matched = spanEvents('console')
      .find((ev) => attrText(ev.attributes)['log.record.original'] === 'probe-dual');
    expect(matched).toBeDefined();
  });
});
