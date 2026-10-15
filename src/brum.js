// Copyright 2026 Snowflake Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// brum.js is the Observe BRUM bundle. Configure via window.OBSERVE_BRUM in the
// page <head> before this script loads.

import { trace, metrics, context, SpanKind, SpanStatusCode, ValueType } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { defaultResource, resourceFromAttributes, detectResources } from '@opentelemetry/resources';

import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor, TraceIdRatioBasedSampler, ParentBasedSampler } from '@opentelemetry/sdk-trace-base';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

import {
    MeterProvider,
    PeriodicExportingMetricReader,
    AggregationType,
    createAllowListAttributesProcessor,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';

import { ExportResultCode } from '@opentelemetry/core';

import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { getWebAutoInstrumentations } from '@opentelemetry/auto-instrumentations-web';
import { browserDetector } from '@opentelemetry/opentelemetry-browser-detector';

// Semconv keys from the OTel library, so spelling tracks the SDK.
import {
    ATTR_HTTP_REQUEST_METHOD,
    ATTR_HTTP_ROUTE,
    ATTR_HTTP_RESPONSE_STATUS_CODE,
    ATTR_URL_FULL,
    ATTR_URL_PATH,
    ATTR_URL_SCHEME,
    ATTR_SERVER_ADDRESS,
    ATTR_SERVER_PORT,
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
    ATTR_SERVICE_NAMESPACE,
    ATTR_CLIENT_ADDRESS,
    ATTR_EXCEPTION_TYPE,
    ATTR_EXCEPTION_MESSAGE,
    ATTR_EXCEPTION_STACKTRACE,
} from '@opentelemetry/semantic-conventions';
import {
    ATTR_URL_TEMPLATE,
    ATTR_URL_DOMAIN,
    ATTR_SESSION_ID,
    ATTR_NETWORK_CONNECTION_TYPE,
    ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
    ATTR_TELEMETRY_DISTRO_NAME,
    ATTR_TELEMETRY_DISTRO_VERSION,
    ATTR_RPC_GRPC_STATUS_CODE,
    ATTR_PROCESS_RUNTIME_NAME,
    ATTR_PROCESS_RUNTIME_VERSION,
    ATTR_LOG_RECORD_ORIGINAL,
} from '@opentelemetry/semantic-conventions/incubating';

import { onLCP, onINP, onCLS, onFCP, onTTFB } from 'web-vitals';

import {
    BRUM_SDK_NAME,
    BRUM_VERSION,
} from './sdk-constants.js';

// Replaced at build time by esbuild --define. false in prod, true in dev.
const _isDev = (typeof __BRUM_DEV__ !== 'undefined') && __BRUM_DEV__;

// OBV1: prefix = versioned encoding. Raw tokens accepted as dev convenience.
function decodeBrumToken(s) {
    if (!s) return '';
    if (s.indexOf('OBV1:') !== 0) return s;
    try {
        const a = atob(s.slice(5));
        const b = a.split('').reverse().join('');
        const c = atob(b);
        return c.split('').reverse().join('');
    } catch (_) {
        return '';
    }
}

function uuidv4() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const a = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(a);
    } else {
        for (let i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
    }
    a[6] = (a[6] & 0x0f) | 0x40;
    a[8] = (a[8] & 0x3f) | 0x80;
    const h = Array.from(a, (b) => b.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

const _c = (typeof window !== 'undefined' && window.OBSERVE_BRUM) || {};
const _bool = (val, def = true) => val === undefined ? def : Boolean(val);

// Query params redacted from URLs. One source for the default and the banner check.
const _DEFAULT_SCRUB_PARAMS = [
    'token', 'session', 'password', 'access_token', 'refresh_token',
    // OTel semconv default sensitive query keys.
    'sig', 'X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-Security-Token', 'X-Goog-Signature',
];

const cfg = {
    endpoint:          _c.endpoint !== undefined ? _c.endpoint : '',
    bearer_token:      _c.bearer_token || '',

    // Per-signal datastream routing (x-observe-target-package). A bare string applies to all three.
    observe_target: (() => {
        const t = _c.observe_target;
        if (typeof t === 'string') return { traces: t, metrics: t, logs: t };
        if (t && typeof t === 'object') {
            return {
                traces:  typeof t.traces  === 'string' ? t.traces  : '',
                metrics: typeof t.metrics === 'string' ? t.metrics : '',
                logs:    typeof t.logs    === 'string' ? t.logs    : '',
            };
        }
        return { traces: '', metrics: '', logs: '' };
    })(),

    service_name:      _c.service_name    || 'observe-brum-app',
    environment:       _c.environment     || 'production',
    service_version:   _c.service_version || '',
    service_namespace: _c.service_namespace || '',

    trace_mode:        ['unified', 'split', 'stock'].indexOf(_c.trace_mode) >= 0 ? _c.trace_mode : 'unified',

    traces:            _bool(_c.traces),
    metrics:           _bool(_c.metrics),
    logs:              _bool(_c.logs),
    cwv_metrics:       _bool(_c.cwv_metrics),
    errors:            _bool(_c.errors),
    // 'logs' = OTel log records only (default)
    // 'span' = span events only (recordException on page_view span)
    // 'dual' = both
    error_mode:        (['logs', 'span', 'dual'].indexOf(_c.error_mode) >= 0 ? _c.error_mode : 'logs'),
    console_capture:   _bool(_c.console_capture),
    network_requests:  _bool(_c.network_requests),
    user_interactions: _bool(_c.user_interactions, false),
    dom_elements:      _bool(_c.dom_elements),
    spa_routes:        _bool(_c.spa_routes, false),

    // Normalises pathname used as a metric dimension or span name. Raw path stays in url.*.
    auto_path_normalization: _bool(_c.auto_path_normalization, true),
    normalize_path:          typeof _c.normalize_path === 'function' ? _c.normalize_path : null,
    // App route resolver: (url, path) => template or null. Feeds http.route and url.template,
    // falling back to normalize_path(). Semconv: a route is routing info, not a raw path.
    resolve_route:           typeof _c.resolve_route === 'function' ? _c.resolve_route : null,

    trace_sample_rate: typeof _c.trace_sample_rate === 'number' ? Math.max(0, Math.min(1, _c.trace_sample_rate)) : 1.0,

    scrub_url_params:  Array.isArray(_c.scrub_url_params) ? _c.scrub_url_params : _DEFAULT_SCRUB_PARAMS,
    compress:          _bool(_c.compress, true),

    // Retry and backoff. Wraps each OTLP exporter to retry transient failures with
    // exponential backoff and jitter. Honours Retry-After. enabled=false = single-shot.
    retry: (() => {
        const r = (_c.retry && typeof _c.retry === 'object') ? _c.retry : {};
        const num = (v, def, lo, hi) => {
            const n = typeof v === 'number' && isFinite(v) ? v : def;
            return Math.max(lo, Math.min(hi, n));
        };
        return {
            enabled:            _bool(r.enabled, true),
            max_retries:        num(r.max_retries,        5,    0, 20),
            initial_backoff_ms: num(r.initial_backoff_ms, 1000, 1, 60000),
            max_backoff_ms:     num(r.max_backoff_ms,     30000, 1, 600000),
            multiplier:         num(r.multiplier,         1.5,  1, 10),
            max_elapsed_ms:     num(r.max_elapsed_ms,     120000, 1, 1800000),
        };
    })(),

    // Client-IP enrichment, off by default. Probes Cloudflare cdn-cgi/trace once, stamps
    // client.address on every signal, and fails open. Prefer server-side capture at ingest.
    client_ip: (() => {
        const c = (_c.client_ip && typeof _c.client_ip === 'object') ? _c.client_ip : {};
        const numClamp = (v, def, lo, hi) => {
            const n = typeof v === 'number' && isFinite(v) ? v : def;
            return Math.max(lo, Math.min(hi, n));
        };
        return {
            enabled:    _bool(c.enabled, false),
            timeout_ms: numClamp(c.timeout_ms, 5000, 100, 30000),
            // localStorage TTL for the IP. One hour balances fetch cost against network changes.
            cache_ttl_ms: numClamp(c.cache_ttl_ms, 60 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
            // One endpoint lets the OS pick v4 or v6, matching the real egress address.
            trace_url:  typeof c.trace_url === 'string' && c.trace_url ? c.trace_url : 'https://www.cloudflare.com/cdn-cgi/trace',
        };
    })(),

    // Agent-side RED metrics (rate, errors, duration), off by default. Observe's Service
    // Explorer reads rate and latency from traces.span.metrics.calls and .duration, not
    // spans. With APM.flagREDMetricsGeneratedByAgent on (tenants after 2026-07-01) and this
    // off, browser traffic shows 0 req/s. This derives the metrics from spans, read-only.
    agent_metrics: (() => {
        const a = (_c.agent_metrics && typeof _c.agent_metrics === 'object') ? _c.agent_metrics : {};
        const numClamp = (v, def, lo, hi) => {
            const n = typeof v === 'number' && isFinite(v) ? v : def;
            return Math.max(lo, Math.min(hi, n));
        };
        // SpanKinds metered. Widens filter/drop_non_apm_spans to CLIENT, since browser-observed
        // API latency is unique to a browser agent. INTERNAL excluded (not requests).
        const _KINDS = ['SERVER', 'CLIENT', 'CONSUMER', 'PRODUCER', 'INTERNAL'];
        const kinds = Array.isArray(a.span_kinds)
            ? a.span_kinds.filter(k => _KINDS.indexOf(k) >= 0)
            : null;
        return {
            enabled:        _bool(a.enabled, false),
            // Also emit reduced-dimension .summary streams (spanmetrics/summary connector parity).
            summary_stream: _bool(a.summary_stream, true),
            span_kinds:     (kinds && kinds.length) ? kinds : ['SERVER', 'CLIENT'],
            // server.address on CLIENT metrics = the collector's groupbyattrs/peers. Draws the
            // browser-to-API edge on the service map.
            peer_dimensions: _bool(a.peer_dimensions, true),
            // Duration ceiling (filter/drop_long_spans). 1h matches the collector default.
            max_span_duration_ms: numClamp(a.max_span_duration_ms, 3600000, 1, 86400000),
            // Sampled spans undercount, so scale the counter by 1/rate. Histogram stays unscaled.
            scale_by_sample_rate: _bool(a.scale_by_sample_rate, true),
            // Cap on unique attribute combos per stream.
            cardinality_limit: numClamp(a.cardinality_limit, 200, 1, 10000),
        };
    })(),

    console_banner:    _bool(_c.console_banner, _isDev),
};

// Empty endpoint = same-origin (collector or auth-injecting proxy). Else the config wins.
const baseUrl = cfg.endpoint || (typeof window !== 'undefined' && window.location ? window.location.origin : '');
const TRACE_URL   = `${baseUrl}/v1/traces`;
const METRICS_URL = `${baseUrl}/v1/metrics`;
const LOGS_URL    = `${baseUrl}/v1/logs`;

// Bearer token, when set, becomes the Authorization header. observe_target[signal]
// becomes x-observe-target-package for per-signal routing. Both are non-safelisted,
// so they trigger a CORS preflight the upstream must answer.
const _decodedToken = decodeBrumToken(cfg.bearer_token);
function exportHeaders(signal) {
    const h = {};
    if (_decodedToken)            h['Authorization']            = `Bearer ${_decodedToken}`;
    const target = cfg.observe_target[signal];
    if (target)                   h['x-observe-target-package'] = target;
    return h;
}

// Exponential backoff with full jitter. OTel HTTP exporters do not retry, so this
// class wraps them. Honours Retry-After.
class RetryingExporter {
    constructor(inner, opts) {
        this._inner             = inner;
        this._maxRetries        = opts.max_retries;
        this._initialBackoffMs  = opts.initial_backoff_ms;
        this._maxBackoffMs      = opts.max_backoff_ms;
        this._multiplier        = opts.multiplier;
        this._maxElapsedMs      = opts.max_elapsed_ms;
        this._signal            = opts.signal || 'unknown';
    }

    export(items, resultCallback) {
        const start = Date.now();
        const attempt = (n) => {
            this._inner.export(items, (result) => {
                if (result.code === ExportResultCode.SUCCESS) {
                    resultCallback(result);
                    return;
                }
                const elapsed = Date.now() - start;
                if (n >= this._maxRetries || elapsed >= this._maxElapsedMs) {
                    resultCallback(result);
                    return;
                }
                const retryAfterMs = _retryAfterMs(result && result.error);
                const expBackoff   = Math.min(
                    this._maxBackoffMs,
                    this._initialBackoffMs * Math.pow(this._multiplier, n)
                );
                // Full jitter: pick uniformly in (0, expBackoff].
                const jittered = expBackoff * (Math.random() || 1);
                let delay      = retryAfterMs != null ? retryAfterMs : jittered;
                delay = Math.max(0, Math.min(delay, this._maxElapsedMs - elapsed));
                setTimeout(() => attempt(n + 1), delay);
            });
        };
        attempt(0);
    }

    shutdown() {
        return this._inner.shutdown ? this._inner.shutdown() : Promise.resolve();
    }
    forceFlush() {
        return this._inner.forceFlush ? this._inner.forceFlush() : Promise.resolve();
    }
    // Proxy selector methods so PeriodicExportingMetricReader reads the inner exporter's
    // temporality. Without them it defaults to CUMULATIVE, re-exporting histograms every tick.
    selectAggregationTemporality(instrumentType) {
        return this._inner.selectAggregationTemporality
            ? this._inner.selectAggregationTemporality(instrumentType)
            : undefined;
    }
    selectAggregation(instrumentType) {
        return this._inner.selectAggregation
            ? this._inner.selectAggregation(instrumentType)
            : undefined;
    }
}

// Best-effort Retry-After parsing. Returns null when no header is exposed.
function _retryAfterMs(err) {
    if (!err) return null;
    const ra = err.headers && (err.headers.get ? err.headers.get('Retry-After') : err.headers['Retry-After'] || err.headers['retry-after']);
    if (!ra) return null;
    const asInt = parseInt(ra, 10);
    if (!isNaN(asInt)) return Math.max(0, asInt) * 1000;
    const asDate = Date.parse(ra);
    if (!isNaN(asDate)) return Math.max(0, asDate - Date.now());
    return null;
}

function withRetry(exporter, signal) {
    if (!cfg.retry.enabled) return exporter;
    return new RetryingExporter(exporter, { ...cfg.retry, signal });
}

// The OTel JS browser platform ignores the `compression` option (Node-only). This
// fetch transport replaces the default XHR transport and gzips post-serialise.
const _RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
function _gzipFetchTransport(url, headers) {
    return {
        send: async function(data, timeoutMillis) {
            try {
                let body = data;
                const h = { ...headers };

                // During unload the event loop is stopping. Any await before fetch() drops
                // the request, so skip compression and call fetch() synchronously with keepalive.
                if (_isUnloading) {
                    try { fetch(url, { method: 'POST', headers: h, body, keepalive: true }); } catch (_) {}
                    return { status: 'success' };
                }

                if (typeof CompressionStream !== 'undefined') {
                    const cs = new CompressionStream('gzip');
                    const w = cs.writable.getWriter();
                    w.write(data);
                    w.close();
                    body = new Uint8Array(await new Response(cs.readable).arrayBuffer());
                    h['Content-Encoding'] = 'gzip';
                }
                const ctrl = new AbortController();
                const tid = setTimeout(() => ctrl.abort(), timeoutMillis);
                try {
                    const res = await fetch(url, { method: 'POST', headers: h, body, keepalive: true, signal: ctrl.signal });
                    clearTimeout(tid);
                    if (res.status >= 200 && res.status < 300) return { status: 'success' };
                    if (_RETRYABLE_STATUS.has(res.status)) {
                        const ra = res.headers.get('Retry-After');
                        return { status: 'retryable', retryInMillis: ra ? parseFloat(ra) * 1000 : 0 };
                    }
                    return { status: 'failure', error: new Error(`HTTP ${res.status}`) };
                } catch (e) {
                    clearTimeout(tid);
                    return { status: 'failure', error: e };
                }
            } catch (e) {
                return { status: 'failure', error: e };
            }
        },
        shutdown() {},
    };
}

// When cfg.compress is set, splices the gzip fetch transport over the default XHR one.
function _mkOtlpExporter(ExporterClass, url, signal, contentType, extraConfig = {}) {
    const headers = exportHeaders(signal);
    const exp = new ExporterClass({ url, headers, ...extraConfig });
    if (cfg.compress) {
        exp._delegate._transport = _gzipFetchTransport(url, { ...headers, 'Content-Type': contentType });
    }
    return exp;
}

// session.id: sessionStorage, with a 30-minute inactivity rollover.
// page_view.id: a fresh UUID per SDK init.
// Both are per-signal, not resource. Metrics omit both, since they are high cardinality.
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_KEY = 'observe_brum_session';
// Throttle sessionStorage writes to at most once per minute. Also flush on pagehide.
const SESSION_PERSIST_INTERVAL_MS = 60 * 1000;

let _sessionState = null;     // { id: string, last: number } in-memory cache
let _sessionPersistTs = 0;

function _readSessionState() {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        if (typeof obj.id !== 'string' || !obj.id) return null;
        if (typeof obj.last !== 'number' || !isFinite(obj.last)) return null;
        return { id: obj.id, last: obj.last };
    } catch (_) { return null; }
}

function _writeSessionState(state) {
    try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
    } catch (_) { /* private mode or quota exceeded, ignored */ }
}

function _currentSessionId() {
    const now = Date.now();
    if (!_sessionState) {
        _sessionState = _readSessionState();
    }
    if (!_sessionState || (now - _sessionState.last) > SESSION_TIMEOUT_MS) {
        _sessionState = { id: uuidv4(), last: now };
        _writeSessionState(_sessionState);
        _sessionPersistTs = now;
        return _sessionState.id;
    }
    // Throttle persistence to avoid storage churn.
    _sessionState.last = now;
    if (now - _sessionPersistTs > SESSION_PERSIST_INTERVAL_MS) {
        _writeSessionState(_sessionState);
        _sessionPersistTs = now;
    }
    return _sessionState.id;
}

// Persist activity ts on hide or unload so a quick reopen continues the session.
if (typeof window !== 'undefined') {
    const _flushSession = () => {
        if (_sessionState) _writeSessionState(_sessionState);
    };
    window.addEventListener('pagehide', _flushSession, { capture: true });
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') _flushSession();
        });
    }
}

