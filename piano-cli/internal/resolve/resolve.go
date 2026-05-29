// Package resolve turns a user-typed reference (id, hostname, or
// prefix) into a canonical machine id. The CLI uses this anywhere a
// command takes a machine argument, so `piano machine freeze feat-auth`
// (hostname), `piano machine freeze abc123def` (id), and `piano machine
// freeze abc` (id prefix) all work.
package resolve

import (
	"fmt"
	"strings"

	"github.com/piano-app/piano-cli/internal/api"
)

// Machine resolves `ref` against an already-fetched list. Use this when
// the caller already has the list (avoids a second HTTP round-trip).
//
// Resolution order: exact id, exact hostname, id prefix, hostname prefix.
// An exact match short-circuits even if a different machine has `ref` as
// a prefix. Ambiguous prefix matches surface every candidate so the user
// can disambiguate.
func Machine(machines []api.Machine, ref string) (string, error) {
	if ref == "" {
		return "", fmt.Errorf("empty machine reference")
	}

	// Pass 1: exact id or hostname.
	exact := filter(machines, func(m api.Machine) bool {
		return m.ID == ref || m.Hostname == ref
	})
	if id, err := single(exact, ref, "exact match"); err != nil || id != "" {
		return id, err
	}

	// Pass 2: prefix match.
	lref := strings.ToLower(ref)
	prefix := filter(machines, func(m api.Machine) bool {
		return strings.HasPrefix(m.ID, ref) ||
			(m.Hostname != "" && strings.HasPrefix(strings.ToLower(m.Hostname), lref))
	})
	if id, err := single(prefix, ref, "prefix"); err != nil || id != "" {
		return id, err
	}

	return "", fmt.Errorf("no machine matches %q", ref)
}

// MachineWith fetches the list and resolves in one go — the path most
// commands take.
func MachineWith(c *api.Client, ref string) (string, error) {
	list, err := c.MachineList()
	if err != nil {
		return "", err
	}
	return Machine(list, ref)
}

func filter(machines []api.Machine, pred func(api.Machine) bool) []api.Machine {
	out := make([]api.Machine, 0, len(machines))
	for _, m := range machines {
		if pred(m) {
			out = append(out, m)
		}
	}
	return out
}

func single(candidates []api.Machine, ref, stage string) (string, error) {
	switch len(candidates) {
	case 0:
		return "", nil
	case 1:
		return candidates[0].ID, nil
	}
	names := make([]string, 0, len(candidates))
	for _, m := range candidates {
		names = append(names, fmt.Sprintf("%s (%s)", m.DisplayName(), m.ID))
	}
	return "", fmt.Errorf("%q is ambiguous (%s) — %d candidates: %s",
		ref, stage, len(candidates), strings.Join(names, ", "))
}
