// Package functional runs observe-brum's dist bundle in a real (headless)
// browser and validates the OTLP JSON it emits, end to end, against a mock
// collector. Run via docker-compose (see docker-compose.functional-test.yml)
// or locally with `go test ./...` given Go + a reachable Chrome instance.
package functional

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/chromedp/chromedp"

	"observe-brum/functional/browser"
	"observe-brum/functional/collector"
)

const defaultListenPort = "8089"

func TestFunctionalTelemetry(t *testing.T) {
	repoRoot := repoRootDir(t)
	distDir := filepath.Join(repoRoot, "dist")
	fixtureDir := filepath.Join(repoRoot, "tests", "functional", "fixtures")

	collector.MustExist(filepath.Join(distDir, "observe-brum.js"), "run `npm run build` before functional tests")

	store := collector.NewStore()
	srv := collector.NewServer(store, fixtureDir, distDir)
	srv.Debug = os.Getenv("DEBUG_DUMP") != ""

	listenAddr := envOr("LISTEN_ADDR", ":"+defaultListenPort)
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		t.Fatalf("listen %s: %v", listenAddr, err)
	}
	defer ln.Close()
	go func() { _ = http.Serve(ln, srv.Handler()) }()

	collectorURL := envOr("COLLECTOR_URL", "http://localhost:"+defaultListenPort)
	fixtureURL := collectorURL + "/fixture.html"

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	allocCtx, allocCancel, err := newAllocator(ctx)
	if err != nil {
		t.Fatalf("browser allocator: %v", err)
	}
	defer allocCancel()

	browserCtx, browserCancel := chromedp.NewContext(allocCtx, chromedp.WithErrorf(logFilteringUnmarshalNoise))
	defer browserCancel()

	err = browser.RunFixture(browserCtx, fixtureURL, browser.NavigateOptions{
		Actions: []chromedp.Action{
			chromedp.Click("#click-target", chromedp.ByID),
			chromedp.Evaluate(`window.__test.logSomething()`, nil),
			chromedp.Evaluate(`window.__test.fetchSomething()`, nil),
			chromedp.Evaluate(`window.__test.throwError()`, nil),
			chromedp.Sleep(300 * time.Millisecond),
		},
	})
	if err != nil {
		t.Fatalf("run fixture page: %v", err)
	}

	traceCount, metricCount, logCount := store.Counts()
	t.Logf("received export batches: traces:%d metrics:%d logs:%d", traceCount, metricCount, logCount)

	t.Run("traces", func(t *testing.T) { assertTraces(t, store) })
	t.Run("metrics", func(t *testing.T) { assertMetrics(t, store) })
	t.Run("logs", func(t *testing.T) { assertLogs(t, store) })
	t.Run("cross_signal_correlation", func(t *testing.T) { assertCorrelation(t, store) })
	t.Run("agent_metrics_leaves_spans_alone", func(t *testing.T) { assertSpansUnchangedByAgentMetrics(t, store) })
}