let _pageViewId = uuidv4();

// Static entity attrs per OTel semconv. Per-signal attrs (session.id, url.*,
// client.address, network.connection.type) come from the identity processors.
const _resourceAttrs = {
    [ATTR_SERVICE_NAME]:                cfg.service_name,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: cfg.environment,
    [ATTR_TELEMETRY_DISTRO_NAME]:       BRUM_SDK_NAME,
    [ATTR_TELEMETRY_DISTRO_VERSION]:    BRUM_VERSION,
};
if (cfg.service_version) _resourceAttrs[ATTR_SERVICE_VERSION] = cfg.service_version;

// URL components are per-signal, not resource. Captured once, injected via _pageUrlAttrs.
const _pageUrlAttrs = {};
if (typeof window !== 'undefined' && window.location) {
    const _loc = window.location;
    if (_loc.href)     _pageUrlAttrs[ATTR_URL_FULL]   = scrubUrl(_loc.href);
    if (_loc.protocol) _pageUrlAttrs[ATTR_URL_SCHEME] = _loc.protocol.replace(':', '');
    if (_loc.hostname) _pageUrlAttrs[ATTR_URL_DOMAIN] = _loc.hostname;
    if (_loc.pathname) _pageUrlAttrs[ATTR_URL_PATH]   = _loc.pathname;
}

