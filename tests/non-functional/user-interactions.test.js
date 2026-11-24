/**
 * User interactions (user_interactions).
 *
 * The stock OTel user-interaction plugin records the interactions. The agent only picks
 * the parent of each interaction span: page_view (one trace) or a separate trace that is
 * linked to page_view both ways. These tests load the compiled bundle, click a button
 * whose handler makes a fetch, fire pagehide, and read the OTLP trace exports back.
 */

const fs = require('fs');
const path = require('path');

const BUNDLE_PATH = path.join(__dirname, '../../dist/observe-brum.js');
if (!fs.existsSync(BUNDLE_PATH)) throw new Error('Bundle not found. Run ./build.sh first.');
const BUNDLE = fs.readFileSync(BUNDLE_PATH, 'utf8');

beforeAll(() => {
  // Same environment stubs as agent-metrics.test.js: instrumentation-fetch needs a
  // PerformanceObserver and a global Request to patch fetch in jsdom.
  if (typeof global.PerformanceObserver === 'undefined') {
    global.PerformanceObserver = class {
      constructor(cb) { this.callback = cb; }
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    };
    global.PerformanceObserver.supportedEntryTypes = ['resource', 'navigation', 'paint'];
  }
  if (typeof global.Request === 'undefined') global.Request = class Request {};
  global.PerformanceResourceTiming = class PerformanceResourceTiming {};
  Object.defineProperty(document, 'visibilityState', { writable: true, value: 'visible' });
  global.performance.getEntriesByType = () => [];
  global.performance.getEntriesByName = () => [];
});

let fetchMock;
let svc = '';
let bootCount = 0;

const bodyJson = (body) => JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body));

const attrsOf = (list) => {
  const out = {};
  for (const a of list || []) {
    const v = a.value || {};
    out[a.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
  }
  return out;
};

// Spans from this boot only. Bundles from earlier tests still patch fetch and the zone,
// so each boot gets its own service.name.
const spans = () => {
  const out = [];
  for (const call of fetchMock.mock.calls) {
    if (!String(call[0]).endsWith('/v1/traces')) continue;
    let payload;
    try { payload = bodyJson(call[1].body); } catch (_) { continue; }
    for (const rs of payload.resourceSpans || []) {
      if (attrsOf((rs.resource || {}).attributes)['service.name'] !== svc) continue;
      for (const ss of rs.scopeSpans || []) {
        for (const s of ss.spans || []) out.push({ ...s, attrs: attrsOf(s.attributes) });
      }
    }
  }
  return out;
};

const settle = async (ticks = 8) => {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * Loads the bundle, adds a button whose click handler calls fetch, clicks it, then fires
 * pagehide so every provider flushes. ignore adds data-brum-ignore to the button.
 */
const boot = async ({ config = {}, ignore = false, query = '', waitMs = 0, clicks = 1, spaNav = false, act } = {}) => {
  // zone.js reuses the global Zone, so the plugin of the previous bundle still wraps
  // every task. Unpatch it, so only this bundle's interaction spans are active.
  if (window.__ogm && window.__ogm._internal && window.__ogm._internal.unregisterInstrumentations) {
    window.__ogm._internal.unregisterInstrumentations();
  }
  delete window.OBSERVE_BRUM;
  delete window.__ogm;
  delete global[Symbol.for('opentelemetry.js.api.1')];
  jest.resetModules();
  svc = `ui-app-${++bootCount}`;

  fetchMock = jest.fn((input) =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: typeof input === 'string' ? input : (input && input.url) || '',
      headers: { get: () => null },
      text: () => Promise.resolve(''),
      clone() { return this; },
    })
  );
  global.fetch = fetchMock;

  window.OBSERVE_BRUM = {
    endpoint: 'http://localhost:4318',
    service_name: svc,
    traces: true,
    metrics: false,
    logs: false,
    cwv_metrics: false,
    errors: false,
    console_capture: false,
    ...config,
  };

  // eslint-disable-next-line no-eval
  eval(BUNDLE);

  if (query) history.replaceState(null, '', `/test.html${query}`);

  document.body.innerHTML = '';
  const button = document.createElement('button');
  button.id = 'ui-target';
  if (ignore) button.setAttribute('data-brum-ignore', '');
  document.body.appendChild(button);
  button.addEventListener('click', () => {
    window.fetch('http://localhost/api/accounts', { method: 'GET' }).catch(() => {});
  });
  if (clicks > 0) button.click();
  await settle(4);
  // More clicks on the same page, or, with spaNav, one SPA route change before each.
  for (let i = 1; i < clicks; i++) {
    if (spaNav) { history.pushState(null, '', `/route-${i}`); await settle(4); }
    button.click();
    await settle(4);
  }

  if (act) { act(); await settle(4); }

  window.dispatchEvent(new Event('pagehide'));
  await settle();
  if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
  if (query || spaNav) history.replaceState(null, '', '/test.html');
};