func assertTraces(t *testing.T, store *collector.Store) {
	spans := store.Spans()
	if len(spans) == 0 {
		t.Fatal("expected at least one span, got none")
	}

	var root *collector.Span
	for i := range spans {
		if spans[i].Attrs["browser.span_type"] == "page_view" {
			root = &spans[i]
			break
		}
	}
	if root == nil {
		t.Fatal("expected a root span with browser.span_type \"page_view\", not found")
	}

	// W3C trace ID and span ID integrity: 32 hex characters for a trace ID,
	// 16 hex characters for a span ID, never all-zero (the OTel "invalid" sentinel).
	for _, sp := range spans {
		if len(sp.TraceID) != 32 {
			t.Errorf("span %q: traceId wrong length: %q (%d chars)", sp.Name, sp.TraceID, len(sp.TraceID))
		}
		if len(sp.SpanID) != 16 {
			t.Errorf("span %q: spanId wrong length: %q (%d chars)", sp.Name, sp.SpanID, len(sp.SpanID))
		}
		if isAllZero(sp.TraceID) {
			t.Errorf("span %q: traceId is all-zero", sp.Name)
		}
		if isAllZero(sp.SpanID) {
			t.Errorf("span %q: spanId is all-zero", sp.Name)
		}
		if sp.EndNanos < sp.StartNanos {
			t.Errorf("span %q: endTime (%d) before startTime (%d)", sp.Name, sp.EndNanos, sp.StartNanos)
		}
		if sp.TraceID != root.TraceID {
			t.Errorf("span %q: traceId %q does not match page_view trace %q: unified trace_mode must parent everything under one trace", sp.Name, sp.TraceID, root.TraceID)
		}
	}

	// Resource attributes per OTel semconv are set once, and must be present on every batch.
	assertResourceAttrs(t, root.ResourceAttrs)

	// The fixture page loads over a real HTTP response, so page_view must carry
	// its actual status via Navigation Timing's responseStatus, per OTel HTTP
	// semconv, not a hardcoded value. A plain 200 load must also leave the span
	// status UNSET (0): only a 5xx marks a SERVER span as an error.
	statusCode, ok := root.Attrs["http.response.status_code"].(int64)
	if !ok {
		t.Error("page_view: missing http.response.status_code attribute")
	} else if statusCode != 200 {
		t.Errorf("page_view: http.response.status_code = %d, want 200", statusCode)
	}
	if root.StatusCode != 0 {
		t.Errorf("page_view: span status code = %d, want 0 (UNSET) for a 200 response", root.StatusCode)
	}

	// At least one CLIENT span is expected, from window.__test.fetchSomething().
	foundFetch := false
	for _, sp := range spans {
		if sp.Kind == 3 { // SpanKind.CLIENT
			foundFetch = true
		}
	}
	if !foundFetch {
		t.Error("expected at least one CLIENT-kind span from instrumented fetch(), found none")
	}
}

func assertMetrics(t *testing.T, store *collector.Store) {
	points := store.MetricPoints()
	if len(points) == 0 {
		t.Fatal("expected at least one metric data point, got none")
	}

	knownWebVitals := map[string]string{
		"web.vitals.lcp":  "ms",
		"web.vitals.inp":  "ms",
		"web.vitals.cls":  "1",
		"web.vitals.fcp":  "ms",
		"web.vitals.ttfb": "ms",
	}

	seenAny := false
	for _, p := range points {
		unit, known := knownWebVitals[p.MetricName]
		if !known {
			continue
		}
		seenAny = true
		if p.Unit != unit {
			t.Errorf("metric %q: unit = %q, want %q", p.MetricName, p.Unit, unit)
		}
		if p.InstrumentType != "histogram" {
			t.Errorf("metric %q: instrument type = %q, want histogram", p.MetricName, p.InstrumentType)
		}
		if p.Count <= 0 {
			t.Errorf("metric %q: count = %d, want > 0", p.MetricName, p.Count)
		}
		// Required dimensions per src/brum.js CWV recording.
		for _, dim := range []string{"page", "rating", "navigation_type"} {
			if _, ok := p.Attrs[dim]; !ok {
				t.Errorf("metric %q: missing dimension %q", p.MetricName, dim)
			}
		}
	}
	// TTFB and FCP fire from PerformanceObserver early and reliably in headless
	// Chrome. LCP, CLS, and INP finalize on hidden and are timing-sensitive, so this
	// check does not hard-require every web.vitals.* name. It requires only that
	// CWV reporting is wired up and produces at least one well-formed data point.
	if !seenAny {
		t.Error("expected at least one web.vitals.* metric, found none")
	}

	assertAgentRedMetrics(t, points)
}

