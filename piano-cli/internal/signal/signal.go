// Package signal emits the in-machine activity primitive: an OSC escape
// sequence the Piano daemon reads straight off the PTY byte stream it already
// owns (see daemon/activity.go). No socket, no daemon API, no network — any
// process in the machine (a build script, a human, an agent) can call it.
//
// Wire format — MUST match daemon/activity.go parseOSC, the contract anchor:
//
//	ESC ] 1337 ; Piano ; <state> ; <base64-std(message)> BEL
//
// <state> is a free-form label the host stores verbatim; only "attention" is
// special (it ranks highest in the activity rollup). The message is standard
// base64 so it may carry spaces, ';' and newlines without breaking the OSC
// grammar; the daemon base64-decodes it.
//
// Only observed inside a Piano terminal pane — an SSH / "Open in IDE" session
// is a separate exec that bypasses the daemon's PTY reader.
package signal

import (
	"encoding/base64"
	"fmt"
	"os"
)

// StateAttention is the one label the host treats specially: it ranks highest
// in the daemon's activity rollup (severity) and the frontend mirrors it as
// ATTENTION. The literal is shared across Go (here + daemon/activity.go's
// ActivitySignalAttention) and TypeScript — change all of them together.
const StateAttention = "attention"

// Emit writes the OSC activity sequence for state/message to the controlling
// terminal. Prefers /dev/tty so the signal lands on the PTY even when stdout
// is redirected; falls back to stdout when /dev/tty isn't writable (mirrors
// the former piano.sh `[ -w /dev/tty ]` check).
func Emit(state, message string) error {
	b64 := base64.StdEncoding.EncodeToString([]byte(message))
	seq := fmt.Sprintf("\033]1337;Piano;%s;%s\007", state, b64)

	if tty, err := os.OpenFile("/dev/tty", os.O_WRONLY, 0); err == nil {
		defer tty.Close()
		_, werr := tty.WriteString(seq)
		return werr
	}
	_, werr := fmt.Fprint(os.Stdout, seq)
	return werr
}
