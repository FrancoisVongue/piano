// Package api is the only place the CLI speaks HTTP. In V1 it talks
// directly to the local daemon (`localhost:9718`) — no backend, no auth.
// One generic helper carries the whole request shape:
//
//   - do[T]  decodes the JSON body into T on 2xx
//   - doVoid throws away the body (used for 204 responses)
//
// The daemon uses `http.Error()` for failure paths, which writes a plain-text
// body — different from the backend's JSON `{error}` envelope. We treat any
// non-2xx body as the error message, verbatim.
package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"

	"github.com/piano-app/piano-cli/internal/config"
)

// Default endpoints. V1 assumes a single local daemon on the same host as
// the user. Override via the global `--endpoint` flag if anything moves.
const (
	DaemonURL  = "http://localhost:9718"
	BackendURL = "http://localhost:3009"
)

type Client struct {
	endpoint string
	http     *http.Client
	jar      http.CookieJar // non-nil only in user-mode (login)
}

// New is the daemon-mode constructor. Plain HTTP, no auth.
func New(endpoint string) *Client {
	if endpoint == "" {
		endpoint = DaemonURL
	}
	return &Client{endpoint: endpoint, http: &http.Client{}}
}

// NewUser is the host-side user-mode constructor: cookie jar that loads
// from ~/.config/piano/cookies.json and replays on every request. Used
// by `piano login/logout/whoami` and `piano machine issue-token`.
func NewUser(endpoint string) *Client {
	if endpoint == "" {
		endpoint = BackendURL
	}
	jar, _ := cookiejar.New(nil)
	_ = config.LoadCookies(jar, endpoint)
	return &Client{
		endpoint: endpoint,
		http:     &http.Client{Jar: jar},
		jar:      jar,
	}
}

// Jar returns the cookie jar so `piano login` can persist the cookies the
// backend hands back after sign-in. Only meaningful for clients built via
// NewUser.
func (c *Client) Jar() http.CookieJar { return c.jar }

func (c *Client) Endpoint() string { return c.endpoint }

// HTTPError carries the status code so callers could branch on 404 if
// they really wanted (in practice the message suffices).
type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string { return e.Message }

// request is the single HTTP call site. out may be nil for 204 / no-body
// responses. On any non-2xx the body is read as plain text (the daemon
// uses `http.Error()` for failures) and surfaced as the error message.
func (c *Client) request(method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal body: %w", err)
		}
		reader = bytes.NewReader(buf)
	}

	req, err := http.NewRequest(method, c.endpoint+path, reader)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("contact %s: %w", c.endpoint, err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := strings.TrimSpace(string(respBody))
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return &HTTPError{Status: resp.StatusCode, Message: msg}
	}

	if out == nil || len(respBody) == 0 {
		return nil
	}
	if err := json.Unmarshal(respBody, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

// do decodes the response body directly into T. Use for daemon
// endpoints (which return raw JSON) and better-auth endpoints (which
// have their own native envelope shapes).
func do[T any](c *Client, method, path string, body any) (T, error) {
	var v T
	err := c.request(method, path, body, &v)
	return v, err
}

// doSuccess unwraps the backend controller envelope `{success: T}`.
// Use for our own /api/* routes (machines, canvas, templates, ...) that
// follow the project's success-envelope convention.
func doSuccess[T any](c *Client, method, path string, body any) (T, error) {
	var wrap struct {
		Success T `json:"success"`
	}
	err := c.request(method, path, body, &wrap)
	return wrap.Success, err
}

// doRaw is an alias for do, kept for readability at sites where the
// authors explicitly want to flag "this endpoint doesn't follow our
// envelope convention" (better-auth).
func doRaw[T any](c *Client, method, path string, body any) (T, error) {
	return do[T](c, method, path, body)
}

func doVoid(c *Client, method, path string, body any) error {
	return c.request(method, path, body, nil)
}
