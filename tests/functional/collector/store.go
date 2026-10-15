// Package collector implements a minimal in-memory OTLP/HTTP JSON collector
// used to capture and inspect telemetry emitted by the BRUM bundle during
// functional tests. It does not validate against the full OTLP protobuf
// schema. It decodes the JSON encoding that OTLPTraceExporter, OTLPMetricExporter,
// and OTLPLogExporter actually send (application/json), and exposes flattened,
// easy-to-assert-on views of spans, metric data points, and log records.
package collector

import (
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
)

// RawPayload is a decoded OTLP JSON export body (resourceSpans, resourceMetrics, or resourceLogs).
type RawPayload = map[string]interface{}

// Span is a flattened view of a single OTLP span plus its resource attributes.
type Span struct {
	TraceID       string
	SpanID        string
	ParentSpanID  string
	Name          string
	Kind          int
	StartNanos    int64
	EndNanos      int64
	Attrs         map[string]interface{}
	ResourceAttrs map[string]interface{}
	StatusCode    int
}

// MetricPoint is a flattened view of a single OTLP metric data point.
type MetricPoint struct {
	MetricName    string
	Unit          string
	InstrumentType string // "histogram" | "exponentialHistogram" | "sum" | "gauge"
	Attrs         map[string]interface{}
	ResourceAttrs map[string]interface{}
	Count         int64
	Sum           float64
	Value         float64
}

// LogRecord is a flattened view of a single OTLP log record.
type LogRecord struct {
	Body           string
	SeverityText   string
	SeverityNumber int
	TraceID        string
	SpanID         string
	Attrs          map[string]interface{}
	ResourceAttrs  map[string]interface{}
	TimeNanos      int64
}

// Store accumulates decoded OTLP export payloads received on /v1/{traces,metrics,logs}.
type Store struct {
	mu      sync.Mutex
	traces  []RawPayload
	metrics []RawPayload
	logs    []RawPayload
	// Headers captures request headers seen on each signal's most recent export,
	// keyed by signal ("traces"|"metrics"|"logs"). Used to assert on
	// bearer_token and x-observe-target-package routing.
	Headers map[string]map[string]string
}

func NewStore() *Store {
	return &Store{Headers: make(map[string]map[string]string)}
}

func (s *Store) AddTraces(p RawPayload, headers map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.traces = append(s.traces, p)
	s.Headers["traces"] = headers
}

func (s *Store) AddMetrics(p RawPayload, headers map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metrics = append(s.metrics, p)
	s.Headers["metrics"] = headers
}

func (s *Store) AddLogs(p RawPayload, headers map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logs = append(s.logs, p)
	s.Headers["logs"] = headers
}

func (s *Store) Counts() (traces, metrics, logs int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.traces), len(s.metrics), len(s.logs)
}

// ---- attribute decoding ----

func attrValue(v map[string]interface{}) interface{} {
	if sv, ok := v["stringValue"]; ok {
		return sv
	}
	if iv, ok := v["intValue"]; ok {
		switch t := iv.(type) {
		case string:
			n, _ := strconv.ParseInt(t, 10, 64)
			return n
		case float64:
			return int64(t)
		}
	}
	if dv, ok := v["doubleValue"]; ok {
		return dv
	}
	if bv, ok := v["boolValue"]; ok {
		return bv
	}
	if av, ok := v["arrayValue"]; ok {
		return av
	}
	return nil
}

func decodeAttrs(raw interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	list, ok := raw.([]interface{})
	if !ok {
		return out
	}
	for _, item := range list {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		key, _ := m["key"].(string)
		valMap, _ := m["value"].(map[string]interface{})
		if key == "" || valMap == nil {
			continue
		}
		out[key] = attrValue(valMap)
	}
	return out
}

func parseNanos(v interface{}) int64 {
	switch t := v.(type) {
	case string:
		n, _ := strconv.ParseInt(t, 10, 64)
		return n
	case float64:
		return int64(t)
	}
	return 0
}

