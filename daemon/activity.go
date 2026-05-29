package main

import (
	"encoding/base64"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Activity is a point-in-time view of what a machine is doing, derived purely
// from its terminal byte stream — nothing inside the machine has to cooperate.
// Three signal sources, all idiomatic terminal conventions the host can read
// out of the PTY it already owns:
//
//   - OSC 133 shell integration (FinalTerm/iTerm/VSCode): emitted automatically
//     by the zsh hooks baked into the base image. Gives command lifecycle —
//     at-prompt (idle) vs running, plus the exit code of the last command.
//   - OSC 1337;Piano: the explicit `piano` primitive any process (a build, a
//     human's script, an agent prompted to do so) calls to push a free-form
//     state label + message. We transport the label the caller chose; we do
//     not interpret it. Agents are just one possible caller.
//   - BEL (\a): the decades-old "pay attention to me" terminal signal.
//
// This is machine-level by construction — no notion of "agent" leaks in here.
type Activity struct {
	Phase          string     `json:"phase"`                    // "idle" | "running" | "" (unknown)
	LastExitCode   *int       `json:"lastExitCode,omitempty"`   // exit code of the last finished command
	Signal         string     `json:"signal,omitempty"`         // last explicit piano label
	Message        string     `json:"message,omitempty"`        // last piano message
	LastActivityAt *time.Time `json:"lastActivityAt,omitempty"` // last byte observed on the stream
	AttentionAt    *time.Time `json:"attentionAt,omitempty"`    // last bell or explicit piano signal
}

// ActivityTracker scans a PTY byte stream incrementally and maintains Activity.
// Feed runs on the single PTY reader goroutine; Snapshot is read by the metrics
// collector. One mutex guards both. We only decode OSC (ESC ]) sequences;
// everything else (CSI colour codes, plain text) just advances activity time.
//
// Coverage boundary: activity is observed ONLY on PTYs the daemon pumps via
// Machine.readPTY — i.e. terminal panes (primary + spawnPane). SSH-gateway /
// "Open in IDE" sessions are a separate `podman exec` wired straight to the SSH
// channel (see ssh_gateway.handleShell), so OSC/`piano` emitted there is NOT
// seen here. Agents/scripts that want to signal must run in a Piano terminal.
type ActivityTracker struct {
	mu sync.Mutex
	a  Activity

	inOSC bool   // currently collecting an OSC payload
	esc   bool   // previous byte was ESC (start of CSI/OSC, or ST inside OSC)
	osc   []byte // accumulated OSC payload (between "ESC ]" and its terminator)
}

const oscMaxLen = 4096

// ActivitySignalAttention is the one explicit "pay attention to me" label.
// `piano notify` emits it (OSC 1337;Piano;attention;…); severity() ranks it
// highest; the frontend mirrors it as ActivityView.ATTENTION. This constant is
// the contract anchor — the literal string is shared across Go, the shell
// (piano.sh), and TypeScript, so change all three together.
const ActivitySignalAttention = "attention"

func NewActivityTracker() *ActivityTracker { return &ActivityTracker{} }

// Feed scans one chunk of raw PTY output. Sequences may straddle chunk
// boundaries — the scanner state (inOSC/esc/osc) persists across calls.
func (t *ActivityTracker) Feed(data []byte) {
	if len(data) == 0 {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	now := time.Now()
	t.a.LastActivityAt = &now

	for _, b := range data {
		switch {
		case t.inOSC:
			switch {
			case b == 0x07: // BEL terminates an OSC string
				t.finishOSC(now)
			case b == 0x1b: // possible ST (ESC \)
				t.esc = true
			case t.esc && b == '\\': // ST reached
				t.finishOSC(now)
			default:
				t.esc = false
				if len(t.osc) < oscMaxLen {
					t.osc = append(t.osc, b)
				}
			}
		case t.esc:
			t.esc = false
			if b == ']' { // ESC ] → OSC begins
				t.inOSC = true
				t.osc = t.osc[:0]
			}
			// any other intro byte (e.g. '[' for CSI) — we don't track it
		default:
			switch b {
			case 0x1b:
				t.esc = true
			case 0x07: // standalone bell — attention
				t.a.AttentionAt = &now
			}
		}
	}
}

func (t *ActivityTracker) finishOSC(now time.Time) {
	t.parseOSC(string(t.osc), now)
	t.inOSC = false
	t.esc = false
	t.osc = t.osc[:0]
}

// parseOSC interprets the two OSC vocabularies we care about. Unknown codes
// are ignored, which is also how terminals treat them — invisible passthrough.
func (t *ActivityTracker) parseOSC(payload string, now time.Time) {
	parts := strings.Split(payload, ";")
	if len(parts) == 0 {
		return
	}
	switch parts[0] {
	case "133": // shell integration: A/B = prompt (idle), C = running, D[;code] = done
		if len(parts) < 2 {
			return
		}
		switch parts[1] {
		case "C":
			t.a.Phase = "running"
		case "A", "B":
			t.a.Phase = "idle"
		case "D":
			t.a.Phase = "idle"
			if len(parts) >= 3 {
				if code, err := strconv.Atoi(strings.TrimSpace(parts[2])); err == nil {
					t.a.LastExitCode = &code
				}
			}
		}
	case "1337": // iTerm-style proprietary namespace; we own only the "Piano" key
		if len(parts) >= 3 && parts[1] == "Piano" {
			t.a.Signal = parts[2]
			t.a.AttentionAt = &now
			if len(parts) >= 4 {
				if msg, err := base64.StdEncoding.DecodeString(parts[3]); err == nil {
					t.a.Message = string(msg)
				}
			} else {
				t.a.Message = ""
			}
		}
	}
}

// Snapshot returns the current Activity. Pointer fields are swapped wholesale
// on update (never mutated in place), so a shallow copy is safe to read.
func (t *ActivityTracker) Snapshot() Activity {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.a
}

// ---------------------------------------------------------------------------
// Container rollup.
//
// Activity is a per-terminal (per-PTY) fact, but a container can hold several
// terminals (the primary PTY + every `spawnPane`/sharedWith sibling). The UI
// scans at the container level, so we roll the terminals up into one summary:
// the *loudest* terminal wins, plus counts so the row can say "2 running".
// A window is just a viewport over these terminals — it holds no state of its
// own, so there is nothing to disambiguate there.
//
// Note on extracted terminals: a pane the user drags out to the canvas becomes
// its own node/row showing its own activity, AND still folds into its parent's
// rollup (it remains a sharedWith terminal of the same container). That double
// surfacing is intentional — the rollup is container truth, and which panes are
// "extracted" is frontend layout the daemon neither sees nor should track.
// ---------------------------------------------------------------------------

// TerminalActivity is one terminal's activity tagged with its machine id. The
// frontend maps the id back to a tab/pane label using its window layout.
type TerminalActivity struct {
	MachineId string   `json:"machineId"`
	Activity  Activity `json:"activity"`
}

// ActivityPush is one machine's activity as streamed to the backend on change
// (control message "machine:activity"). Primary machines carry the rollup.
type ActivityPush struct {
	MachineId string         `json:"machineId"`
	Activity  Activity       `json:"activity"`
	Group     *ActivityGroup `json:"activityGroup,omitempty"`
}

// ActivityGroup is the container-level rollup attached to the primary machine.
type ActivityGroup struct {
	Summary   Activity           `json:"summary"` // the loudest terminal's activity
	Running   int                `json:"running"`
	Attention int                `json:"attention"`
	Failed    int                `json:"failed"`
	Total     int                `json:"total"`
	Terminals []TerminalActivity `json:"terminals"`
}

// severity ranks a single terminal so the rollup can pick a winner. Higher is
// louder. "attention" is the explicit `piano notify` convention (signal set to
// "attention"); a non-zero exit on an idle shell is a sticky failure; running
// is in-progress; everything else is calm. We deliberately do NOT treat a past
// bell (AttentionAt) as sticky attention — that needs read-state we don't have
// on the daemon yet.
func severity(a Activity) int {
	switch {
	case a.Signal == ActivitySignalAttention:
		return 3
	case a.Phase == "idle" && a.LastExitCode != nil && *a.LastExitCode != 0:
		return 2
	case a.Phase == "running":
		return 1
	default:
		return 0
	}
}

// RollupActivity reduces a container's terminals to one summary + counts.
// Pure — no locking, no I/O — so it's trivially testable. Returns nil for an
// empty set so callers can omit the field.
func RollupActivity(terminals []TerminalActivity) *ActivityGroup {
	if len(terminals) == 0 {
		return nil
	}
	g := &ActivityGroup{Total: len(terminals), Terminals: terminals}
	best := -1
	for _, t := range terminals {
		s := severity(t.Activity)
		switch s {
		case 3:
			g.Attention++
		case 2:
			g.Failed++
		case 1:
			g.Running++
		}
		if s > best {
			best = s
			g.Summary = t.Activity
		}
	}
	return g
}