// assertAgentRedMetrics checks the agent-side RED metrics the fixture enables via
// agent_metrics. These mirror Observe's `spanmetrics` connector output, which the
// Service Explorer queries when APM.flagREDMetricsGeneratedByAgent is true.
func assertAgentRedMetrics(t *testing.T, points []collector.MetricPoint) {
	wantTypes := map[string]string{
		"traces.span.metrics.calls":            "sum",
		"traces.span.metrics.duration":         "exponentialHistogram",
		"traces.span.metrics.calls.summary":    "sum",
		"traces.span.metrics.duration.summary": "exponentialHistogram",
	}

	seen := map[string]bool{}
	kinds := map[string]bool{}

	for _, p := range points {
		wantType, known := wantTypes[p.MetricName]
		if !known {
			continue
		}
		seen[p.MetricName] = true

		if p.InstrumentType != wantType {
			t.Errorf("metric %q: instrument type = %q, want %q", p.MetricName, p.InstrumentType, wantType)
		}
		if strings.HasPrefix(p.MetricName, "traces.span.metrics.duration") && p.Unit != "ms" {
			t.Errorf("metric %q: unit = %q, want ms", p.MetricName, p.Unit)
		}

		// Implicit connector dimensions. service.name lives on the resource, per
		// resource_metrics_key_attributes, so it must not be a data point attribute.
		for _, dim := range []string{"span.name", "span.kind"} {
			if _, ok := p.Attrs[dim]; !ok {
				t.Errorf("metric %q: missing dimension %q", p.MetricName, dim)
			}
		}
		if _, ok := p.Attrs["service.name"]; ok {
			t.Errorf("metric %q: service.name must stay on the resource, not the data point", p.MetricName)
		}
		if p.ResourceAttrs["service.name"] != "functional-test-app" {
			t.Errorf("metric %q: resource service.name = %v, want functional-test-app", p.MetricName, p.ResourceAttrs["service.name"])
		}
		// The fixture does not set service_namespace, so the key must still be
		// present on the resource, with an empty string rather than missing.
		if v, ok := p.ResourceAttrs["service.namespace"]; !ok || v != "" {
			t.Errorf("metric %q: resource service.namespace = %v (present=%v), want \"\" (present=true)", p.MetricName, v, ok)
		}

		// status.code is the pre-transform spelling. Observe wants otel.status_code.
		if _, ok := p.Attrs["status.code"]; ok {
			t.Errorf("metric %q: unexpected status.code dimension, want otel.status_code", p.MetricName)
		}

		// The summary streams drop the two high-cardinality dimensions.
		if strings.HasSuffix(p.MetricName, ".summary") {
			for _, dim := range []string{"otel.status_description", "server.address"} {
				if _, ok := p.Attrs[dim]; ok {
					t.Errorf("summary metric %q: unexpected dimension %q", p.MetricName, dim)
				}
			}
		}

		if kind, ok := p.Attrs["span.kind"].(string); ok {
			kinds[kind] = true
			// INTERNAL spans (documentLoad, resourceFetch, user_interaction) are not
			// requests, so counting them makes the rate meaningless.
			if kind == "SPAN_KIND_INTERNAL" {
				t.Errorf("metric %q: INTERNAL spans must not be metered", p.MetricName)
			}
		}
	}

	for name := range wantTypes {
		if !seen[name] {
			t.Errorf("expected agent RED metric %q, found none", name)
		}
	}

	// page_view is the SERVER root. The fixture's fetch() produces the CLIENT span.
	if !kinds["SPAN_KIND_SERVER"] {
		t.Error("expected a SPAN_KIND_SERVER RED metric data point (page_view), found none")
	}
	if !kinds["SPAN_KIND_CLIENT"] {
		t.Error("expected a SPAN_KIND_CLIENT RED metric data point (fetch), found none")
	}

	// The full stream must carry the peer dimension that draws the service-map edge.
	foundPeer := false
	for _, p := range points {
		if p.MetricName != "traces.span.metrics.calls" {
			continue
		}
		if kind, _ := p.Attrs["span.kind"].(string); kind != "SPAN_KIND_CLIENT" {
			continue
		}
		if _, ok := p.Attrs["server.address"]; ok {
			foundPeer = true
		}
	}
	if !foundPeer {
		t.Error("expected server.address on a CLIENT RED metric data point, found none")
	}
}

// assertSpansUnchangedByAgentMetrics proves the span-metrics processor is read-only:
// the dimensions it derives must never be written back onto a span.
func assertSpansUnchangedByAgentMetrics(t *testing.T, store *collector.Store) {
	derived := []string{"span.name", "span.kind", "otel.status_code", "otel.status_description", "observe.status_code"}
	spans := store.Spans()
	if len(spans) == 0 {
		t.Fatal("expected at least one span, got none")
	}
	for _, s := range spans {
		for _, key := range derived {
			if _, ok := s.Attrs[key]; ok {
				t.Errorf("span %q: agent_metrics must not mutate spans, found derived attribute %q", s.Name, key)
			}
		}
	}
}