const byType = (all, type) => all.filter((s) => s.attrs['browser.span_type'] === type);
const clickSpan = (all) => byType(all, 'user_interaction').find((s) => s.name === 'click');
const fetchSpan = (all) => all.find((s) => s.attrs['url.full'] === 'http://localhost/api/accounts');

describe('user_interactions configuration', () => {
  test('omitted: no interaction spans', async () => {
    await boot();
    expect(byType(spans(), 'user_interaction')).toHaveLength(0);
  });

  test('true: click spans with the stock plugin attributes', async () => {
    await boot({ config: { user_interactions: true } });
    const click = clickSpan(spans());
    expect(click).toBeDefined();
    expect(click.attrs.event_type).toBe('click');
    expect(click.attrs.target_element).toBe('BUTTON');
    expect(click.attrs.target_xpath).toBeDefined();
  });

  test('object without enabled means on', async () => {
    await boot({ config: { user_interactions: { event_names: ['click'] } } });
    expect(clickSpan(spans())).toBeDefined();
  });

  test('enabled false turns it off', async () => {
    await boot({ config: { user_interactions: { enabled: false } } });
    expect(byType(spans(), 'user_interaction')).toHaveLength(0);
  });

  // A listener for each event in the default list, plus two opt-in events.
  const fireAll = (names) => () => {
    for (const n of names) {
      const el = document.createElement(n === 'submit' || n === 'reset' ? 'form' : 'div');
      document.body.appendChild(el);
      el.addEventListener(n, () => {});
      el.dispatchEvent(new Event(n, { bubbles: true }));
    }
  };
  const defaults = ['click', 'dblclick', 'auxclick', 'contextmenu', 'submit', 'reset', 'change',
    'copy', 'cut', 'paste', 'command', 'beforetoggle', 'toggle', 'interest', 'loseinterest',
    'dragstart', 'dragend', 'drop'];

  test('the default list records every discrete user action, and not continuous events', async () => {
    await boot({ config: { user_interactions: true }, clicks: 0, act: fireAll([...defaults, 'dragover', 'input']) });
    const names = new Set(byType(spans(), 'user_interaction').map((s) => s.attrs.event_type));
    for (const n of defaults) expect(names).toContain(n);
    expect(names).not.toContain('dragover');
    expect(names).not.toContain('input');
  });

  test('event_names replaces the default list', async () => {
    await boot({ config: { user_interactions: { event_names: ['dblclick'] } } });
    expect(clickSpan(spans())).toBeUndefined();
  });

  test('data-brum-ignore suppresses the span', async () => {
    await boot({ config: { user_interactions: true }, ignore: true });
    expect(byType(spans(), 'user_interaction')).toHaveLength(0);
  });

  test('url.full is scrubbed', async () => {
    await boot({ config: { user_interactions: true }, query: '?token=secret&q=1' });
    const click = clickSpan(spans());
    expect(click.attrs['url.full']).not.toContain('secret');
    expect(click.attrs['url.full']).toContain('q=1');
  });
});

describe("trace: 'page_view'", () => {
  test('the click nests under page_view and the fetch nests under the click', async () => {
    await boot({ config: { user_interactions: { trace: 'page_view' }, network_requests: true } });
    const all = spans();
    const pv = byType(all, 'page_view')[0];
    const click = clickSpan(all);
    const req = fetchSpan(all);
    expect(click.traceId).toBe(pv.traceId);
    expect(click.parentSpanId).toBe(pv.spanId);
    expect(req.traceId).toBe(pv.traceId);
    expect(req.parentSpanId).toBe(click.spanId);
    expect(byType(all, 'user_interaction_link')).toHaveLength(0);
    expect(click.attrs['page_view.trace_id']).toBeUndefined();
  });
});

