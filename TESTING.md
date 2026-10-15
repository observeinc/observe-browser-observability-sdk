# Testing Observe BRUM

Two test layers: Jest unit tests (fast, CI-friendly) and Go functional tests (real headless browser against a mock OTLP collector).

## Quick Start

```bash
# Non-functional (Jest) tests
./test.sh
npm test

# Non-functional tests with coverage
./test.sh --coverage
npm run test:coverage

# Watch mode
./test.sh --watch
npm run test:watch

# Functional tests (requires Docker)
./test.sh --functional

# Both suites
./test.sh --all
```

## Test Structure

```
observe-brum/
├── tests/
│   ├── non-functional/
│   │   ├── setup.js                    # Jest setup (browser mocks)
│   │   ├── brum.test.js                # Unit tests (config, API)
│   │   └── bundle-integration.test.js  # Integration tests (compiled bundle)
│   └── functional/
│       ├── collector/                  # Mock OTLP/HTTP JSON collector
│       ├── browser/                    # chromedp driver + remote Chrome discovery
│       ├── fixtures/fixture.html       # Page loaded by the functional test
│       ├── integration_test.go         # Assertions on captured spans/metrics/logs
│       └── docker-compose.yml          # Chrome + gotest containers
├── test.sh                             # Test runner script (Jest + functional)
└── jest.config.js                      # Jest configuration
```

## CI/CD Integration

GitHub Actions workflow included at `.github/workflows/test.yml`:

```yaml
- name: Run tests
  run: npm run test:coverage
```

Coverage is reported as text output (no HTML reports) suitable for CI logs.

## Coverage

Coverage collection is opt-in via `--coverage` flag:

```bash
npm run test:coverage
```

Output format: text summary only (no HTML/lcov reports). Coverage files are gitignored and not committed.

## JavaScript Unit Tests (Jest)

**Location**: `tests/non-functional/brum.test.js`  
**Framework**: Jest with jsdom  
**Purpose**: Test runtime behaviour and API

#### What's Tested

**Configuration**
- `window.OBSERVE_BRUM` can be set
- All config options are accepted
- `observe_target` works as string or object
- Custom `normalize_path` functions work
- Retry configuration is accepted

**Runtime API**
- `window.__ogm` is available
- `withPageContext()` executes functions
- `withPageContext()` returns values correctly
- `withPageContext()` handles async functions
- `endPageView()` can be called

**Script Loading**
- Script tags can be created dynamically
- Scripts can be appended to DOM

#### Running Unit Tests

```bash
# Run once
npm run test:unit

# Watch mode (auto-rerun on changes)
npm run test:watch

# With coverage
./test.sh --coverage
# Opens: coverage/index.html
```

#### Example Test

```javascript
test('withPageContext executes function', () => {
  window.__ogm = {
    withPageContext: (fn) => fn(),
    endPageView: () => {},
    sessionId: 'session-123',
    pageViewId: 'pageview-456',
    version: '0.0.5',
  };

  const result = window.__ogm.withPageContext(() => 42);
  expect(result).toBe(42);
});
```

## Functional Tests (Go + headless Chrome)

**Location**: `tests/functional/`
**Purpose**: Verify the *actual OTLP wire output* of the built bundle - not just the SDK's JS API surface. Loads `dist/observe-brum.js` in a real headless Chrome, exercises console capture, fetch instrumentation, and an unhandled error, then asserts on the OTLP JSON received by a mock collector.

#### What's Tested

- **Traces**: root `page_view` span present, valid W3C trace/span IDs (correct length, never all-zero), consistent parent trace across spans, a CLIENT-kind span from instrumented `fetch()`
- **Metrics**: Core Web Vitals histograms (`web.vitals.*`) with correct unit and dimensions (`page`, `rating`, `navigation_type`)
- **Logs**: console capture and unhandled-error capture, both with correct severity and a valid `traceId`
- **Cross-signal correlation**: at least one log record's `traceId` matches a captured span's `traceId`
- **Resource attributes**: `service.name`, `deployment.environment.name`, `service.version`, `telemetry.distro.*`, `telemetry.sdk.name` present per OTel semconv

#### Architecture

```
┌─────────────┐   OTLP JSON POST   ┌──────────────────┐
│  headless   │ ─────────────────► │  mock collector  │
│  Chrome     │  /v1/traces        │  (Go httptest-    │
│  (fixture   │  /v1/metrics       │   style server)   │
│  page +     │  /v1/logs          │                   │
│  brum.js)   │ ◄───────────────── │  serves fixture   │
└─────────────┘   HTML + bundle    └──────────────────┘
```

