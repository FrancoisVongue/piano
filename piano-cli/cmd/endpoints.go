package cmd

import "os"

// backendEndpoint returns the backend URL — env var if set, otherwise the
// localhost default. Shared between every host-side backend caller
// (login / logout / whoami / machine issue-token) so we have one
// place to revisit if "where is backend" becomes more interesting.
func backendEndpoint() string {
	if v := os.Getenv("PIANO_BACKEND"); v != "" {
		return v
	}
	return "http://localhost:3009"
}