// browser.* and user_agent.original come from the native browserDetector below.

if (typeof screen !== 'undefined') {
    if (screen.width)  _resourceAttrs['screen.width']  = screen.width;
    if (screen.height) _resourceAttrs['screen.height'] = screen.height;
}

// process.runtime.*: OTel Process semconv. nodejs in Node, browser in the browser.
if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    _resourceAttrs[ATTR_PROCESS_RUNTIME_NAME]    = 'nodejs';
    _resourceAttrs[ATTR_PROCESS_RUNTIME_VERSION] = process.versions.node;
} else if (typeof navigator !== 'undefined' && navigator.userAgent) {
    _resourceAttrs[ATTR_PROCESS_RUNTIME_NAME]    = 'browser';
    _resourceAttrs[ATTR_PROCESS_RUNTIME_VERSION] = navigator.userAgent;
}

// Connection state, not entity. Can change mid-session. Identity processors inject it.
let _clientAddress         = null;
let _networkConnectionType = null;

function _setClientAddress(ip) {
    _clientAddress = ip || null;
}

// Maps Network Information API conn.type to OTel semconv values.
const _connTypeMap = { wifi: 'wifi', ethernet: 'wired', cellular: 'cell', none: 'unavailable', unknown: 'unknown' };

function _readConnectionInfo(conn) {
    if (!conn) return;
    if (typeof conn.type === 'string' && conn.type) {
        _networkConnectionType = _connTypeMap[conn.type] || conn.type;
    }
}

if (typeof navigator !== 'undefined') {
    const _conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (_conn) {
                _readConnectionInfo(_conn);
                try {
                    _conn.addEventListener('change', () => _readConnectionInfo(_conn));
                } catch (_) { /* ignore */ }
    }
}

function _injectPerSignalAttrs(target) {
    try {
        // A span with its own url.full (CLIENT or page_view) skips page url.*. Stamping it
        // makes _fetchHook derive server.address and the span name from the page host, not
        // the call target. Logs and load INTERNAL spans have no url.full, so they get it.
        const own = target.attributes;
        const hasOwnUrl = own && own[ATTR_URL_FULL] !== undefined && own[ATTR_URL_FULL] !== null;
        if (!hasOwnUrl) {
            for (const k in _pageUrlAttrs) {
                const v = _pageUrlAttrs[k];
                if (v !== undefined && v !== null) target.setAttribute(k, v);
            }
        }
        target.setAttribute(ATTR_SESSION_ID,   _currentSessionId());
        target.setAttribute('page_view.id', _pageViewId);
        if (_clientAddress)         target.setAttribute(ATTR_CLIENT_ADDRESS,         _clientAddress);
        if (_networkConnectionType) target.setAttribute(ATTR_NETWORK_CONNECTION_TYPE, _networkConnectionType);
    } catch (_) {}
}
// Cache-first: seeds from localStorage, then probes Cloudflare async. Fails silently.
const _IP_CACHE_KEY = 'observe_brum_client_ip_v2';

function _readIpCache(ttlMs) {
    if (ttlMs <= 0) return null;
    try {
        const raw = localStorage.getItem(_IP_CACHE_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        if (typeof obj.ts !== 'number' || (Date.now() - obj.ts) > ttlMs) return null;
        if (typeof obj.ip !== 'string' || !obj.ip) return null;
        return obj.ip;
    } catch (_) {
        return null;
    }
}

function _writeIpCache(ip) {
    try {
        localStorage.setItem(_IP_CACHE_KEY, JSON.stringify({
            ip: ip || null,
            ts: Date.now(),
        }));
    } catch (_) { /* quota, disabled storage, or private mode, ignored */ }
}

// Seed from cache so the first export carries the IP for a repeat visit.
if (cfg.client_ip.enabled) {
    const cached = _readIpCache(cfg.client_ip.cache_ttl_ms);
    if (cached) _setClientAddress(cached);
}

// OTel semconv version this SDK aligns to. Carried as the OTLP resource schema_url.
const OTEL_SCHEMA_URL = 'https://opentelemetry.io/schemas/1.43.0';

// Traces and logs resource: SDK defaults, browser.* detector, then static attrs (win conflicts).
const resource = defaultResource()
    .merge(detectResources({ detectors: [browserDetector] }))
    .merge(resourceFromAttributes(_resourceAttrs, { schemaUrl: OTEL_SCHEMA_URL }));

// Metrics resource strips high-cardinality attrs. Browser attrs stay on traces and logs.
const _METRICS_ATTR_DENYLIST = new Set([
    ATTR_PROCESS_RUNTIME_VERSION,
    'screen.width',        'screen.height',
]);
const _metricsResourceAttrs = Object.fromEntries(
    Object.entries(_resourceAttrs).filter(([k]) => !_METRICS_ATTR_DENYLIST.has(k))
);
// Observe groups RED metrics by resource_metrics_key_attributes. An absent key differs
// from a present-but-empty one, so these three always carry a value ('' when unset).
_metricsResourceAttrs[ATTR_SERVICE_NAME]                = _metricsResourceAttrs[ATTR_SERVICE_NAME] || '';
_metricsResourceAttrs[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] = _metricsResourceAttrs[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] || '';
_metricsResourceAttrs[ATTR_SERVICE_NAMESPACE]           = cfg.service_namespace || '';
const metricsResource = defaultResource()
    .merge(resourceFromAttributes(_metricsResourceAttrs, { schemaUrl: OTEL_SCHEMA_URL }));

function _parseCfTraceIp(text) {
    if (typeof text !== 'string') return null;
    const m = text.match(/^ip=(.+)$/m);
    return m ? m[1].trim() : null;
}

async function _refreshClientIPs() {
    const ipCfg = cfg.client_ip;
    if (!ipCfg.trace_url) return;
    if (typeof fetch !== 'function') return;
    let timer = null;
    let signal;
    try {
        if (typeof AbortController !== 'undefined') {
            const ctrl = new AbortController();
            timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, ipCfg.timeout_ms);
            signal = ctrl.signal;
        }
        const res = await fetch(ipCfg.trace_url, {
            method:         'GET',
            cache:          'no-store',
            credentials:    'omit',
            referrerPolicy: 'no-referrer',
            signal,
        });
        if (!res || !res.ok) return;
        const ip = _parseCfTraceIp(await res.text());
        if (!ip) return;
        // Later spans and logs carry the IP. Earlier ones miss it (the cache covers repeat visits).
        _setClientAddress(ip);
        _writeIpCache(ip);
    } catch (_) {
        /* fail open */
    } finally {
        if (timer) clearTimeout(timer);
    }
}

if (cfg.client_ip.enabled) {
    // Run inside page_view context so the probe parents under page_view. _pageViewCtx
    // is set before this setTimeout fires.
    setTimeout(() => context.with(_pageViewCtx || context.active(), _refreshClientIPs), 0);
}

