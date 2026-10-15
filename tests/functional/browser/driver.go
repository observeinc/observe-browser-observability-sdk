// Package browser wires chromedp to a remote headless Chrome instance
// (chromedp/headless-shell running in a separate container) reachable over
// the Chrome DevTools Protocol. Remote debugging returns a websocket URL
// with the host baked in as seen by Chrome itself (usually "localhost"),
// which does not resolve from another container. RemoteAllocator rewrites
// the host to match the one actually used to reach Chrome.
package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/chromedp/chromedp"
)

// RemoteAllocator connects to a Chrome DevTools instance at chromeURL
// (for example, "http://chrome:9222") and returns a chromedp allocator context.
//
// headless-shell rejects DevTools requests whose Host header is not
// "localhost" or a bare IP (anti-DNS-rebinding protection), so a Docker
// Compose service name like "chrome" is resolved to its container IP first.
func RemoteAllocator(ctx context.Context, chromeURL string) (context.Context, context.CancelFunc, error) {
	chromeURL, err := resolveToIP(chromeURL)
	if err != nil {
		return nil, nil, err
	}
	wsURL, err := discoverWebSocketURL(chromeURL)
	if err != nil {
		return nil, nil, err
	}
	allocCtx, allocCancel := chromedp.NewRemoteAllocator(ctx, wsURL)
	return allocCtx, allocCancel, nil
}

// resolveToIP rewrites the host component of rawURL to its resolved IP
// address, retrying while DNS is still propagating on Compose start-up.
// Leaves "localhost" and already-numeric hosts untouched.
func resolveToIP(rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	host := u.Hostname()
	if host == "localhost" || net.ParseIP(host) != nil {
		return rawURL, nil
	}

	var lastErr error
	for i := 0; i < 40; i++ {
		ips, err := net.LookupHost(host)
		if err == nil && len(ips) > 0 {
			u.Host = net.JoinHostPort(ips[0], u.Port())
			return u.String(), nil
		}
		lastErr = err
		time.Sleep(500 * time.Millisecond)
	}
	return "", fmt.Errorf("resolve %q to IP: %w", host, lastErr)
}

func discoverWebSocketURL(chromeURL string) (string, error) {
	var lastErr error
	for i := 0; i < 40; i++ {
		resp, err := http.Get(chromeURL + "/json/version")
		if err != nil {
			lastErr = err
			time.Sleep(500 * time.Millisecond)
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		var v struct {
			WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
		}
		if err := json.Unmarshal(body, &v); err != nil {
			lastErr = fmt.Errorf("decode /json/version response %q: %w", string(body), err)
			time.Sleep(500 * time.Millisecond)
			continue
		}
		if v.WebSocketDebuggerURL == "" {
			lastErr = fmt.Errorf("/json/version response missing webSocketDebuggerUrl: %s", string(body))
			time.Sleep(500 * time.Millisecond)
			continue
		}
		return rewriteHost(v.WebSocketDebuggerURL, chromeURL)
	}
	return "", fmt.Errorf("chrome devtools not reachable at %s after retries: %w", chromeURL, lastErr)
}

// rewriteHost replaces the host:port in wsURL with the host:port used to
// reach chromeURL, since headless-shell always reports "localhost" in the
// devtools websocket URL regardless of how it was actually contacted.
func rewriteHost(wsURL, chromeURL string) (string, error) {
	ws, err := url.Parse(wsURL)
	if err != nil {
		return "", err
	}
	base, err := url.Parse(chromeURL)
	if err != nil {
		return "", err
	}
	ws.Host = base.Host
	return ws.String(), nil
}

// NavigateOptions configures how the fixture page is loaded and torn down.
type NavigateOptions struct {
	// Actions run after the page has loaded and before pagehide is triggered.
	Actions []chromedp.Action
	// SettleAfterActions is how long to wait after Actions before firing
	// pagehide, giving async instrumentation (fetch spans, CWV callbacks) a
	// moment to finish.
	SettleAfterActions time.Duration
	// SettleAfterPagehide is how long to wait after navigating away, giving
	// the exporter's `fetch(..., {keepalive})` calls time to actually reach
	// the collector before the test asserts on captured data.
	SettleAfterPagehide time.Duration
}

// RunFixture loads fixtureURL, runs opts.Actions, then triggers a real
// pagehide/visibilitychange by navigating to about:blank. This is what
// causes brum.js to force-flush traces, logs, and Core Web Vitals metrics
// (see pagehide handlers in src/brum.js). Waiting for a natural 30-second
// metrics export interval is deliberately avoided.
func RunFixture(ctx context.Context, fixtureURL string, opts NavigateOptions) error {
	settleActions := opts.SettleAfterActions
	if settleActions == 0 {
		settleActions = 500 * time.Millisecond
	}
	settlePagehide := opts.SettleAfterPagehide
	if settlePagehide == 0 {
		settlePagehide = 1500 * time.Millisecond
	}

	actions := []chromedp.Action{
		chromedp.Navigate(fixtureURL),
		chromedp.WaitReady("body"),
	}
	actions = append(actions, opts.Actions...)
	actions = append(actions,
		chromedp.Sleep(settleActions),
		chromedp.Navigate("about:blank"), // real pagehide/visibilitychange fire here
		chromedp.Sleep(settlePagehide),
	)

	return chromedp.Run(ctx, actions...)
}