func assertLogs(t *testing.T, store *collector.Store) {
	records := store.LogRecords()
	if len(records) == 0 {
		t.Fatal("expected at least one log record, got none")
	}

	foundConsole, foundError := false, false
	for _, r := range records {
		if strings.Contains(r.Body, "functional-test console log") {
			foundConsole = true
			if r.SeverityText != "LOG" && r.SeverityText != "INFO" {
				t.Errorf("console log record: severityText = %q, want LOG/INFO", r.SeverityText)
			}
		}
		if strings.Contains(r.Body, "functional-test thrown error") {
			foundError = true
		}
		if len(r.TraceID) != 32 || isAllZero(r.TraceID) {
			t.Errorf("log record %q: invalid traceId %q: must correlate to active page_view span", r.Body, r.TraceID)
		}
	}
	if !foundConsole {
		t.Error("expected console.log capture to produce a log record, found none")
	}
	if !foundError {
		t.Error("expected thrown error to produce a log record (error_mode=logs default), found none")
	}

	assertResourceAttrs(t, records[0].ResourceAttrs)
}

// assertCorrelation checks that logs carry trace IDs and span IDs belonging to a
// trace actually seen in the traces export. This is the whole point of RUM
// distributed tracing being useful for debugging.
func assertCorrelation(t *testing.T, store *collector.Store) {
	spanTraceIDs := map[string]bool{}
	for _, sp := range store.Spans() {
		spanTraceIDs[sp.TraceID] = true
	}
	if len(spanTraceIDs) == 0 {
		t.Skip("no spans captured, skipping correlation check")
	}

	correlated := 0
	for _, r := range store.LogRecords() {
		if spanTraceIDs[r.TraceID] {
			correlated++
		}
	}
	if correlated == 0 {
		t.Error("expected at least one log record whose traceId matches a captured span's traceId")
	}
}

func assertResourceAttrs(t *testing.T, attrs map[string]interface{}) {
	t.Helper()
	want := map[string]interface{}{
		"service.name":                  "functional-test-app",
		"deployment.environment.name":   "test",
		"service.version":               "0.0.0-functional",
	}
	for k, v := range want {
		if got := attrs[k]; got != v {
			t.Errorf("resource attr %q = %v, want %v", k, got, v)
		}
	}
	for _, k := range []string{"telemetry.distro.name", "telemetry.distro.version", "telemetry.sdk.name"} {
		if _, ok := attrs[k]; !ok {
			t.Errorf("resource attr %q missing", k)
		}
	}
}

func isAllZero(hex string) bool {
	for _, c := range hex {
		if c != '0' {
			return false
		}
	}
	return len(hex) > 0
}

func newAllocator(ctx context.Context) (context.Context, context.CancelFunc, error) {
	if chromeURL := os.Getenv("CHROME_URL"); chromeURL != "" {
		return browser.RemoteAllocator(ctx, chromeURL)
	}
	// No remote Chrome configured. Fall back to a local Chrome/Chromium
	// found on PATH, for running `go test` directly on a dev machine.
	allocCtx, cancel := chromedp.NewExecAllocator(ctx, chromedp.DefaultExecAllocatorOptions[:]...)
	return allocCtx, cancel, nil
}

// logFilteringUnmarshalNoise drops cdproto's "could not unmarshal event"
// warnings for CDP Network.* events it does not fully model (for example, a
// cookiePartitionKey field shape mismatch). These are harmless and unrelated
// to the OTLP JSON this suite actually asserts on. All other errors pass through.
func logFilteringUnmarshalNoise(format string, args ...interface{}) {
	if strings.Contains(format, "could not unmarshal event") {
		return
	}
	log.Printf(format, args...)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// repoRootDir walks up from the test's working directory (tests/functional)
// to the observe-brum package root, identified by package.json.
func repoRootDir(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for i := 0; i < 6; i++ {
		if _, err := os.Stat(filepath.Join(dir, "package.json")); err == nil {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("could not locate observe-brum package root (package.json not found)")
	return ""
}