Chrome and the Go test runner are separate containers (`tests/functional/docker-compose.yml`) connected via chromedp over the DevTools protocol. The Go process runs both the mock collector *and* the test assertions, and also serves the fixture page + built bundle so `endpoint: ''` resolves to same-origin.

#### Running Functional Tests

```bash
./test.sh --functional
```

Or directly:

```bash
npm run build   # dist/observe-brum.js must exist first
docker compose -f tests/functional/docker-compose.yml up --abort-on-container-exit --exit-code-from gotest
```

Runs automatically in CI via `.github/workflows/functional-test.yml`.

#### Local Go run (no Docker)

If Go and a local Chrome/Chromium are installed, `CHROME_URL` can be omitted - the suite falls back to launching Chrome directly on PATH:

```bash
cd tests/functional
go test ./... -v
```

## Test Coverage

Run with coverage report:

```bash
./test.sh --coverage
```

Coverage report generated in `coverage/`:
- `coverage/index.html` - Full HTML report
- `coverage/lcov.info` - LCOV format for CI
- Terminal summary displayed

Current coverage focuses on:
- Configuration handling
- API surface
- Script loading mechanics

## CI Integration

### GitHub Actions Example

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm install
      
      - name: Run tests
        run: ./test.sh
      
      - name: Upload coverage
        if: success()
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info
```

## Adding New Tests

### Adding Unit Tests

1. Open `tests/non-functional/brum.test.js`
2. Add new `describe()` or `test()` blocks
3. Follow existing patterns
4. Run: `npm run test:unit`

```javascript
describe('New Feature', () => {
  test('should do something', () => {
    // Arrange
    window.OBSERVE_BRUM = { ... };
    
    // Act
    const result = someFunction();
    
    // Assert
    expect(result).toBe(expected);
  });
});
```

### Adding Functional Tests

1. Open `tests/functional/integration_test.go`
2. Add `Actions` to the `browser.RunFixture` call in `TestFunctionalTelemetry`, or add fixture globals in `tests/functional/fixtures/fixture.html`
3. Add assertions using `store.Spans()` / `store.MetricPoints()` / `store.LogRecords()`
4. Run: `docker compose -f tests/functional/docker-compose.yml up --abort-on-container-exit --exit-code-from gotest`

```go
t.Run("my_new_check", func(t *testing.T) {
    spans := store.Spans()
    // assert against captured OTLP JSON
})
```

## Dependencies

- **jest** (^29.7.0) - Test framework
- **jest-environment-jsdom** (^29.7.0) - Browser environment for tests
- **@jest/globals** (^29.7.0) - Jest globals
- **esbuild** (^0.21.0) - Build tool
- **Go** (1.22+) and **Docker** - Functional test suite only

## Troubleshooting

### Debugging a failing functional test assertion

Set `DEBUG_DUMP=1` to have the mock collector log the full input (request headers + pretty-printed OTLP JSON body) and output (response status + body) for every `/v1/traces`, `/v1/metrics`, and `/v1/logs` export:

```bash
DEBUG_DUMP=1 docker compose -f tests/functional/docker-compose.yml up --abort-on-container-exit --exit-code-from gotest
```

Example input:

```
=== OTLP DEBUG [traces] input ===
method: POST /v1/traces
headers: map[authorization: content-encoding: content-type:application/json x-observe-target-package:]
body:
{
  "resourceSpans": [
    {
      "resource": { "attributes": [ { "key": "service.name", "value": { "stringValue": "functional-test-app" } }, ... ] },
      "scopeSpans": [ { "spans": [ ... ] } ]
    }
  ]
}
=== OTLP DEBUG [traces] output ===
status: 200
body: {}
```

Off by default - noisy for routine CI runs, only needed when an assertion fails and the raw wire format needs inspecting.

### Tests fail with "Cannot find module"

```bash
# Install dependencies
npm install
```

### Coverage report not generated

```bash
# Ensure coverage directory exists
mkdir -p coverage

# Run with coverage flag
./test.sh --coverage
```

### Watch mode doesn't detect changes

```bash
# Try clearing Jest cache
npx jest --clearCache

# Then run watch again
npm run test:watch
```

## Test Output

### Success

```
→ Observe BRUM Test Suite

→ Running JavaScript Unit Tests
  Framework: Jest
  Environment: jsdom

PASS tests/non-functional/brum.test.js
  ✓ 13 tests passed

✓ Unit tests passed

═══════════════════════════════════════
  ✓ All tests passed!
═══════════════════════════════════════
```

### Failure

```
→ Running JavaScript Unit Tests

FAIL tests/non-functional/brum.test.js
  ● BRUM API › withPageContext executes function
    expect(received).toBe(expected)
    
    Expected: true
    Received: false

✗ Unit tests failed

═══════════════════════════════════════
  ✗ Some tests failed
═══════════════════════════════════════
```