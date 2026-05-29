// Package render is the only place CLI output is formatted. Two
// renderers: JSON for scripting, Table for humans. Commands pick one
// based on the --json flag and never write to stdout directly.
package render

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
)

// Column describes one column of a table: a header and a per-row accessor.
// Defining columns at the call site keeps the rendering logic next to the
// command that produces the data — there's no global "schema for Machine"
// to keep in sync.
type Column[T any] struct {
	Header string
	Get    func(T) string
}

// JSON pretty-prints any value as indented JSON to stdout.
func JSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// Table writes rows as a tab-aligned grid. Empty input prints nothing
// rather than a header-only row — the absence of output is the signal.
func Table[T any](rows []T, cols []Column[T]) error {
	if len(rows) == 0 {
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	headers := make([]string, len(cols))
	for i, c := range cols {
		headers[i] = c.Header
	}
	fmt.Fprintln(w, strings.Join(headers, "\t"))
	for _, row := range rows {
		cells := make([]string, len(cols))
		for i, c := range cols {
			cells[i] = c.Get(row)
		}
		fmt.Fprintln(w, strings.Join(cells, "\t"))
	}
	return w.Flush()
}