// Reduces high-cardinality path segments in metric dimensions and span names.
// Heuristics run first, then the optional normalize_path function.
const _normRules = [
    [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id'],   // UUID
    [/\/\d{4,}(?=\/|$)/g,                                                 '/:id'],  // numeric ID
    [/\/[0-9a-f]{16,}(?=\/|$)/gi,                                       '/:hash'], // hex hash or ObjectID
];
function normalizePath(pathname) {
    if (!pathname) return '/';
    let p = cfg.auto_path_normalization
        ? _normRules.reduce((s, [rx, rep]) => s.replace(rx, rep), pathname)
        : pathname;
    if (cfg.normalize_path) { try { p = cfg.normalize_path(p); } catch (_) {} }
    return p;
}

function scrubUrl(url) {
    if (typeof url !== 'string' || !url) return url;
    if (!cfg.scrub_url_params.length) return url;
    try {
        const u = new URL(url, (typeof window !== 'undefined' && window.location) ? window.location.href : 'http://localhost/');
        let modified = false;
        for (const p of cfg.scrub_url_params) {
            if (u.searchParams.has(p)) {
                u.searchParams.set(p, '<redacted>');
                modified = true;
            }
        }
        return modified ? u.toString() : url;
    } catch (_) {
        return url;
    }
}

// Resolve a low-cardinality route template. Prefers cfg.resolve_route, falls back to
// normalisation. Spec: https://opentelemetry.io/docs/specs/semconv/http/http-spans/#name
function resolveRoute(url, path) {
    try {
        // Callers pass a parsed pathname to avoid a second parse. Absent = parse here with the page base.
        if (path == null) {
            path = new URL(
                url,
                (typeof window !== 'undefined' && window.location) ? window.location.href : 'http://localhost/'
            ).pathname;
        }
        if (cfg.resolve_route) {
            const t = cfg.resolve_route(url, path);
            if (t) return t;
        }
        return normalizePath(path);
    } catch (_) { return null; }
}

// CLIENT span name: "{method} {template}", or "{method}" with no template. Never the
// full URL. Takes the resolved template so resolveRoute runs once.
function clientSpanName(method, tmpl) {
    const m = (method || 'HTTP').toUpperCase();
    return tmpl ? `${m} ${tmpl}` : m;
}

// Publishes the page_view traceparent to <meta name="traceparent"> so document-load
// nests under it. Called at init and on every _reopenPageView.
function _publishTraceparentMeta() {
    if (cfg.trace_mode !== 'unified' || !_pageViewSpan || typeof document === 'undefined' || !document.head) return;
    const sc = _pageViewSpan.spanContext();
    if (!sc || !sc.traceId || sc.traceId === '00000000000000000000000000000000') return;
    const tp = `00-${sc.traceId}-${sc.spanId}-${(sc.traceFlags & 1) ? '01' : '00'}`;
    let meta = null;
    try { meta = document.querySelector('meta[name="traceparent"]'); } catch (_) {}
    if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'traceparent');
        document.head.appendChild(meta);
    }
    meta.setAttribute('content', tp);
}

// Injects per-signal attrs on every span or log. Not resource attrs: session.id
// rolls over and client.address describes the connection.
const _identitySpanProcessor = {
    onStart(span) { _injectPerSignalAttrs(span); },
    onEnd() {},
    forceFlush() { return Promise.resolve(); },
    shutdown()   { return Promise.resolve(); },
};

const _identityLogRecordProcessor = {
    onEmit(logRecord) { _injectPerSignalAttrs(logRecord); },
    forceFlush() { return Promise.resolve(); },
    shutdown()   { return Promise.resolve(); },
};

// Tracks open spans. On pagehide the SDK force-closes any still open before flush.
const _openSpans = new Set();
// Callback fired once when documentLoad ends (it ends last in the instrumentation).
let _onDocLoadEnd = null;
const _openSpanTracker = {
    onStart(span) { _openSpans.add(span); },
    onEnd(span)   {
        _openSpans.delete(span);
        // documentLoad closes after all children, so the load subtree is now complete.
        if (_onDocLoadEnd && span && span.name === 'documentLoad') {
            const cb = _onDocLoadEnd;
            _onDocLoadEnd = null;
            setTimeout(cb, 0); // defer: avoid re-entrancy inside a processor onEnd
        }
    },
    forceFlush()  { return Promise.resolve(); },
    shutdown()    { return Promise.resolve(); },
};

// Marker on spans kept for context and timing but not exported. Drops document-load
// resourceFetch spans for fetch or XHR URLs (they duplicate the network-instr span).
const _DROP_ATTR = 'brum.internal.drop';

// Wraps an exporting processor so _DROP_ATTR spans are not exported. onStart still
// forwards, keeping parent linkage.
const _dropFilterProcessor = (inner) => ({
    onStart(span, parentContext) { inner.onStart(span, parentContext); },
    onEnd(span) {
        if (span.attributes && span.attributes[_DROP_ATTR]) return;
        inner.onEnd(span);
    },
    forceFlush() { return inner.forceFlush(); },
    shutdown()   { return inner.shutdown(); },
});

// Declared before Traces: the span-metrics processor needs these instruments when
// WebTracerProvider is constructed.

// Agent-side RED metrics need both signals: spans to read, and metrics to emit.
const _agentMetricsOn = cfg.agent_metrics.enabled && cfg.metrics && cfg.traces;

// Connector-compatible metric names. Observe's Service Explorer queries these.
const RED_CALLS_METRIC    = 'traces.span.metrics.calls';
const RED_DURATION_METRIC = 'traces.span.metrics.duration';

// Dimensions on the .summary streams: the connector's implicit set plus
// observe.status_code. Drops otel.status_description and server.address (high card).
const _RED_SUMMARY_DIMS = ['span.name', 'span.kind', 'otel.status_code', 'observe.status_code'];

// Metric Views for the RED streams. Both full-stream views are explicit: the SDK uses
// the default aggregation only when no view matches, so registering only the .summary
// views suppresses the full streams. web.vitals.* has no view and keeps its default.
function _redViews() {
    const lim  = cfg.agent_metrics.cardinality_limit;
    const sum  = { type: AggregationType.SUM };
    // histogram.exponential.max_size: 100, matching Observe's collector config.
    const hist = { type: AggregationType.EXPONENTIAL_HISTOGRAM, options: { maxSize: 100, recordMinMax: true } };

    const views = [
        { instrumentName: RED_CALLS_METRIC,    aggregation: sum,  aggregationCardinalityLimit: lim },
        { instrumentName: RED_DURATION_METRIC, aggregation: hist, aggregationCardinalityLimit: lim },
    ];
    if (cfg.agent_metrics.summary_stream) {
        // One instrument, two streams. Extra view = extra storage, no extra recording.
        views.push(
            {
                instrumentName: RED_CALLS_METRIC, name: `${RED_CALLS_METRIC}.summary`,
                aggregation: sum, aggregationCardinalityLimit: lim,
                attributesProcessors: [createAllowListAttributesProcessor(_RED_SUMMARY_DIMS)],
            },
            {
                instrumentName: RED_DURATION_METRIC, name: `${RED_DURATION_METRIC}.summary`,
                aggregation: hist, aggregationCardinalityLimit: lim,
                attributesProcessors: [createAllowListAttributesProcessor(_RED_SUMMARY_DIMS)],
            },
        );
    }
    return views;
}

let _meterProvider = null;
if (cfg.metrics) {
    _meterProvider = new MeterProvider({
        resource: metricsResource,
        ...(_agentMetricsOn ? { views: _redViews() } : {}),
        readers: [
            new PeriodicExportingMetricReader({
                exporter: withRetry(_mkOtlpExporter(OTLPMetricExporter, METRICS_URL, 'metrics', 'application/json', { temporalityPreference: 0 /* DELTA */ }), 'metrics'),
                exportIntervalMillis: 30000,
            }),
        ],
    });
    metrics.setGlobalMeterProvider(_meterProvider);
}

// Metrics are DELTA and the reader interval is 30s, so every terminal path must flush.
function _flushMetrics() {
    try { if (_meterProvider) _meterProvider.forceFlush(); } catch (_) {}
}

// Browser equivalent of Observe's `spanmetrics` connector: read each span as it ends
// and derive traces.span.metrics.{calls,duration}. Read-only: values are computed in
// memory onto the metric point. Never calls setAttribute, updateName, or setStatus.

// SpanKind enum maps to the OTLP enum name the connector emits as span.kind.
const _SPAN_KIND_NAMES = {
    [SpanKind.INTERNAL]: 'SPAN_KIND_INTERNAL',
    [SpanKind.SERVER]:   'SPAN_KIND_SERVER',
    [SpanKind.CLIENT]:   'SPAN_KIND_CLIENT',
    [SpanKind.PRODUCER]: 'SPAN_KIND_PRODUCER',
    [SpanKind.CONSUMER]: 'SPAN_KIND_CONSUMER',
};

// transform/add_span_status_code: collapse status spellings into observe.status_code,
// first match wins. Only http.* occurs in a browser, but the full chain is honoured for
// app-set attrs. grpc/rpc/http.status_code have no stable constant, so they stay literal.
const _STATUS_CODE_KEYS = [
    ATTR_RPC_GRPC_STATUS_CODE,
    'grpc.status_code',
    'rpc.status_code',
    'http.status_code',
    ATTR_HTTP_RESPONSE_STATUS_CODE,
];

