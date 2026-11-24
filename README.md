# Observe BRUM (Browser Real User Monitoring)

Observe BRUM is a browser agent built on OpenTelemetry. Real User Monitoring (RUM) records real visitor experience. You add the agent script and a small configuration block to a page. The agent then produces distributed traces, Core Web Vitals and structured logs. Your backend needs no change.

## Features

- Distributed tracing. A W3C `traceparent` header on each fetch and XHR call links browser spans to backend traces.
- Core Web Vitals. The agent records LCP, INP, CLS, FCP and TTFB as OpenTelemetry histograms, or as OpenTelemetry log events.
- OpenTelemetry browser events. Options switch web vitals, errors, navigation and page-load timing to the event-based instrumentations from [opentelemetry-browser](https://github.com/open-telemetry/opentelemetry-browser). The agent's own capture stays the default.
- Service maps. A `server.address` attribute on each outbound call feeds the Observe dependency graph.
- Console capture. The agent forwards `console.*` calls as structured logs with trace correlation.
- Error tracking. The agent logs unhandled exceptions and promise rejections with a full stack trace.
- Agent RED metrics. The agent can derive request rate, error rate and duration from its own spans.
- User interactions. The stock OTel user-interaction plugin records clicks, form events and other DOM events as spans. A configuration value puts them in the page trace or in their own trace. This feature is opt-in and can capture personal data.

---

## Install

You have two options. Download a pre-built release, or build the bundle from source.

### Option 1: Download the latest release

1. Open the [releases page](https://github.com/observeinc/observe-browser-observability-sdk/releases/latest).
2. Download the `observe-brum.js` file from the latest release.
3. Copy the file to the public directory of your web server.

### Option 2: Build from source

1. Open a terminal in the root directory of the repository.
2. Run `npm install`.
3. Run `npm run build`.
4. Copy `dist/observe-brum.js` to the public directory of your web server.

The build writes `dist/observe-brum.js`.

### Add the script to your page

Set the configuration before the script tag. Add both to the page `<head>`.

```html
<head>
  <script>
    window.OBSERVE_BRUM = {
      // OTLP collector endpoint
      endpoint: 'https://your-cust-id.collect.observeinc.com/v2/otel',

      // Bearer token for authentication
      bearer_token: 'OBV1:encoded-token-here',

      // Per-signal datastream routing. If you send data directly to Observe
      // instead of through your own collector, you must set this.
      observe_target: {
        traces: 'Tracing',
        metrics: 'Metrics',
        logs: 'Logging',
      },

      // Service identity
      service_name: 'my-web-app',
      environment: 'production',
      service_version: '1.2.3',
      service_namespace: 'payments',

      // Agent RED metrics
      agent_metrics: { enabled: true },
    };
  </script>
  <script src="js/observe-brum.js"></script>
</head>
```

---

## Configuration

Set every option on `window.OBSERVE_BRUM` before you load the script. No option is required, because every option has a default. OTLP is the OpenTelemetry protocol for telemetry export.

### Connection and authentication

| Option | Type | Default | Description |
|---|---|---|---|
| `endpoint` | string | `''` | OTLP collector URL. An empty value means same-origin. |
| `bearer_token` | string | `''` | Encoded token (`OBV1:...`) for authentication. |
| `observe_target` | string or object | `{}` | Per-signal datastream routing header (`x-observe-target-package`). A string applies to all signals. |

### Identity

| Option | Type | Default | Description |
|---|---|---|---|
| `service_name` | string | `'observe-brum-app'` | Your application name. |
| `environment` | string | `'production'` | Deployment environment. Sets `deployment.environment.name`. |
| `service_version` | string | `''` | Application version. Empty by default. |
| `service_namespace` | string | not set | Group of related services this application belongs to. If you do not set it, or set it to `null` or `''`, the key is absent. RED metrics send `''` instead. |

### Trace configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `trace_mode` | string | `'unified'` | One of `'unified'`, `'split'` or `'stock'`. See [Trace modes](#trace-modes). |
| `trace_sample_rate` | number | `1.0` | Sampling rate from 0.0 to 1.0. |

#### Trace modes

The `trace_mode` option sets how the agent groups spans into traces. A `page_view` span is a root span that covers one page view.

| Value | Behaviour |
|---|---|
| `'unified'` | The agent starts a `page_view` span for each page view. Document-load spans, fetch spans, and XHR spans go into the `page_view` trace. A fetch or XHR call inside a user interaction goes into the trace of that interaction. |
| `'split'` | The agent does not start a `page_view` span. The stock OTel instrumentations record all spans. Each fetch or XHR call starts its own root trace. |
| `'stock'` | The agent does not start a `page_view` span. The stock OTel instrumentations record all spans with their default behaviour. |

In this version, `'split'` and `'stock'` produce the same spans.

If `trace_mode` is `'split'` or `'stock'`, the agent sets `user_interactions.trace` to `'separate'`. The agent ignores a `'page_view'` value, because these modes have no `page_view` trace.

### Signal toggles

| Option | Type | Default | Description |
|---|---|---|---|
| `traces` | boolean | `true` | Enable trace collection. |
| `metrics` | boolean | `true` | Enable metric collection. |
| `logs` | boolean | `true` | Enable log collection. |
| `cwv_metrics` | boolean | `true` | Enable Core Web Vitals. |
| `cwv_mode` | string | `'metrics'` | One of `'metrics'` or `'events'`. See [OpenTelemetry browser events](#opentelemetry-browser-events). |
| `errors` | boolean | `true` | Enable error tracking. |
| `error_mode` | string | `'logs'` | One of `'logs'`, `'span'` or `'dual'`. Also sets where console capture goes. |
| `error_source` | string | `'agent'` | One of `'agent'` or `'otel'`. Sets what writes the error log record. |
| `navigation_events` | boolean | `false` | Emit a `browser.navigation` event for the page load and for each route change. |
| `load_timing` | string | `'spans'` | One of `'spans'` or `'events'`. Sets how the agent records page-load timing. |
| `console_capture` | boolean | `true` | Capture `console.*` calls. The destination follows `error_mode`. |
| `network_requests` | boolean | `true` | Trace fetch and XHR requests. |
| `user_interactions` | boolean or object | `false` | Track DOM events such as clicks. See [User interactions](#user-interactions). This feature is opt-in and can capture personal data. |
| `dom_elements` | boolean | `true` | Include DOM element attributes. |
| `spa_routes` | boolean | `false` | Track single-page navigations. |

### OpenTelemetry browser events

The [opentelemetry-browser](https://github.com/open-telemetry/opentelemetry-browser) project is the future home of the OpenTelemetry browser SDK. Its `@opentelemetry/browser-instrumentation` package emits OTel log events, not spans or metrics. An event is a log record with an `eventName`. These options switch a feature to that package. The agent's own capture stays the default for each feature.

| Option | Value | Instrumentation | Event name |
|---|---|---|---|
| `cwv_mode` | `'events'` | `WebVitalsInstrumentation` | `browser.web_vital` |
| `error_source` | `'otel'` | `ErrorsInstrumentation` | `exception` |
| `navigation_events` | `true` | `NavigationInstrumentation` | `browser.navigation` |
| `load_timing` | `'events'` | `NavigationTimingInstrumentation` and `ResourceTimingInstrumentation` | `browser.navigation_timing` and `browser.resource_timing` |

```html
<script>
  window.OBSERVE_BRUM = {
    endpoint: 'https://collector.example.com',
    service_name: 'my-app',
    cwv_mode: 'events',
    error_source: 'otel',
    navigation_events: true,
    load_timing: 'events',
  };
</script>
```

All events need `logs` set to `true`. If `logs` is `false`, these options emit nothing. The agent adds the same values to each event as to its own logs:
- `session.id`, `page_view.id` and the other per-signal attributes.
- The trace context of the active span, or of the page_view span. This links each event to the page trace.
- A scrubbed `url.full`, per `scrub_url_params`.

The package is experimental. Its event names and attribute names can change in a minor release.

#### Web vitals as events

If `cwv_mode` is `'events'`, the agent sends no `web.vitals.*` metrics. Each web vital report becomes one `browser.web_vital` event instead. `cwv_metrics` still turns web vitals on and off in both modes.
- Attributes: `browser.web_vital.name` (for example `lcp`), `.value`, `.delta`, `.rating`, `.id` and `.navigation_type`.
- A web vital can report more than once, for example a new LCP candidate. The latest event for a `browser.web_vital.id` holds the current value. The `browser.web_vital.delta` values for one ID add up to that value.

#### Errors from the OTel instrumentation

If `error_source` is `'otel'`, the `ErrorsInstrumentation` writes the error log record. The agent writes none. `error_mode` still applies:
- `'logs'` or `'dual'`: one `exception` event with `exception.type`, `exception.message`, `exception.stacktrace` and `page.pathname`. The event has no `error.source` attribute.
- `'span'`: no log record.
- In all modes, the agent still adds the span event and sets the page_view span status to error.

#### Navigation events

`navigation_events` adds events only. The `spa_routes` option still sets whether a route change starts a new page_view span.
- The page load gives one event with `browser.navigation.same_document` set to `false`.
- Each `pushState`, `replaceState` and `popstate` route change gives one event with `browser.navigation.type`, `browser.navigation.same_document`, `browser.navigation.hash_change` and `url.full`.

#### Page-load timing as events

If `load_timing` is `'events'`, the agent sends no `documentLoad`, `documentFetch` or `resourceFetch` spans:
- One `browser.navigation_timing` event per document load holds the Navigation Timing values.
- One `browser.resource_timing` event per static resource holds the Resource Timing values.
- If `network_requests` is `true`, the agent drops the event for a `fetch` or `xhr` call. That call already has its own CLIENT span.
- The page_view span ends one task after the `load` event, as it does with `dom_elements` set to `false`.

### User interactions

The stock OTel user-interaction plugin records the events. The agent sets only the parent and the trace of each interaction span. Set `user_interactions` to `true` for the default values, or to an object.

| Option | Type | Default | Description |
|---|---|---|---|
| `user_interactions.enabled` | boolean | `true` in an object | Turn the feature on or off. |
| `user_interactions.event_names` | string[] | See [Recorded events](#recorded-events) | DOM events to record. The agent passes the list to the plugin as `eventNames`. A list that you give replaces the default list. |
| `user_interactions.trace` | string | `'separate'` | `'separate'` puts the interactions of each page view in one interaction trace. `'page_view'` puts interaction spans in the page view trace. If `trace_mode` is not `'unified'`, the agent ignores `'page_view'`. |

```js
window.OBSERVE_BRUM = {
  user_interactions: { trace: 'page_view', event_names: ['click', 'submit'] },
};
```

With `trace: 'page_view'`, each interaction span is a child of `page_view`. A fetch or XHR call in the event handler is a child of the interaction span.

With `trace: 'separate'`, the agent makes a trace ID for interactions at the start of each page view. It puts the ID on `page_view` as the `user_interaction.trace_id` attribute. All interactions on that page view use this trace ID:

1. Each interaction span is a root span in the interaction trace, with no parent span.
2. Every span in the interaction trace has the `page_view.trace_id` and `page_view.span_id` attributes.
3. Each interaction span has an OTel span link to `page_view`.
4. A fetch or XHR call in the event handler is a child of the interaction span. Its `traceparent` header carries the interaction trace to the backend.

The interaction trace also holds the `page_visit` span from [Time on page](#time-on-page). The `user_interaction.trace_id` on `page_view` therefore always names a trace that exists. This is true also for a page view with no interaction.

A new page view gets a new interaction trace ID. In a single-page application, set `spa_routes` to `true` to start a new page view on each route change. A bfcache restore always starts a new page view. If `spa_routes` is `false`, all interactions until the next full page load share one interaction trace.

If `page_view` is not sampled, the agent makes no interaction trace ID, and the interactions are not sampled either. If `trace_sample_rate` is below `1.0`, the interaction trace has its own sampling decision. The ID on `page_view` can then name a trace that the agent did not send. In `split` and `stock` trace modes there is no page view, so each interaction is the root of its own trace.

To stop the agent from recording an element, add the `data-brum-ignore` attribute to the element or to a parent of it.

#### Time on page

The agent records the time on page as one `page_visit` span for each page view. The span is part of the user interactions feature:

1. Name is `visit {route}`, for example `visit /accounts`. This is the `{verb} {target}` form that `GET /path` also uses.
2. Kind is INTERNAL, and `browser.span_type` is `page_visit`.
3. With `trace: 'separate'`, the span is a root span in the interaction trace, with a span link to `page_view`. With `trace: 'page_view'`, the span is a child of `page_view`.
4. The span starts with `page_view` and ends at the end of the page view. That is the `pagehide` event, or an SPA route change with `spa_routes` set to `true`. The span duration is the total time on the page.
5. `page_view.visible_duration` is the time in seconds that the tab was visible. The OTel semantic conventions use seconds for durations.
6. `page_view.end_reason` is `pagehide` or `route_change`.

If a mobile browser discards a hidden tab without a `pagehide` event, the `page_visit` span for that page view is lost.

#### Recorded events

The event names come from the [HTMLElement events](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement#events) on MDN, and from the `Element` events that `HTMLElement` inherits. If the page has no listener for an event, the plugin records nothing for it. It makes one span for each listener call.

| Group | Default events | Opt-in events |
|---|---|---|
| Pointer | `click`, `dblclick`, `auxclick`, `contextmenu` | `pointerdown`, `pointerup`, `mousedown`, `mouseup`, `touchstart`, `touchend`, `mousemove`, `pointermove`, `touchmove`, `wheel` |
| Forms | `submit`, `reset`, `change` | `input`, `beforeinput`, `invalid` |
| Keyboard and focus | None | `keydown`, `keyup`, `focusin`, `focusout`, `focus`, `blur` |
| Clipboard | `copy`, `cut`, `paste` | None |
| Commands and toggles | `command`, `beforetoggle`, `toggle`, `interest`, `loseinterest` | None |
| Drag and drop | `dragstart`, `dragend`, `drop` | `drag`, `dragover`, `dragenter`, `dragleave` |
| Scroll | None | `scroll`, `scrollend` |
| Resources | None | `load`, `error` |

The default list holds the events that mark one user action. The opt-in events fire many times for one action, or do not come from the user. If you add them, the agent can send many spans for each page view. To add events, give the full list:

```js
window.OBSERVE_BRUM = {
  user_interactions: { event_names: ['click', 'submit', 'change', 'keydown'] },
};
```

### Path normalisation

| Option | Type | Default | Description |
|---|---|---|---|
| `auto_path_normalization` | boolean | `true` | Apply the built-in heuristics for UUIDs, IDs and hashes. |
| `normalize_path` | function | `null` | Custom path normaliser: `(path) => normalised`. |
| `resolve_route` | function | `null` | Route resolver: `(url, path) => template or null`. This is the preferred source for the span-name route. |

### Privacy and performance

| Option | Type | Default | Description |
|---|---|---|---|
| `scrub_url_params` | string[] | `['token', 'session', 'password', 'access_token', 'refresh_token', 'sig', 'X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-Security-Token', 'X-Goog-Signature']` | Query parameters to redact. |
| `compress` | boolean | `true` | Gzip OTLP payloads. |

### Agent RED metrics

RED metrics are request rate, error rate and duration. This feature is off by default. When you enable it, the agent reads its own spans in the browser and derives the metrics from them. The output matches what the Observe `spanmetrics` connector produces inside a collector.

If your Observe tenant sets `APM.flagREDMetricsGeneratedByAgent` to `true`, turn this feature on. That flag points the Service Explorer at pre-computed RED metrics from the agent. It is the default for tenants created after 1 July 2026. On such a tenant with agent metrics off, browser traffic shows zero requests per second.

The RED metrics come from the agent's own spans and export on the metrics signal. The feature needs both `traces` and `metrics` on. Both signals are on by default. If you turn off either signal, `agent_metrics.enabled` has no effect. The agent then emits no RED metrics and shows no error.

| Option | Type | Default | Description |
|---|---|---|---|
| `agent_metrics.enabled` | boolean | `false` | Emit the RED metric streams. |
| `agent_metrics.summary_stream` | boolean | `true` | Also emit the reduced-dimension `.summary` streams. |
| `agent_metrics.span_kinds` | string[] | `['SERVER', 'CLIENT']` | Span kinds to meter. Valid values: `SERVER`, `CLIENT`, `CONSUMER`, `PRODUCER`, `INTERNAL`. |
| `agent_metrics.peer_dimensions` | boolean | `true` | Add `server.address` to CLIENT metrics, which draws the service-map edge. |
| `agent_metrics.max_span_duration_ms` | number | `3600000` | Drop spans longer than this value. One stuck span then cannot skew the percentiles. |
| `agent_metrics.scale_by_sample_rate` | boolean | `true` | Weight each count by `1 / trace_sample_rate`. |
| `agent_metrics.cardinality_limit` | number | `200` | Maximum unique attribute combinations per stream. |

```js
window.OBSERVE_BRUM = {
  endpoint: 'https://your-cust-id.collect.observeinc.com/v2/otel',
  agent_metrics: { enabled: true },
};
```

This feature is read-only by design. The collector shapes spans with `transform` processors before the connector reads them. The agent does not. The agent derives every dimension in memory and attaches it to the metric data point. Your spans stay exactly as they were.

The collector `filter/drop_non_apm_spans` processor keeps SERVER and CONSUMER spans. For CLIENT spans, it keeps only database calls. The agent widens this on purpose to every CLIENT span. Client-observed API latency includes network time, and only a browser agent measures it. The `documentLoad`, `resourceFetch` and `user_interaction` spans are not requests. INTERNAL spans stay out.

### Advanced: retry configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `retry.enabled` | boolean | `true` | Enable exponential backoff retry. |
| `retry.max_retries` | number | `5` | Maximum retry attempts (0 to 20). |
| `retry.initial_backoff_ms` | number | `1000` | Initial backoff (1 to 60000 ms). |
| `retry.max_backoff_ms` | number | `30000` | Maximum backoff (1 to 600000 ms). |
| `retry.multiplier` | number | `1.5` | Backoff multiplier (1 to 10). |
| `retry.max_elapsed_ms` | number | `120000` | Total retry window (1 to 1800000 ms). |

### Advanced: client IP enrichment

| Option | Type | Default | Description |
|---|---|---|---|
| `client_ip.enabled` | boolean | `false` | Probe the Cloudflare trace endpoint for the client IP. |
| `client_ip.timeout_ms` | number | `5000` | Probe timeout (100 to 30000 ms). |
| `client_ip.cache_ttl_ms` | number | `3600000` | localStorage cache lifetime (0 to 86400000 ms, default 1 hour). |
| `client_ip.trace_url` | string | `'https://www.cloudflare.com/cdn-cgi/trace'` | Trace endpoint URL. |

The agent uses a single endpoint, so the captured address is whichever IP family the connection egressed on. Most RUM vendors capture the client IP on the server at the ingest layer instead. When you control the collector or proxy, prefer that approach.

### Development

| Option | Type | Default | Description |
|---|---|---|---|
| `console_banner` | boolean | `false` in production, `true` in development | Show the startup banner. |

### Trace modes

| Mode | Description |
|---|---|
| `unified` | One trace per page. `page_view` is the root, and all activity is a child of it. |
| `split` | Document loads sit under a `dom_loads` root. Each fetch and XHR call is its own trace. |
| `stock` | No custom roots. The OTel auto-instrumentations emit separate traces. |

---

## API

The bundle exposes `window.__ogm` for programmatic use.

```js
// Run code with the page_view context
window.__ogm.withPageContext(() => {
  // Code here inherits the page_view span context
  fetch('/api/data'); // Parented under page_view
});

// End the current page_view span early
window.__ogm.endPageView();

// Read the session and page IDs
console.log(window.__ogm.sessionId);    // 30-minute rolling session UUID
console.log(window.__ogm.pageViewId);   // Per-navigation UUID
console.log(window.__ogm.version);      // BRUM version
```

---

## Signals emitted

### Traces

A span records one timed operation.

The `page_view` span is the root span in unified mode:
- Kind is SERVER.
- Name is `GET /path`, the spec-compliant `{method} {route}` form.
- A `browser.span_type` attribute set to `page_view`, so you can query the span by type.
- Attributes: `http.request.method`, `http.route`, `http.response.status_code`, `url.path`, `url.full`, `url.scheme`, `url.domain`.
- `http.response.status_code` is the real status of the document response. The agent reads the value from the Navigation Timing API. When the browser does not expose the value, the attribute stays absent. Safari has no support for the value. Firefox added support in version 129.
- A 5xx response sets the span status to error, per the OTel HTTP semantic conventions for a SERVER span. A 4xx response does not set the span status to error, because a 4xx response is the fault of the caller and not this page.
- Parent of every child span in the page: document load, resource loads, network calls, interactions and errors.

The `fetch` and `xhr` spans are auto-instrumented (CLIENT kind):
- Name is `{method} {route}`, for example `GET /api/accounts`.
- Attributes: `server.address`, `server.port`, `url.full` (scrubbed), `url.template`, `http.request.method`, `http.response.status_code`.
- The agent injects the W3C `traceparent` header into the request, which links the browser span to the backend trace.

The document-load spans are `documentLoad`, `documentFetch` and `resourceFetch` (INTERNAL kind):
- The OTel document-load instrumentation emits these spans for the page load and its static resources.
- A `resourceFetch` span for a static resource carries `server.address`.
- The agent drops the duplicate `resourceFetch` span for a `fetch` or `xhr` call, because that call already has its own CLIENT span.

The `user_interaction` spans are opt-in. The stock OTel user-interaction plugin emits them:
- Kind is INTERNAL.
- Name is the event name, for example `click`. If the handler changes the route with the History API, the name becomes `Navigation: /path`.
- A `browser.span_type` attribute set to `user_interaction`.
- Plugin attributes: `event_type`, `target_element` (the tag name), `target_xpath` and `url.full`. The agent scrubs `url.full` with `scrub_url_params`. The plugin does not record element text or input values.
- The plugin makes one span for each event listener that handles the event.
- With `trace: 'separate'`, the cross-trace attributes from [User interactions](#user-interactions) also apply.

The `page_visit` span records the time on page. It is part of the user interactions feature. [Time on page](#time-on-page) describes it.

### Metrics

With `cwv_mode` set to `'metrics'`, Core Web Vitals arrive as OpenTelemetry histograms.

| Metric | Unit | Dimensions |
|---|---|---|
| `web.vitals.lcp` | ms | `page`, `rating`, `navigation_type` |
| `web.vitals.inp` | ms | `page`, `rating`, `navigation_type` |
| `web.vitals.cls` | 1 | `page`, `rating`, `navigation_type` |
| `web.vitals.fcp` | ms | `page`, `rating`, `navigation_type` |
| `web.vitals.ttfb` | ms | `page`, `rating`, `navigation_type` |

- `rating` is `good`, `needs-improvement` or `poor`, per the Google thresholds.
- `page` is the normalised path. The agent replaces UUIDs and hashes with `:id` and `:hash`.

The agent emits the RED metrics only with `agent_metrics.enabled` set. A delta metric reports change since the last export.

| Metric | Instrument | Unit |
|---|---|---|
| `traces.span.metrics.calls` | delta sum | `1` |
| `traces.span.metrics.duration` | delta exponential histogram (`max_size` 100) | `ms` |
| `traces.span.metrics.calls.summary` | delta sum | `1` |
| `traces.span.metrics.duration.summary` | delta exponential histogram (`max_size` 100) | `ms` |

Dimensions on the full streams:

| Dimension | Value |
|---|---|
| `span.name` | Span name, already low cardinality, for example `GET /api/accounts`. |
| `span.kind` | `SPAN_KIND_SERVER` or `SPAN_KIND_CLIENT`. |
| `otel.status_code` | `OK` or `ERROR`. Omitted for an unset span status. |
| `otel.status_description` | Span status message, error spans only, truncated to 128 characters. |
| `observe.status_code` | HTTP or RPC status code. Taken from the first key present out of `rpc.grpc.status_code`, `grpc.status_code`, `rpc.status_code`, `http.status_code`, `http.response.status_code`. |
| `server.address` | Callee host on CLIENT spans, which draws the service-map edge. |

Cardinality is the number of unique attribute combinations. The `.summary` streams carry `span.name`, `span.kind`, `otel.status_code` and `observe.status_code` only. The `service.name`, `service.version` and `deployment.environment.name` values travel on the resource, not on the data points.

Observe groups RED metrics by resource. On this resource, `service.name`, `deployment.environment.name` and `service.namespace` always carry a value. If you leave one unconfigured, its value is an empty string, not a missing key. This fallback applies to RED metrics only. If you set a value that is not empty, traces, logs and `web.vitals.*` metrics send `service.namespace`. Otherwise they leave the key out.

### Logs

Error logs cover unhandled exceptions and promise rejections:
- Attributes: `exception.type`, `exception.message`, `exception.stacktrace`.
- `error.source` is `window.error` or `unhandledrejection`.
- Correlated with the active trace and span IDs.

The [OpenTelemetry browser events](#opentelemetry-browser-events) options add the `browser.web_vital`, `exception`, `browser.navigation`, `browser.navigation_timing` and `browser.resource_timing` events.

Console capture is optional:
- The agent taps `console.debug`, `console.log`, `console.info`, `console.warn` and `console.error`.
- The `error_mode` option sets the destination.
- In `logs` mode each call becomes an OTel log record with the severity, method, message and active trace context.
- In `span` mode each call becomes a `console` span event with the method and message. The event attaches to the active span, or to the page_view span as a fallback.
- In `dual` mode the agent emits both.

---

## Resource attributes

The agent attaches these attributes to every signal.

| Attribute | Value |
|---|---|
| `service.name` | Configured. |
| `deployment.environment.name` | Configured. |
| `service.version` | The configured version, or empty. |
| `service.namespace` | The configured value. If you do not set it, the key is absent. RED metrics send `''` instead. |
| `process.runtime.name` | `browser`. |
| `process.runtime.version` | The user agent string. |
| `browser.language` | From the native OTel browser detector. |
| `browser.platform` | From the native OTel browser detector. |
| `browser.mobile` | From the native OTel browser detector. |
| `user_agent.original` | From the native OTel browser detector. |
| `screen.width` and `screen.height` | Device screen resolution. |
| `telemetry.distro.name` | `observe-brum`. |
| `telemetry.distro.version` | Bundle version. |

The per-signal attributes are not on the resource. The agent injects `session.id`, `page_view.id`, the `url.*` components, `client.address` and `network.connection.type` on each span and log.

---

## Testing

```bash
# Run unit tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

See [TESTING.md](./TESTING.md) for details.

---

## Building

```bash
# Production build (minified)
npm run build

# Development build (with sourcemap)
npm run build:dev
```

See [BUILD.md](../BUILD.md) for advanced build options.

---

## Observe integration

- Direct or collector. Send directly to Observe over OTLP HTTP, or route through your own OpenTelemetry collector.
- Service maps. A `server.address` attribute on each outbound call feeds the dependency graph.
- Log and trace correlation. Logs carry the active `trace_id` and `span_id`.
- Per-signal routing. An optional `observe_target` header routes each signal to its datastream. If you send data directly to Observe, you must set this. See more information in the docs: [Configure your own OTel collector in a non-Kubernetes environment](https://docs.observeinc.com/docs/configure-your-own-otel-collector-in-a-non-kubernetes-environment).

---

## Licence

Apache-2.0

## Warranty

The Software is provided as Open Source. This software is provided “as is” and any express or implied warranties, including, but not limited to, the implied warranties of merchantability and fitness for a particular purpose are disclaimed. In no event shall the owner or contributors be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, procurement of substitute goods or services; loss of use, data, or profits; or business interruption) however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence or otherwise) arising in any way out of the use of this software, even if advised of the possibility of such damage.