// ---- flattening ----

// Spans returns every span across all received /v1/traces export payloads.
func (s *Store) Spans() []Span {
	s.mu.Lock()
	payloads := append([]RawPayload{}, s.traces...)
	s.mu.Unlock()

	var out []Span
	for _, p := range payloads {
		resourceSpans, _ := p["resourceSpans"].([]interface{})
		for _, rsRaw := range resourceSpans {
			rs, _ := rsRaw.(map[string]interface{})
			resource, _ := rs["resource"].(map[string]interface{})
			resAttrs := decodeAttrs(resource["attributes"])

			scopeSpans, _ := rs["scopeSpans"].([]interface{})
			for _, ssRaw := range scopeSpans {
				ss, _ := ssRaw.(map[string]interface{})
				spans, _ := ss["spans"].([]interface{})
				for _, spRaw := range spans {
					sp, _ := spRaw.(map[string]interface{})
					name, _ := sp["name"].(string)
					traceID, _ := sp["traceId"].(string)
					spanID, _ := sp["spanId"].(string)
					parentSpanID, _ := sp["parentSpanId"].(string)
					kind := 0
					if k, ok := sp["kind"].(float64); ok {
						kind = int(k)
					}
					statusCode := 0
					if st, ok := sp["status"].(map[string]interface{}); ok {
						if c, ok := st["code"].(float64); ok {
							statusCode = int(c)
						}
					}
					out = append(out, Span{
						TraceID:       traceID,
						SpanID:        spanID,
						ParentSpanID:  parentSpanID,
						Name:          name,
						Kind:          kind,
						StartNanos:    parseNanos(sp["startTimeUnixNano"]),
						EndNanos:      parseNanos(sp["endTimeUnixNano"]),
						Attrs:         decodeAttrs(sp["attributes"]),
						ResourceAttrs: resAttrs,
						StatusCode:    statusCode,
					})
				}
			}
		}
	}
	return out
}

// MetricPoints returns every data point across all received /v1/metrics export payloads.
func (s *Store) MetricPoints() []MetricPoint {
	s.mu.Lock()
	payloads := append([]RawPayload{}, s.metrics...)
	s.mu.Unlock()

	var out []MetricPoint
	for _, p := range payloads {
		resourceMetrics, _ := p["resourceMetrics"].([]interface{})
		for _, rmRaw := range resourceMetrics {
			rm, _ := rmRaw.(map[string]interface{})
			resource, _ := rm["resource"].(map[string]interface{})
			resAttrs := decodeAttrs(resource["attributes"])

			scopeMetrics, _ := rm["scopeMetrics"].([]interface{})
			for _, smRaw := range scopeMetrics {
				sm, _ := smRaw.(map[string]interface{})
				metricList, _ := sm["metrics"].([]interface{})
				for _, mRaw := range metricList {
					m, _ := mRaw.(map[string]interface{})
					name, _ := m["name"].(string)
					unit, _ := m["unit"].(string)

					if hist, ok := m["histogram"].(map[string]interface{}); ok {
						out = appendHistogramPoints(out, hist, name, unit, "histogram", resAttrs)
					}
					// The agent RED duration metric uses an exponential histogram, per
					// Observe's spanmetrics config (histogram.exponential.max_size: 100).
					if hist, ok := m["exponentialHistogram"].(map[string]interface{}); ok {
						out = appendHistogramPoints(out, hist, name, unit, "exponentialHistogram", resAttrs)
					}
					if sum, ok := m["sum"].(map[string]interface{}); ok {
						dps, _ := sum["dataPoints"].([]interface{})
						for _, dpRaw := range dps {
							dp, _ := dpRaw.(map[string]interface{})
							val := asFloat(dp["asDouble"])
							if val == 0 {
								val = asFloat(dp["asInt"])
							}
							out = append(out, MetricPoint{
								MetricName: name, Unit: unit, InstrumentType: "sum",
								Attrs: decodeAttrs(dp["attributes"]), ResourceAttrs: resAttrs,
								Value: val,
							})
						}
					}
					if gauge, ok := m["gauge"].(map[string]interface{}); ok {
						dps, _ := gauge["dataPoints"].([]interface{})
						for _, dpRaw := range dps {
							dp, _ := dpRaw.(map[string]interface{})
							val := asFloat(dp["asDouble"])
							if val == 0 {
								val = asFloat(dp["asInt"])
							}
							out = append(out, MetricPoint{
								MetricName: name, Unit: unit, InstrumentType: "gauge",
								Attrs: decodeAttrs(dp["attributes"]), ResourceAttrs: resAttrs,
								Value: val,
							})
						}
					}
				}
			}
		}
	}
	return out
}