const _RED_STATUS_DESC_MAX = 128;

let _recordSpanMetrics = null;

if (_agentMetricsOn && _meterProvider) {
    // From _meterProvider directly, not the global getMeter(): the RED Views live on this
    // provider, so the instruments must belong to it even if another SDK claimed the global.
    const _meter = _meterProvider.getMeter(BRUM_SDK_NAME);
    const _calls = _meter.createCounter(RED_CALLS_METRIC, {
        description: 'Number of spans observed, by span name, kind and status.',
        valueType:   ValueType.INT,
    });
    const _durations = _meter.createHistogram(RED_DURATION_METRIC, {
        description: 'Duration of observed spans.',
        unit:        'ms',
    });

    const _kinds    = cfg.agent_metrics.span_kinds.map(k => `SPAN_KIND_${k}`);
    const _peerDims = cfg.agent_metrics.peer_dimensions;
    const _maxMs    = cfg.agent_metrics.max_span_duration_ms;

    // Sampled spans undercount, so weight each call by 1/rate. Histogram stays unweighted:
    // percentiles from a sample already hold.
    const _weight = (cfg.agent_metrics.scale_by_sample_rate && cfg.trace_sample_rate > 0)
        ? Math.max(1, Math.round(1 / cfg.trace_sample_rate))
        : 1;

    _recordSpanMetrics = (span) => {
        const attrs = span.attributes || {};

        // Skip drop-filtered spans (duplicate resourceFetch for fetch or XHR URLs).
        if (attrs[_DROP_ATTR]) return;

        // filter/drop_non_apm_spans, widened to CLIENT (see the config span_kinds note).
        const kind = _SPAN_KIND_NAMES[span.kind];
        if (!kind || _kinds.indexOf(kind) < 0) return;

        // filter/drop_long_spans: one stuck span wrecks the duration percentiles.
        const d = span.duration || [0, 0];
        const durationMs = d[0] * 1e3 + d[1] / 1e6;
        if (durationMs > _maxMs) return;

        const point = { 'span.name': span.name, 'span.kind': kind };

        // Post-transform shape: otel.status_code of OK or ERROR, omitted when unset. Writing
        // it directly matches the collector's transform, which maps status.code then deletes it.
        const status = span.status || {};
        if (status.code === SpanStatusCode.OK) {
            point['otel.status_code'] = 'OK';
        } else if (status.code === SpanStatusCode.ERROR) {
            point['otel.status_code'] = 'ERROR';
            // Copies the status message (transform/shape_spans_for_red_metrics). Truncated, error-only.
            if (status.message) {
                point['otel.status_description'] = String(status.message).slice(0, _RED_STATUS_DESC_MAX);
            }
        }

        for (let i = 0; i < _STATUS_CODE_KEYS.length; i++) {
            const v = attrs[_STATUS_CODE_KEYS[i]];
            if (v !== undefined && v !== null) {
                point['observe.status_code'] = v;
                break;
            }
        }

        // Callee host on outbound calls (groupbyattrs/peers). Draws the service-map edge.
        if (_peerDims && span.kind === SpanKind.CLIENT && attrs[ATTR_SERVER_ADDRESS]) {
            point[ATTR_SERVER_ADDRESS] = attrs[ATTR_SERVER_ADDRESS];
        }

        _calls.add(_weight, point);
        _durations.record(durationMs, point);
    };

    // Terminal flush for split and stock modes (no page_view block, no _flushSignals).
    // Unified flushes via _flushSignals after the span ends, so no listener here.
    if (cfg.trace_mode !== 'unified' && typeof window !== 'undefined') {
        window.addEventListener('pagehide', _flushMetrics, { capture: true });
    }
}

// Read-only span processor.
const _spanMetricsProcessor = {
    onStart() {},
    onEnd(span) { if (_recordSpanMetrics) _recordSpanMetrics(span); },
    forceFlush() { return Promise.resolve(); },
    shutdown()   { return Promise.resolve(); },
};

let _tracerProvider = null;
let _tracer         = null;
let _pageViewSpan   = null;
let _pageViewCtx    = null;
let _pageViewEnded  = false;
let _isUnloading    = false; // set on pagehide: skips async gzip so fetch fires before the event loop stops

if (cfg.traces) {
    // Identity and open-span tracker first, then batch export. _spanMetricsProcessor is
    // its own entry so it sees every span, exported or not.
    _tracerProvider = new WebTracerProvider({
        resource,
        sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(cfg.trace_sample_rate) }),
        spanProcessors: [
            _identitySpanProcessor,
            _openSpanTracker,
            _spanMetricsProcessor,
            _dropFilterProcessor(new BatchSpanProcessor(
                withRetry(_mkOtlpExporter(OTLPTraceExporter, TRACE_URL, 'traces', 'application/json'), 'traces'),
                { scheduledDelayMillis: 1000, maxExportBatchSize: 64, maxQueueSize: 2048, exportTimeoutMillis: 30000 }
            )),
        ],
    });
    _tracerProvider.register({ contextManager: new ZoneContextManager() });
    _tracer = trace.getTracer(cfg.service_name);
}

let _loggerProvider = null;
if (cfg.logs) {
    // Identity processor first so session.id and page_view.id land before the batch enqueues.
    _loggerProvider = new LoggerProvider({
        resource,
        processors: [
            _identityLogRecordProcessor,
            // sdk-logs (0.x) takes a single options object, so the exporter is a named field.
            new BatchLogRecordProcessor({
                exporter: withRetry(_mkOtlpExporter(OTLPLogExporter, LOGS_URL, 'logs', 'application/json'), 'logs'),
                // Default 5s delay makes a single console.log wait 5s. Lower to ~1s, keep a batch ceiling.
                scheduledDelayMillis: 1000,
                maxExportBatchSize:   64,
                maxQueueSize:         2048,
                exportTimeoutMillis:  30000,
            }),
        ],
    });
    logs.setGlobalLoggerProvider(_loggerProvider);
}

