package main

import (
	"bytes"
	"io"
)

// Local responder for terminal capability queries that TUI programs send at
// startup (neovim, vim, htop, less, tig, anything ncurses). Without this, the
// queries travel PTY → daemon → WS → backend → browser → xterm.js, xterm.js
// generates the correct reply, and the reply travels all the way back. That
// round-trip is 100–300 ms of network and process hops. For short-lived TUI
// invocations like `nvim -c 'wq'` (~77 ms total), the program exits BEFORE
// the reply makes it back to the PTY — and the stray reply ends up in the
// shell that took over the PTY. zsh's line editor parses the leading ESC as
// a meta-prefix, fails to match any binding, falls through to self-insert,
// and the user sees mangled `11;rgb:1a1a/1b1b/2626`, `1$r0m`, `1;2c` on
// their prompt line.
//
// Answering the queries here (in the daemon's PTY read loop, on the same
// side of the pipe as the program) lets nvim get its replies within ~1 ms.
// nvim finishes probing and either continues running or exits cleanly; the
// xterm.js-generated replies that still come back from the browser are
// dropped by the frontend filter in TerminalPanel.tsx.
//
// The canned responses advertise a fairly capable xterm-256color-ish
// terminal, matching what piano's xterm.js setup actually supports. They
// come from looking at what real xterm and kitty respond to these same
// queries. The background/foreground/cursor colors match the hardcoded
// theme in TerminalPanel.tsx (Tokyo Night-ish).
var terminalQueryResponses = []struct {
	query, reply []byte
}{
	// Primary Device Attributes (DA1): "what are you?"
	// Reply ?1;2c = VT100 with advanced video option (standard xterm reply).
	{[]byte("\x1b[c"), []byte("\x1b[?1;2c")},
	{[]byte("\x1b[0c"), []byte("\x1b[?1;2c")},

	// Secondary Device Attributes (DA2): "which xterm variant?"
	// Reply >41;340;0c = xterm patch level 340, no firmware version.
	{[]byte("\x1b[>c"), []byte("\x1b[>41;340;0c")},
	{[]byte("\x1b[>0c"), []byte("\x1b[>41;340;0c")},

	// Tertiary Device Attributes (DA3): "unique terminal ID?"
	// Reply P!|00000000\ = null ID (standard xterm fallback).
	{[]byte("\x1b[=c"), []byte("\x1bP!|00000000\x1b\\")},
	{[]byte("\x1b[=0c"), []byte("\x1bP!|00000000\x1b\\")},

	// OSC 10/11/12: foreground, background, cursor color queries.
	// Both ST (ESC \) and BEL terminator forms are used by different clients.
	// Colors match TerminalPanel.tsx theme.
	{[]byte("\x1b]10;?\x07"), []byte("\x1b]10;rgb:c0c0/caca/f5f5\x07")},
	{[]byte("\x1b]10;?\x1b\\"), []byte("\x1b]10;rgb:c0c0/caca/f5f5\x1b\\")},
	{[]byte("\x1b]11;?\x07"), []byte("\x1b]11;rgb:1a1a/1b1b/2626\x07")},
	{[]byte("\x1b]11;?\x1b\\"), []byte("\x1b]11;rgb:1a1a/1b1b/2626\x1b\\")},
	{[]byte("\x1b]12;?\x07"), []byte("\x1b]12;rgb:c0c0/caca/f5f5\x07")},
	{[]byte("\x1b]12;?\x1b\\"), []byte("\x1b]12;rgb:c0c0/caca/f5f5\x1b\\")},

	// DECRQSS for SGR attributes: "what are the current graphic rendition attrs?"
	// Reply: 1$r0m = valid response, SGR reset (no bold/color/etc).
	{[]byte("\x1bP$qm\x1b\\"), []byte("\x1bP1$r0m\x1b\\")},

	// XTVERSION (nvim uses this to detect kitty-style version reporting).
	// Reply: advertise as "xterm(340)" — a generic identifier that matches DA2.
	{[]byte("\x1b[>0q"), []byte("\x1bP>|xterm(340)\x1b\\")},
	{[]byte("\x1b[>q"), []byte("\x1bP>|xterm(340)\x1b\\")},
}

// answerTerminalQueries scans `chunk` (the bytes the program just wrote to
// the PTY) for known capability queries. For each match, writes a canned
// reply back to the PTY so the program can read it on the next read() cycle.
//
// Fast path: if there's no ESC byte in the chunk, there can't be an escape
// sequence, so skip the scan.
//
// Limitations this version accepts:
//   - Queries that straddle two reads (rare: queries are ≤10 bytes, PTY read
//     buffer is 4 KB) are not detected. If it becomes a real problem, add a
//     small carry buffer.
//   - Queries with parameter variants we don't list (e.g. OSC 10 with `;?`
//     but different capitalization) fall through to the browser. The browser
//     round-trip still works for those; they just don't get the daemon's
//     speedup.
//   - We forward the query to the viewer (xterm.js) anyway. xterm.js will
//     generate its own reply, which the frontend filter in TerminalPanel.tsx
//     drops. Not stripping the query from the forwarded stream keeps this
//     helper stateless and avoids partial-write fragility.
func answerTerminalQueries(w io.Writer, chunk []byte) {
	if bytes.IndexByte(chunk, 0x1b) < 0 {
		return
	}
	for _, q := range terminalQueryResponses {
		if bytes.Contains(chunk, q.query) {
			_, _ = w.Write(q.reply)
		}
	}
}
