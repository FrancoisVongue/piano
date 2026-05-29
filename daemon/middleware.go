package main

import (
	"net/http"
	"strings"
)

// isLocalhostOrigin reports whether origin is a localhost origin that the
// daemon is allowed to serve. Only http://localhost:* and
// http://127.0.0.1:* are accepted — the daemon is a local service and
// should never be reachable from a remote page.
func isLocalhostOrigin(origin string) bool {
	return strings.HasPrefix(origin, "http://localhost") ||
		strings.HasPrefix(origin, "http://127.0.0.1")
}

// withCORS wraps an http.Handler to allow cross-origin requests from
// localhost origins only. Remote origins are denied by omitting the
// Access-Control-Allow-Origin header, which causes browsers to block the
// request. The daemon runs on the user's own machine and is accessed from
// the Piano frontend on a different port/origin, so localhost CORS is
// required, but wildcard CORS would expose the daemon to any web page.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if isLocalhostOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}

		if r.Method == http.MethodOptions {
			if isLocalhostOrigin(origin) {
				w.WriteHeader(http.StatusNoContent)
			} else {
				w.WriteHeader(http.StatusForbidden)
			}
			return
		}

		next.ServeHTTP(w, r)
	})
}