// SpanKind.SERVER root for every signal this page produces. Exposed via window.__ogm.
if (cfg.traces && cfg.trace_mode === 'unified') {
    // Span name "GET /path" ({method} {http.route}). Normalised path, raw in url.path and url.full.
    const _pvPath = normalizePath(
        (typeof window !== 'undefined' && window.location) ? window.location.pathname : '/'
    );
    // Document response status, when the browser exposes it. Navigation Timing
    // responseStatus covers the hard navigation (Chrome 109+, Firefox 129+, not Safari).
    // 0 means unsupported or restricted, treated as unknown.
    const _navEntry = (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function')
        ? performance.getEntriesByType('navigation')[0]
        : undefined;
    const _pvStatus = (_navEntry && _navEntry.responseStatus > 0) ? _navEntry.responseStatus : undefined;
    _pageViewSpan = _tracer.startSpan(`GET ${_pvPath}`, {
        kind: SpanKind.SERVER,
        // Anchor to navigation start so the root encloses backdated child spans.
        startTime: (typeof performance !== 'undefined' && performance.timeOrigin)
            ? performance.timeOrigin
            : Date.now() - ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0),
        attributes: {
            // Marker off the span name so page_view stays queryable ({method} {route}).
            'browser.span_type':      'page_view',
            [ATTR_HTTP_REQUEST_METHOD]: 'GET',
            [ATTR_HTTP_ROUTE]:          _pvPath,
            // undefined when unknown. setAttributes skips null-ish, so no fabricated status.
            [ATTR_HTTP_RESPONSE_STATUS_CODE]: _pvStatus,
            [ATTR_URL_PATH]:            (typeof window !== 'undefined' && window.location) ? window.location.pathname : '',
            [ATTR_URL_FULL]:            (typeof window !== 'undefined' && window.location) ? scrubUrl(window.location.href) : '',
            // page_view declares its own url.scheme and url.domain. The injector skips page url.*
            // on a span with url.full (see _injectPerSignalAttrs).
            [ATTR_URL_SCHEME]:          (typeof window !== 'undefined' && window.location && window.location.protocol) ? window.location.protocol.replace(':', '') : '',
            [ATTR_URL_DOMAIN]:          (typeof window !== 'undefined' && window.location) ? window.location.hostname : '',
        },
    });
    // SERVER span semconv: only 5xx is an error. 4xx is the caller's, so UNSET.
    if (_pvStatus >= 500) {
        _pageViewSpan.setStatus({ code: SpanStatusCode.ERROR });
    }
    _pageViewCtx = trace.setSpan(context.active(), _pageViewSpan);
    if (typeof window !== 'undefined') {
        // Flushes traces, logs, and metrics. Callers (_endPageView, pagehide) end their
        // spans first, so the RED data points exist before this DELTA flush runs.
        const _flushSignals = () => {
            try { if (_tracerProvider) _tracerProvider.forceFlush(); } catch (_) {}
            try { if (_loggerProvider) _loggerProvider.forceFlush(); } catch (_) {}
            _flushMetrics();
        };

        // page_view stays open until documentLoad closes (it ends last), so the root encloses
        // the full load subtree. A failsafe timer closes it if documentLoad never ends.
        const _PAGE_VIEW_FAILSAFE_MS = 30000;
        let _failsafeTimer = null;

        const _endPageView = () => {
            if (_pageViewEnded) return;
            _pageViewEnded = true;
            // Do not set _isUnloading here. This runs while the page is live, not on unload.
            if (_failsafeTimer) { clearTimeout(_failsafeTimer); _failsafeTimer = null; }
            try { _pageViewSpan.end(); } catch (_) {}
            _openSpans.forEach(s => { try { s.end(); } catch (_) {} });
            _openSpans.clear();
            _flushSignals();
        };

        // Failsafe backstop for every mode.
        _failsafeTimer = setTimeout(_endPageView, _PAGE_VIEW_FAILSAFE_MS);

        if (cfg.dom_elements) {
            // Close page_view when documentLoad ends (via _openSpanTracker.onEnd).
            _onDocLoadEnd = _endPageView;
        } else {
            // No documentLoad span in this mode. Close one macrotask after `load`.
            const _scheduleEndOnLoad = () => setTimeout(_endPageView, 0);
            if (document.readyState === 'complete') {
                _scheduleEndOnLoad();
            } else {
                window.addEventListener('load', _scheduleEndOnLoad, { once: true, capture: true });
            }
        }

        // pagehide = definitive unload. Always close open spans and flush, even if already ended.
        window.addEventListener('pagehide', () => {
            _isUnloading = true;
            if (_failsafeTimer) { clearTimeout(_failsafeTimer); _failsafeTimer = null; }
            if (!_pageViewEnded) {
                _pageViewEnded = true;
                try { _pageViewSpan.end(); } catch (_) {}
            }
            _openSpans.forEach(s => { try { s.end(); } catch (_) {} });
            _openSpans.clear();
            _flushSignals();
        }, { capture: true });

        // visibilitychange = tab switch or nav start. Flush, but do not end page_view. It fires
        // before pagehide, and ending here drops the final fetch span from that flush.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') _flushSignals();
        }, { capture: true });
        // bfcache restore: fresh page_view span so back/forward gets a new trace ID.
        window.addEventListener('pageshow', (event) => {
            if (event.persisted) _reopenPageView();
        }, { capture: true });

        // SPA route tracking: patch pushState and listen for popstate and hashchange, so each
        // soft-nav mints a fresh page_view span. replaceState is excluded (not a true nav).
        // Soft-navs emit no new resource spans, but fetch and XHR still parent under page_view.
        if (cfg.spa_routes && typeof history !== 'undefined') {
            const _onSpaNav = () => setTimeout(_reopenPageView, 0);
            const _origPushState = history.pushState.bind(history);
            history.pushState = function (...args) {
                const ret = _origPushState(...args);
                _onSpaNav();
                return ret;
            };
            window.addEventListener('popstate',   _onSpaNav, { capture: true });
            window.addEventListener('hashchange', _onSpaNav, { capture: true });
        }
    }
}

// Bridge for api.js: exposes page context, session and page_view IDs, and version.
if (typeof window !== 'undefined') {
    window.__ogm = {
        get withPageContext() { return _pageViewCtx ? (fn) => context.with(_pageViewCtx, fn) : (fn) => fn(); },
        endPageView: () => {
            try { if (_pageViewSpan) _pageViewSpan.end(); } catch (_) {}
        },
        get sessionId()  { return _currentSessionId(); },
        get pageViewId() { return _pageViewId; },
        get pageViewTraceId() {
            try { return _pageViewSpan ? _pageViewSpan.spanContext().traceId : undefined; }
            catch (_) { return undefined; }
        },
        version: BRUM_VERSION,
        // Internal handles for the test suite. Not part of the public API. The
        // integration tests load the compiled bundle and drive the real code
        // through these rather than re-implementing it. netIgnoreUrls is attached
        // later, once otlpIgnore is built.
        _internal: {
            dropFilterProcessor: _dropFilterProcessor,
            DROP_ATTR: _DROP_ATTR,
        },
    };
}

// Mints a fresh page_view span (new trace ID) on bfcache restore or SPA route change.
function _reopenPageView() {
    if (!cfg.traces || !_tracer) return;
    // End the previous span if still open (SPA nav). bfcache already closed it on pagehide.
    if (!_pageViewEnded && _pageViewSpan) {
        _pageViewEnded = true;
        try { _pageViewSpan.end(); } catch (_) {}
        _openSpans.forEach(s => { try { s.end(); } catch (_) {} });
        _openSpans.clear();
    }
    _isUnloading   = false; // reset: bfcache restore is a live page, not unloading
    // Restart LCP early-flush timer for this bfcache visit.
    if (_flushCwv && typeof window !== 'undefined') {
        clearTimeout(_cwvEarlyTimer);
        _cwvEarlyTimer = setTimeout(_flushCwv, 10000);
    }
    try { if (_tracerProvider) _tracerProvider.forceFlush(); } catch (_) {}
    try { if (_loggerProvider) _loggerProvider.forceFlush(); } catch (_) {}
    // Refresh URL per-signal attrs to current location.
    for (const k in _pageUrlAttrs) delete _pageUrlAttrs[k];
    if (typeof window !== 'undefined' && window.location) {
        const loc = window.location;
        if (loc.href)     _pageUrlAttrs[ATTR_URL_FULL]   = scrubUrl(loc.href);
        if (loc.protocol) _pageUrlAttrs[ATTR_URL_SCHEME] = loc.protocol.replace(':', '');
        if (loc.hostname) _pageUrlAttrs[ATTR_URL_DOMAIN] = loc.hostname;
        if (loc.pathname) _pageUrlAttrs[ATTR_URL_PATH]   = loc.pathname;
    }
    _pageViewId = uuidv4();
    const _pvPath = normalizePath(
        (typeof window !== 'undefined' && window.location) ? window.location.pathname : '/'
    );
    _pageViewSpan = _tracer.startSpan(`GET ${_pvPath}`, {
        kind: SpanKind.SERVER,
        startTime: Date.now(),
        attributes: {
            // Marker kept off the span name (see the unified init block).
            'browser.span_type':      'page_view',
            [ATTR_HTTP_REQUEST_METHOD]: 'GET',
            [ATTR_HTTP_ROUTE]:          _pvPath,
            [ATTR_URL_PATH]:            (typeof window !== 'undefined' && window.location) ? window.location.pathname : '',
            [ATTR_URL_FULL]:            (typeof window !== 'undefined' && window.location) ? scrubUrl(window.location.href) : '',
            // Declares its own url.scheme and url.domain (see the unified init block).
            [ATTR_URL_SCHEME]:          (typeof window !== 'undefined' && window.location && window.location.protocol) ? window.location.protocol.replace(':', '') : '',
            [ATTR_URL_DOMAIN]:          (typeof window !== 'undefined' && window.location) ? window.location.hostname : '',
        },
    });
    _pageViewCtx  = trace.setSpan(context.active(), _pageViewSpan);
    _pageViewEnded = false;
    // Refresh traceparent meta for the new trace (document-load does not re-run here).
    _publishTraceparentMeta();
}