describe("trace: 'separate' (default)", () => {
  const cfgSeparate = { user_interactions: { trace: 'separate' }, network_requests: true };
  const clicks = (all) => byType(all, 'user_interaction').filter((s) => s.name === 'click' || s.name.startsWith('Navigation'));

  test('true and an object without trace both default to separate', async () => {
    for (const ui of [true, { event_names: ['click'] }]) {
      await boot({ config: { user_interactions: ui } });
      const all = spans();
      expect(clickSpan(all).traceId).not.toBe(byType(all, 'page_view')[0].traceId);
    }
  });

  test('page_view carries the pre-spun trace ID, and every click on the page uses it', async () => {
    await boot({ config: cfgSeparate, clicks: 3 });
    const all = spans();
    const pv = byType(all, 'page_view')[0];
    const uiTrace = pv.attrs['user_interaction.trace_id'];
    expect(uiTrace).toMatch(/^[0-9a-f]{32}$/);
    expect(uiTrace).not.toBe(pv.traceId);
    expect(clicks(all)).toHaveLength(3);
    for (const c of clicks(all)) {
      expect(c.traceId).toBe(uiTrace);
      // Each click is a root span of the interaction trace. No fake parent span ID.
      expect(c.parentSpanId || '').toBe('');
      expect(c.attrs['page_view.trace_id']).toBe(pv.traceId);
      expect(c.attrs['page_view.span_id']).toBe(pv.spanId);
      expect(c.attrs['page_view.id']).toBe(pv.attrs['page_view.id']);
      expect(c.links).toEqual([expect.objectContaining({ traceId: pv.traceId, spanId: pv.spanId })]);
    }
  });

  test('no extra span in either trace', async () => {
    await boot({ config: cfgSeparate });
    const all = spans();
    const pv = byType(all, 'page_view')[0];
    const types = new Set(all.map((s) => s.attrs['browser.span_type']).filter(Boolean));
    expect(types).toEqual(new Set(['page_view', 'user_interaction', 'page_visit']));
    expect(all.filter((s) => s.traceId === pv.traceId).map((s) => s.attrs['browser.span_type'])).not.toContain('user_interaction');
  });

  test('with no interaction, the interaction trace holds only the page_visit span', async () => {
    await boot({ config: cfgSeparate, clicks: 0 });
    const all = spans();
    const pv = byType(all, 'page_view')[0];
    expect(pv.attrs['user_interaction.trace_id']).toMatch(/^[0-9a-f]{32}$/);
    const inUiTrace = all.filter((s) => s.traceId === pv.attrs['user_interaction.trace_id']);
    expect(inUiTrace.map((s) => s.attrs['browser.span_type'])).toEqual(['page_visit']);
  });

  test("trace: 'page_view' sets no user_interaction.trace_id", async () => {
    await boot({ config: { user_interactions: { trace: 'page_view' } } });
    expect(byType(spans(), 'page_view')[0].attrs['user_interaction.trace_id']).toBeUndefined();
  });

  test('disabled sets no user_interaction.trace_id', async () => {
    await boot();
    expect(byType(spans(), 'page_view')[0].attrs['user_interaction.trace_id']).toBeUndefined();
  });

  test('the fetch stays in the interaction trace and names the page_view trace', async () => {
    await boot({ config: cfgSeparate });
    const all = spans();
    const pv = byType(all, 'page_view')[0];
    const click = clickSpan(all);
    const req = fetchSpan(all);
    expect(req.traceId).toBe(click.traceId);
    expect(req.parentSpanId).toBe(click.spanId);
    expect(req.attrs['page_view.trace_id']).toBe(pv.traceId);
    // The traceparent header carries the interaction trace to the backend.
    const call = fetchMock.mock.calls.find((c) => c[0] === 'http://localhost/api/accounts');
    const headers = call[1].headers;
    const tp = typeof headers.get === 'function' ? headers.get('traceparent') : headers.traceparent;
    expect(tp).toContain(click.traceId);
  });

  test('every span in the interaction trace names the page_view trace', async () => {
    await boot({ config: cfgSeparate });
    const all = spans();
    const pv = byType(all, 'page_view')[0];
    const inUiTrace = all.filter((s) => s.traceId === pv.attrs['user_interaction.trace_id']);
    expect(inUiTrace.length).toBeGreaterThan(1);
    for (const s of inUiTrace) expect(s.attrs['page_view.trace_id']).toBe(pv.traceId);
  });

  test('SPA: each route change starts a new page view with a new interaction trace ID', async () => {
    await boot({ config: { ...cfgSeparate, spa_routes: true }, clicks: 3, spaNav: true });
    const all = spans();
    const pvs = byType(all, 'page_view');
    expect(pvs).toHaveLength(3);
    const ids = pvs.map((pv) => pv.attrs['user_interaction.trace_id']);
    expect(new Set(ids).size).toBe(3);
    for (const pv of pvs) {
      // One click happens on each page view, in that page view's interaction trace.
      const cs = clicks(all).filter((c) => c.traceId === pv.attrs['user_interaction.trace_id']);
      expect(cs).toHaveLength(1);
      expect(cs[0].attrs['page_view.trace_id']).toBe(pv.traceId);
      expect(cs[0].attrs['page_view.id']).toBe(pv.attrs['page_view.id']);
    }
  });

  test('SPA: without spa_routes, route changes stay in one page view and one interaction trace', async () => {
    await boot({ config: cfgSeparate, clicks: 3, spaNav: true });
    const all = spans();
    const pvs = byType(all, 'page_view');
    expect(pvs).toHaveLength(1);
    expect(new Set(clicks(all).map((c) => c.traceId))).toEqual(new Set([pvs[0].attrs['user_interaction.trace_id']]));
  });

  test('an unsampled page_view gets no interaction trace', async () => {
    await boot({ config: { ...cfgSeparate, trace_sample_rate: 0 } });
    expect(spans()).toHaveLength(0);
  });

  test("split trace_mode: each interaction is its own trace, with no page_view to name", async () => {
    // split mode flushes only metrics on pagehide, so wait for the 1s span batch timer.
    await boot({ config: { user_interactions: true, trace_mode: 'split', network_requests: false }, waitMs: 1300 });
    const all = spans();
    const click = clickSpan(all);
    expect(click).toBeDefined();
    expect(click.parentSpanId || '').toBe('');
    expect(click.attrs['page_view.trace_id']).toBeUndefined();
  });
});

