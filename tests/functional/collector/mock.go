package collector

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

// Server is a mock OTLP/HTTP collector. It also serves the functional test
// fixture page and the built observe-brum.js bundle so the browser under
// test can load everything from a single same-origin base URL, matching
// how brum.js resolves `endpoint: ''` to `window.location.origin`.
type Server struct {
	Store      *Store
	FixtureDir string // dir containing fixture.html
	DistDir    string // dir containing observe-brum.js
	// Debug logs the full request headers and pretty-printed OTLP JSON body
	// (input) and the response sent back (output) for every export call.
	// Enable via the DEBUG_DUMP env var. See integration_test.go.
	Debug bool
}

func NewServer(store *Store, fixtureDir, distDir string) *Server {
	return &Server{Store: store, FixtureDir: fixtureDir, DistDir: distDir}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/v1/traces", s.exportHandler("traces", s.Store.AddTraces))
	mux.HandleFunc("/v1/metrics", s.exportHandler("metrics", s.Store.AddMetrics))
	mux.HandleFunc("/v1/logs", s.exportHandler("logs", s.Store.AddLogs))

	mux.HandleFunc("/fixture.html", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(s.FixtureDir, "fixture.html"))
	})
	mux.HandleFunc("/observe-brum.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		http.ServeFile(w, r, filepath.Join(s.DistDir, "observe-brum.js"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/fixture.html", http.StatusFound)
			return
		}
		http.NotFound(w, r)
	})

	return mux
}

func (s *Server) exportHandler(signal string, add func(RawPayload, map[string]string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		defer r.Body.Close()

		payload, err := DecodePayload(body)
		if err != nil {
			log.Printf("mock collector: %v", err)
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		headers := map[string]string{
			"content-type":             r.Header.Get("Content-Type"),
			"content-encoding":         r.Header.Get("Content-Encoding"),
			"authorization":            r.Header.Get("Authorization"),
			"x-observe-target-package": r.Header.Get("X-Observe-Target-Package"),
		}
		add(payload, headers)

		respBody := []byte(`{}`)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(respBody)

		if s.Debug {
			s.dumpExchange(signal, r, headers, payload, http.StatusOK, respBody)
		}
	}
}

// dumpExchange logs the full OTLP JSON input (request headers and body) and
// output (response status and body) for one export call. Intended for
// debugging a failing assertion, not for routine CI output.
func (s *Server) dumpExchange(signal string, r *http.Request, headers map[string]string, payload RawPayload, status int, respBody []byte) {
	pretty, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		pretty = []byte(fmt.Sprintf("<failed to pretty-print: %v>", err))
	}
	log.Printf(
		"\n=== OTLP DEBUG [%s] input ===\nmethod: %s %s\nheaders: %+v\nbody:\n%s\n=== OTLP DEBUG [%s] output ===\nstatus: %d\nbody: %s\n",
		signal, r.Method, r.URL.Path, headers, pretty,
		signal, status, respBody,
	)
}

// MustExist panics with a helpful message if a required path is missing.
// This is used at test startup so a missing `npm run build` fails fast and clearly.
func MustExist(path, hint string) {
	if _, err := os.Stat(path); err != nil {
		log.Fatalf("functional test setup: %s not found (%s): %v", path, hint, err)
	}
}