// Per trace_mode:
//   unified: stock document-load and user-interaction, registered inside _pageViewCtx,
//            so their spans nest under page_view. fetch and XHR also parent there.
//   split: enable everything stock. fetch and XHR are separate root traces.
//   stock: enable everything stock, with no page_view.
const otlpIgnore = [/\/v1\/(traces|metrics|logs)/];
// Exclude BRUM's own client-IP probe from instrumentation (internal traffic, not an app call).
if (cfg.client_ip && cfg.client_ip.enabled && cfg.client_ip.trace_url) {
    try {
        otlpIgnore.push(new RegExp(cfg.client_ip.trace_url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } catch (_) { /* invalid URL, skipped: the probe just stays instrumented */ }
}

// Expose the real ignore list to the test suite (see the _internal note above).
if (typeof window !== 'undefined' && window.__ogm && window.__ogm._internal) {
    window.__ogm._internal.netIgnoreUrls = otlpIgnore;
}

const _useStockDocLoad = cfg.dom_elements;
const _useStockUI      = cfg.user_interactions;

const _fetchHook = (span /*, request, response */) => {
    // fetch and XHR instrumentation still populates its base attrs under legacy keys
    // (http.url and http.method). Read them as input and emit stable semconv keys.
    const attrs  = span.attributes || {};
    const url    = attrs[ATTR_URL_FULL] || attrs['http.url'];
    const method = attrs[ATTR_HTTP_REQUEST_METHOD] || attrs['http.method'];
    if (typeof url === 'string') {
        const scrubbed = scrubUrl(url);
        if (scrubbed !== url) {
            if ('http.url' in attrs) span.setAttribute('http.url', scrubbed);
            span.setAttribute(ATTR_URL_FULL, scrubbed);
        }
        let parsedPath = null;
        try {
            const u = new URL(url);
            parsedPath = u.pathname;
            span.setAttribute(ATTR_SERVER_ADDRESS, u.hostname);
            if (u.port) span.setAttribute(ATTR_SERVER_PORT, parseInt(u.port, 10));
        } catch (_) {}

        // Rename off the OTel default (a full URL means high cardinality) to {method} {target}.
        // https://opentelemetry.io/docs/specs/semconv/http/http-spans/#name
        // Reuse the pathname parsed just above. resolveRoute re-parses with the
        // page base only when that parse threw (a relative fetch URL).
        const tmpl = resolveRoute(url, parsedPath);
        span.updateName(clientSpanName(method, tmpl));
        if (tmpl) span.setAttribute(ATTR_URL_TEMPLATE, tmpl);
        if (method) span.setAttribute(ATTR_HTTP_REQUEST_METHOD, method);
    }
};

// Per-request timing events (DNS, TCP, TLS) bloat span payloads, and page_view plus CWV
// metrics already cover timing, so suppress them across all network instrumentations.
const _ignoreNetworkEvents = true;

// Shared config for the fetch and XHR instrumentations (identical settings).
const _netInstrOptions = {
    enabled: cfg.network_requests,
    ignoreUrls: otlpIgnore,
    ignoreNetworkEvents: _ignoreNetworkEvents,
    applyCustomAttributesOnSpan: _fetchHook,
};

if (cfg.traces) {
    const _registerInstr = () => registerInstrumentations({
        instrumentations: [
            getWebAutoInstrumentations({
                '@opentelemetry/instrumentation-document-load': {
                    ignoreNetworkEvents: _ignoreNetworkEvents,
                    // Separate flag from ignoreNetworkEvents: suppresses the paint events
                    // (firstPaint and firstContentfulPaint) added to the documentLoad span.
                    ignorePerformancePaintEvents: _ignoreNetworkEvents,
                    enabled: _useStockDocLoad,
                    applyCustomAttributesOnSpan: {
                        resourceFetch: (span, resource) => {
                            // document-load emits a resourceFetch span per resource timing
                            // entry, including fetch and XHR calls that already have their own
                            // span. Flag those duplicates for drop. Keep true static resources.
                            const it = resource && resource.initiatorType;
                            if (it === 'fetch' || it === 'xmlhttprequest') {
                                span.setAttribute(_DROP_ATTR, true);
                                return;
                            }
                            try {
                                const u = new URL(resource.name);
                                span.setAttribute(ATTR_SERVER_ADDRESS, u.hostname);
                                if (u.port) span.setAttribute(ATTR_SERVER_PORT, parseInt(u.port, 10));
                            } catch (_) {}
                        },
                    },
                },
                '@opentelemetry/instrumentation-user-interaction': { enabled: _useStockUI },
                '@opentelemetry/instrumentation-fetch': { ..._netInstrOptions },
                '@opentelemetry/instrumentation-xml-http-request': { ..._netInstrOptions },
            }),
        ],
    });

    // document-load parents its subtree only off <meta name="traceparent"> (it ignores the
    // active context). Publish page_view's context there so the load subtree nests under it.
    // Must run before the instrumentation's _collectPerformance reads the meta.
    _publishTraceparentMeta();

    // Register within page_view context (unified), so user-interaction spans (which use
    // the active context) can nest under page_view. Otherwise, register at root.
    if (cfg.trace_mode === 'unified' && _pageViewCtx) {
        context.with(_pageViewCtx, _registerInstr);
    } else {
        _registerInstr();
    }

    // App-handler fetch calls fire in the ROOT zone (no active span). Wrap window.fetch so
    // they fall back to _pageViewCtx and parent under page_view. No _pageViewEnded check:
    // OTel accepts children of ended spans. No getActiveSpan() check: it false-negatives
    // during the load burst, when resource instrumentation holds an active span.
    if (cfg.network_requests && typeof window !== 'undefined' && window.fetch) {
        const _instrFetch = window.fetch.bind(window);
        window.fetch = function(...args) {
            if (_pageViewCtx) {
                return context.with(_pageViewCtx, () => _instrFetch(...args));
            }
            return _instrFetch(...args);
        };
    }

    // Symmetric to the window.fetch wrap: app-triggered XHR open() runs in the ROOT zone,
    // so wrap it to run within _pageViewCtx and parent under page_view.
    if (cfg.network_requests && typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype && XMLHttpRequest.prototype.open) {
        const _instrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (...args) {
            if (_pageViewCtx) {
                return context.with(_pageViewCtx, () => _instrOpen.apply(this, args));
            }
            return _instrOpen.apply(this, args);
        };
    }
}

let _flushCwv       = null;  // lifted to module scope so _reopenPageView can restart the LCP timer
let _cwvEarlyTimer  = null;

if (cfg.cwv_metrics && cfg.metrics) {
    const meter = metrics.getMeter(BRUM_SDK_NAME);

    const lcp  = meter.createHistogram('web.vitals.lcp',  { unit: 'ms' });
    const inp  = meter.createHistogram('web.vitals.inp',  { unit: 'ms' });
    const fcp  = meter.createHistogram('web.vitals.fcp',  { unit: 'ms' });
    const ttfb = meter.createHistogram('web.vitals.ttfb', { unit: 'ms' });
    const cls  = meter.createHistogram('web.vitals.cls',  { unit: '1' });

    // Buffer latest value per metric. _flushCwv records and clears each entry, so no
    // value is sent twice across flush paths.
    const _cwv = {};

    const _cwvPage = () => (typeof window !== 'undefined' && window.location)
        ? normalizePath(window.location.pathname) : '';

    _flushCwv = () => {
        const page = _cwvPage();
        for (const key in _cwv) {
            const e = _cwv[key];
            e.histogram.record(e.value, {
                page,
                rating:          e.rating,
                navigation_type: e.navigationType || 'navigate',
            });
            delete _cwv[key];
        }
        _flushMetrics();
    };

    const buffer = (histogram, key) => (metric) => {
        _cwv[key] = { histogram, value: metric.value, rating: metric.rating,
                      navigationType: metric.navigationType };
    };

    // FCP and TTFB fire once and are final. Buffer them onto the shared flush path (10s
    // timer or pagehide). Key-based overwrite in buffer() dedups repeat fires (bfcache).
    onFCP( buffer(fcp,  'fcp'));
    onTTFB(buffer(ttfb, 'ttfb'));

    // LCP: reportAllChanges:true so each candidate buffers at once. Without it web-vitals
    // fires only on interaction or page hide, so the 10s early-flush finds it empty on idle
    // sessions. Key-based overwrite keeps the latest (largest) candidate.
    onLCP(buffer(lcp, 'lcp'), { reportAllChanges: true });

    // INP and CLS: reportAllChanges:true so the buffer tracks each new worst value. Without
    // it both fire only via onHidden, so a page that never hides before close (Selenium,
    // quick exit) records nothing. Key-based overwrite keeps the running-worst value.
    onINP(buffer(inp, 'inp'), { reportAllChanges: true });
    onCLS(buffer(cls, 'cls'), { reportAllChanges: true });

    if (typeof window !== 'undefined') {
        // 10-second timer: catches FCP, TTFB, LCP, and any early INP and CLS updates.
        _cwvEarlyTimer = setTimeout(_flushCwv, 10000);
        window.addEventListener('pagehide', () => {
            clearTimeout(_cwvEarlyTimer);
            _flushCwv();
        }, { capture: true });
    }
}

// Resolve best context for log-trace correlation: active span (for example, a fetch
// or XHR child), then page_view span, then SDK default.
function _logCtx() {
    if (trace.getActiveSpan()) return context.active();
    return _pageViewCtx || context.active();
}

// error_mode controls destination: 'logs' (default), 'span', or 'dual'.
if (cfg.errors && typeof window !== 'undefined') {
    const _sendLogs = cfg.error_mode !== 'span';
    const _sendSpan = cfg.error_mode !== 'logs';
    const _logger   = (cfg.logs && _sendLogs) ? logs.getLogger('observe-brum') : null;

    const recordError = (err, source) => {
        const message = (err && err.message) || String(err) || 'unknown error';
        const stack   = (err && err.stack)   || '';
        const name    = (err && err.name)    || 'Error';

        if (_logger) {
            _logger.emit({
                context:        _logCtx(),
                severityNumber: SeverityNumber.ERROR,
                severityText:   'ERROR',
                body:           message,
                attributes: {
        [ATTR_EXCEPTION_TYPE]:       name,
        [ATTR_EXCEPTION_MESSAGE]:    message,
        [ATTR_EXCEPTION_STACKTRACE]: stack,
                    'error.source':         source,
                    'page.pathname':        window.location.pathname,
                },
            });
        }
        if (_sendSpan && _pageViewSpan && err instanceof Error) {
            try { _pageViewSpan.recordException(err); } catch (_) { /* ignore */ }
        }
        // Mark span ERROR regardless of error_mode (status is independent of the span event).
        if (_pageViewSpan && err instanceof Error) {
            try { _pageViewSpan.setStatus({ code: SpanStatusCode.ERROR, message }); } catch (_) { /* ignore */ }
        }
    };

    window.addEventListener('error', (event) => {
        recordError(event.error || new Error(event.message || 'window.error'), 'window.error');
    });
    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        const err = reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : JSON.stringify(reason));
        recordError(err, 'unhandledrejection');
    });
}