// appendHistogramPoints flattens the data points of a histogram or exponential
// histogram metric into out. Both OTLP shapes carry the same count and sum fields,
// so the same parsing serves both.
func appendHistogramPoints(out []MetricPoint, hist map[string]interface{}, name, unit, instrumentType string, resAttrs map[string]interface{}) []MetricPoint {
	dps, _ := hist["dataPoints"].([]interface{})
	for _, dpRaw := range dps {
		dp, _ := dpRaw.(map[string]interface{})
		count := int64(0)
		switch c := dp["count"].(type) {
		case string:
			count, _ = strconv.ParseInt(c, 10, 64)
		case float64:
			count = int64(c)
		}
		sum, _ := dp["sum"].(float64)
		out = append(out, MetricPoint{
			MetricName: name, Unit: unit, InstrumentType: instrumentType,
			Attrs: decodeAttrs(dp["attributes"]), ResourceAttrs: resAttrs,
			Count: count, Sum: sum,
		})
	}
	return out
}

func asFloat(v interface{}) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		f, _ := strconv.ParseFloat(t, 64)
		return f
	}
	return 0
}

// LogRecords returns every log record across all received /v1/logs export payloads.
func (s *Store) LogRecords() []LogRecord {
	s.mu.Lock()
	payloads := append([]RawPayload{}, s.logs...)
	s.mu.Unlock()

	var out []LogRecord
	for _, p := range payloads {
		resourceLogs, _ := p["resourceLogs"].([]interface{})
		for _, rlRaw := range resourceLogs {
			rl, _ := rlRaw.(map[string]interface{})
			resource, _ := rl["resource"].(map[string]interface{})
			resAttrs := decodeAttrs(resource["attributes"])

			scopeLogs, _ := rl["scopeLogs"].([]interface{})
			for _, slRaw := range scopeLogs {
				sl, _ := slRaw.(map[string]interface{})
				records, _ := sl["logRecords"].([]interface{})
				for _, lrRaw := range records {
					lr, _ := lrRaw.(map[string]interface{})
					body := ""
					if b, ok := lr["body"].(map[string]interface{}); ok {
						if sv, ok := b["stringValue"].(string); ok {
							body = sv
						}
					}
					severityText, _ := lr["severityText"].(string)
					severityNumber := 0
					if sn, ok := lr["severityNumber"].(float64); ok {
						severityNumber = int(sn)
					}
					traceID, _ := lr["traceId"].(string)
					spanID, _ := lr["spanId"].(string)
					out = append(out, LogRecord{
						Body:           body,
						SeverityText:   severityText,
						SeverityNumber: severityNumber,
						TraceID:        traceID,
						SpanID:         spanID,
						Attrs:          decodeAttrs(lr["attributes"]),
						ResourceAttrs:  resAttrs,
						TimeNanos:      parseNanos(lr["timeUnixNano"]),
					})
				}
			}
		}
	}
	return out
}

// DecodePayload is a small helper for handlers to turn a request body into a RawPayload.
func DecodePayload(body []byte) (RawPayload, error) {
	var p RawPayload
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, fmt.Errorf("decode OTLP JSON payload: %w", err)
	}
	return p, nil
}
