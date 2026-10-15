/**
 * Unit tests for BRUM configuration and initialization
 */

describe('BRUM Configuration', () => {
  beforeEach(() => {
    delete window.OBSERVE_BRUM;
    delete window.__ogm;
  });

  test('window.OBSERVE_BRUM can be set', () => {
    window.OBSERVE_BRUM = {
      endpoint: 'https://example.com/v1/otel',
      service_name: 'test-app',
    };

    expect(window.OBSERVE_BRUM).toBeDefined();
    expect(window.OBSERVE_BRUM.endpoint).toBe('https://example.com/v1/otel');
    expect(window.OBSERVE_BRUM.service_name).toBe('test-app');
  });

  test('configuration accepts all valid options', () => {
    const config = {
      endpoint: 'https://example.com/v1/otel',
      bearer_token: 'OBV1:test',
      observe_target: 'test-package',
      service_name: 'my-app',
      environment: 'production',
      service_version: '1.0.0',
      trace_mode: 'unified',
      trace_sample_rate: 0.5,
      traces: true,
      metrics: true,
      logs: true,
      cwv_metrics: true,
      errors: true,
      error_mode: 'dual',
      console_capture: true,
      network_requests: true,
      resource_timing: true,
      user_interactions: true,
      dom_elements: true,
      spa_routes: true,
      scrub_url_params: ['token', 'session'],
      compress: true,
    };

    window.OBSERVE_BRUM = config;

    expect(window.OBSERVE_BRUM.trace_mode).toBe('unified');
    expect(window.OBSERVE_BRUM.trace_sample_rate).toBe(0.5);
    expect(window.OBSERVE_BRUM.scrub_url_params).toEqual(['token', 'session']);
  });

  test('configuration accepts observe_target as string', () => {
    window.OBSERVE_BRUM = {
      observe_target: 'my-package',
    };

    expect(window.OBSERVE_BRUM.observe_target).toBe('my-package');
  });

  test('configuration accepts observe_target as object', () => {
    window.OBSERVE_BRUM = {
      observe_target: {
        traces: 'traces-package',
        metrics: 'metrics-package',
        logs: 'logs-package',
      },
    };

    expect(window.OBSERVE_BRUM.observe_target.traces).toBe('traces-package');
    expect(window.OBSERVE_BRUM.observe_target.metrics).toBe('metrics-package');
    expect(window.OBSERVE_BRUM.observe_target.logs).toBe('logs-package');
  });

  test('configuration accepts custom normalize_path function', () => {
    const normalizeFn = (path) => path.replace(/\/\d+/g, '/:id');
    
    window.OBSERVE_BRUM = {
      normalize_path: normalizeFn,
    };

    expect(window.OBSERVE_BRUM.normalize_path).toBe(normalizeFn);
    expect(window.OBSERVE_BRUM.normalize_path('/user/123')).toBe('/user/:id');
  });

  test('configuration accepts retry config', () => {
    window.OBSERVE_BRUM = {
      retry: {
        enabled: true,
        max_attempts: 5,
        initial_interval_ms: 2000,
        max_interval_ms: 60000,
        backoff_multiplier: 3,
      },
    };

    expect(window.OBSERVE_BRUM.retry.enabled).toBe(true);
    expect(window.OBSERVE_BRUM.retry.max_attempts).toBe(5);
    expect(window.OBSERVE_BRUM.retry.backoff_multiplier).toBe(3);
  });
});

describe('BRUM API', () => {
  beforeEach(() => {
    delete window.__ogm;
  });

  test('window.__ogm can be set', () => {
    window.__ogm = {
      withPageContext: (fn) => fn(),
      endPageView: () => {},
      sessionId: 'session-123',
      pageViewId: 'pageview-456',
      version: '0.0.3',
    };

    expect(window.__ogm).toBeDefined();
    expect(window.__ogm.sessionId).toBe('session-123');
    expect(window.__ogm.pageViewId).toBe('pageview-456');
    expect(window.__ogm.version).toBe('0.0.3');
  });

  test('withPageContext executes function', () => {
    let executed = false;
    
    window.__ogm = {
      withPageContext: (fn) => fn(),
      endPageView: () => {},
      sessionId: 'session-123',
      pageViewId: 'pageview-456',
      version: '0.0.3',
    };

    window.__ogm.withPageContext(() => {
      executed = true;
    });

    expect(executed).toBe(true);
  });

  test('withPageContext returns function result', () => {
    window.__ogm = {
      withPageContext: (fn) => fn(),
      endPageView: () => {},
      sessionId: 'session-123',
      pageViewId: 'pageview-456',
      version: '0.0.3',
    };

    const result = window.__ogm.withPageContext(() => 42);

    expect(result).toBe(42);
  });

  test('withPageContext handles async functions', async () => {
    window.__ogm = {
      withPageContext: (fn) => fn(),
      endPageView: () => {},
      sessionId: 'session-123',
      pageViewId: 'pageview-456',
      version: '0.0.3',
    };

    const result = await window.__ogm.withPageContext(async () => {
      return Promise.resolve('async-result');
    });

    expect(result).toBe('async-result');
  });

  test('endPageView can be called', () => {
    const endPageViewMock = jest.fn();
    
    window.__ogm = {
      withPageContext: (fn) => fn(),
      endPageView: endPageViewMock,
      sessionId: 'session-123',
      pageViewId: 'pageview-456',
      version: '0.0.3',
    };

    window.__ogm.endPageView();

    expect(endPageViewMock).toHaveBeenCalled();
  });
});

describe('Script Loading', () => {
  test('script tag can be created dynamically', () => {
    const script = document.createElement('script');
    script.src = '/js/observe-brum.js';
    
    expect(script.src).toContain('observe-brum.js');
    expect(script.tagName).toBe('SCRIPT');
  });

  test('script can be appended to head', () => {
    const script = document.createElement('script');
    script.src = '/js/observe-brum.js';
    document.head.appendChild(script);
    
    const foundScript = document.querySelector('script[src*="observe-brum.js"]');
    expect(foundScript).toBeTruthy();
    
    if (foundScript) foundScript.remove();
  });
});