if (cfg.console_banner && typeof console !== 'undefined' && console.log) {
    const _art = [
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠠⠀⠐⢀⠈⢀⠈⠀⠄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠀⠂⢀⠀⠀⠁⠀⠀⠀⠀⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠠⠀⠄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠂⠀⠀⠀⠀⠀⠀⢀⣠⣴⣶⣶⣷⣶⣦⣤⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠷⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣾⣿⣿⣿⣿⣿⣿⣿⡏⠛⣿⣧⠀⠘⣆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⣿⣿⣧⡀⠘⣿⣧⣤⣿⠄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢺⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣿⣿⣿⣿⣿⠅⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⣿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣤⣴⣶⣶⡈⢿⣟⣿⣿⣿⣿⣿⣿⣿⣿⣿⣻⠟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣴⣿⣿⣿⣿⣿⣿⣽⢦⡉⠻⠾⣿⣽⣿⣽⡯⠷⠛⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣯⡷⣶⢤⣤⣤⣤⡴⣶⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣰⣿⡿⠿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣷⣷⣿⣿⣿⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⣰⡿⢃⣴⣶⣆⢹⣿⣿⣿⣿⣿⣿⣿⣿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⢼⣿⣿⡿⢐⣿⣿⣿⣿⣿⡿⠉⠠⢀⢀⠈⢉⠙⠛⠻⠻⠿⠿⢿⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⢨⣿⣧⡘⠿⠟⢡⣾⣿⣿⡁⢀⣿⠁⠌⢌⠐⠄⠨⠀⠐⠀⠂⠀⠄⢀⠀⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠐⣿⣽⣿⣶⣿⣿⣿⣿⠡⡍⢹⠃⠠⢱⡋⢳⠌⣹⠁⢚⡖⡈⢀⠐⠀⠀⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⢻⣯⣿⣿⣿⣿⣿⣿⣶⣴⣿⠀⠁⠈⠓⠋⠢⢧⠠⣸⡂⢹⣴⠋⠀⡸⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢿⣽⣿⣿⣿⣿⣿⣿⣿⣿⣄⠀⢁⠐⠀⢁⠀⠠⠀⠁⠼⠁⡀⣠⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢿⣾⣻⣿⣿⣿⣿⣿⣿⣿⣷⣤⣀⡈⠀⠀⠂⠈⠀⢂⣠⡴⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠿⣞⣯⣿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢾⣾⣻⡯⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠛⠾⢿⣳⣿⡽⣯⡿⣯⡿⣷⣻⠿⠓⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
        '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠈⠉⠉⠉⠉⠉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
    ];
    const _overrides = [];
    if (cfg.environment !== 'production')     _overrides.push('env:          ' + cfg.environment);
    if (cfg.service_version)                  _overrides.push('svc_version:  ' + cfg.service_version);
    if (!cfg.traces)                          _overrides.push('traces:       off');
    if (!cfg.metrics)                         _overrides.push('metrics:      off');
    if (!cfg.logs)                            _overrides.push('logs:         off');
    if (!cfg.cwv_metrics)                     _overrides.push('cwv_metrics:  off');
    if (!cfg.errors)                          _overrides.push('errors:       off');
    if (cfg.error_mode !== 'logs')            _overrides.push('error_mode:   ' + cfg.error_mode);
    if (!cfg.console_capture)                 _overrides.push('con_capture:  off');
    if (!cfg.network_requests)                _overrides.push('net_requests: off');
    if (cfg.user_interactions)                _overrides.push('user_interact: on');
    if (!cfg.dom_elements)                    _overrides.push('dom_elements: off');
    if (!cfg.auto_path_normalization)         _overrides.push('auto_norm:    off');
    if (cfg.normalize_path)                   _overrides.push('normalize_path:fn');
    if (cfg.trace_sample_rate !== 1.0)        _overrides.push('sample_rate:  ' + cfg.trace_sample_rate);
    if (!cfg.compress)                        _overrides.push('compress:     off');
    if (!cfg.retry.enabled)                   _overrides.push('retry:        off');
    else if (cfg.retry.max_retries !== 5)     _overrides.push('retry.retries:' + cfg.retry.max_retries);
    if (cfg.client_ip.enabled)               _overrides.push('client_ip:    on');
    if (cfg.agent_metrics.enabled)            _overrides.push('agent_metrics:on');
    if (cfg.spa_routes)                       _overrides.push('spa_routes:    on');
    if (cfg.scrub_url_params.join(',') !== _DEFAULT_SCRUB_PARAMS.join(','))
                                              _overrides.push('scrub_params: custom');

    const _info = [
        (_isDev ? 'Codename Bruno  v' : 'Observe BRUM  v') + BRUM_VERSION,
        '',
        'service:      ' + cfg.service_name,
        'endpoint:     ' + (baseUrl || '<same-origin>'),
        'auth:         ' + (_decodedToken ? 'Bearer (configured)' : 'none'),
        'trace_mode:   ' + cfg.trace_mode,
        'L Package     ' + (cfg.observe_target.logs    || '<none>'),
        'T Package     ' + (cfg.observe_target.traces  || '<none>'),
        'M Package     ' + (cfg.observe_target.metrics || '<none>'),
        '',
        'session.id    ' + _currentSessionId(),
        'page_view.id  ' + _pageViewId,
        ...(_overrides.length ? ['', '── overrides', ..._overrides] : []),
    ];
    const _infoStart = 3;
    const _artCols   = _isDev ? 32 : 40;
    const banner = ['', ..._art.map((line, i) => {
        const idx = i - _infoStart;
        const trimmed = line.replace(/⠀+$/, ''); // strip trailing braille blanks
        const padded  = trimmed.padEnd(_artCols);
        return idx >= 0 && idx < _info.length ? padded + '  ' + _info[idx] : padded;
    }), ''].join('\n');
    try {
        console.log('%c' + banner, 'color:#5e72e4;font-family:monospace;font-size:11px;line-height:1.2');
    } catch (_) {
        try { console.log(banner); } catch (__) {}
    }
}

// Taps console.{debug,log,info,warn,error} and routes each call by error_mode, the
// same destination switch the error capture uses: 'logs' emits an OTel log record,
// 'span' adds a span event, 'dual' does both. Re-entry guard prevents loops.
// Installed after banner.
const _consoleToLogs = cfg.error_mode !== 'span';   // 'logs' or 'dual'
const _consoleToSpan = cfg.error_mode !== 'logs';   // 'span' or 'dual'
if (cfg.console_capture && typeof console !== 'undefined' &&
    ((_consoleToLogs && cfg.logs) || (_consoleToSpan && cfg.traces))) {
    const _consoleLogger = (_consoleToLogs && cfg.logs) ? logs.getLogger('observe-brum-console') : null;

    const _severityFor = {
        debug: SeverityNumber.DEBUG,
        log:   SeverityNumber.INFO,
        info:  SeverityNumber.INFO,
        warn:  SeverityNumber.WARN,
        error: SeverityNumber.ERROR,
    };

    const _formatArg = (a) => {
        if (a === null || a === undefined) return String(a);
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
        try { return JSON.stringify(a); } catch (_) { return String(a); }
    };

    let _inEmit = false;
    Object.keys(_severityFor).forEach((method) => {
        const original = console[method];
        if (typeof original !== 'function') return;
        console[method] = function (...args) {
            try { original.apply(console, args); } catch (_) { /* ignore */ }
            if (_inEmit) return;
            _inEmit = true;
            try {
                const body = args.map(_formatArg).join(' ');
                const pathname = (typeof window !== 'undefined' && window.location) ? window.location.pathname : '';
                if (_consoleLogger) {
                    _consoleLogger.emit({
                        context:        _logCtx(),
                        severityNumber: _severityFor[method],
                        severityText:   method.toUpperCase(),
                        body,
                        attributes: {
                            'console.method': method,
                            'page.pathname':  pathname,
                            // session.id and page_view.id injected by _identityLogRecordProcessor.
                        },
                    });
                }
                if (_consoleToSpan) {
                    // Attach to the active span, else the page_view span, the same
                    // context _logCtx() picks for the log record above.
                    const target = trace.getActiveSpan() || _pageViewSpan;
                    if (target) {
                        target.addEvent('console', {
                            [ATTR_LOG_RECORD_ORIGINAL]: body,
                            'console.method':           method,
                            'page.pathname':            pathname,
                        });
                    }
                }
            } catch (_) { /* ignore */ } finally {
                _inEmit = false;
            }
        };
    });
}