describe('time on page (page_visit span)', () => {
  const visits = (all) => byType(all, 'page_visit');
  const nanos = (v) => BigInt(v);
  const durationSec = (s) => Number(nanos(s.endTimeUnixNano) - nanos(s.startTimeUnixNano)) / 1e9;
  const setVisibility = (state) => {
    document.visibilityState = state;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  test('separate: one root span in the interaction trace, from page_view start to pagehide', async () => {
    await boot({ config: { user_interactions: true } });
    const all = spans();
    const pv = byType(all, 'page_view')[0];
    expect(visits(all)).toHaveLength(1);
    const v = visits(all)[0];
    expect(v.name).toBe('visit /test.html');
    expect(v.kind).toBe(1); // SPAN_KIND_INTERNAL
    expect(v.traceId).toBe(pv.attrs['user_interaction.trace_id']);
    expect(v.parentSpanId || '').toBe('');
    expect(v.startTimeUnixNano).toBe(pv.startTimeUnixNano);
    expect(v.attrs['page_view.trace_id']).toBe(pv.traceId);
    expect(v.attrs['page_view.id']).toBe(pv.attrs['page_view.id']);
    expect(v.attrs['page_view.end_reason']).toBe('pagehide');
    expect(v.links).toEqual([expect.objectContaining({ traceId: pv.traceId, spanId: pv.spanId })]);
    // Ends at pagehide, not with the load subtree: it outlives page_view.
    expect(nanos(v.endTimeUnixNano) >= nanos(pv.endTimeUnixNano)).toBe(true);
  });

  test('visible_duration leaves out the time the tab was hidden', async () => {
    await boot({
      config: { user_interactions: true },
      clicks: 0,
      act: () => {
        setVisibility('hidden');
        const until = Date.now() + 120;
        while (Date.now() < until) { /* hidden for 120ms */ }
        setVisibility('visible');
      },
    });
    const v = visits(spans())[0];
    const visible = v.attrs['page_view.visible_duration'];
    expect(typeof visible).toBe('number');
    expect(visible).toBeGreaterThanOrEqual(0);
    expect(durationSec(v) - visible).toBeGreaterThanOrEqual(0.1);
  });

  test("trace: 'page_view': the visit span is a child of page_view", async () => {
    await boot({ config: { user_interactions: { trace: 'page_view' } } });
    const all = spans();
    const pv = byType(all, 'page_view')[0];
    const v = visits(all)[0];
    expect(v.traceId).toBe(pv.traceId);
    expect(v.parentSpanId).toBe(pv.spanId);
  });

  test('SPA: one visit per page view, ended by the route change', async () => {
    await boot({ config: { user_interactions: true, spa_routes: true }, clicks: 3, spaNav: true });
    const all = spans();
    const pvs = byType(all, 'page_view');
    const vs = visits(all);
    expect(vs).toHaveLength(3);
    for (const pv of pvs) {
      const v = vs.find((x) => x.traceId === pv.attrs['user_interaction.trace_id']);
      expect(v).toBeDefined();
      expect(v.name).toBe(`visit ${pv.attrs['http.route']}`);
      expect(v.attrs['page_view.id']).toBe(pv.attrs['page_view.id']);
    }
    expect(vs.map((v) => v.attrs['page_view.end_reason']).sort()).toEqual(['pagehide', 'route_change', 'route_change']);
  });

  test('disabled user_interactions: no visit span', async () => {
    await boot();
    expect(visits(spans())).toHaveLength(0);
  });
});
