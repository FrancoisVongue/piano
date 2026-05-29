package main

import (
	"encoding/base64"
	"testing"
)

func intPtr(n int) *int { return &n }

func running() Activity          { return Activity{Phase: "running"} }
func idleExit(code int) Activity { return Activity{Phase: "idle", LastExitCode: intPtr(code)} }
func attention(msg string) Activity {
	return Activity{Signal: ActivitySignalAttention, Message: msg}
}

func TestRollupActivity(t *testing.T) {
	t.Run("empty returns nil", func(t *testing.T) {
		if g := RollupActivity(nil); g != nil {
			t.Fatalf("want nil, got %+v", g)
		}
	})

	t.Run("single terminal counts + summary", func(t *testing.T) {
		g := RollupActivity([]TerminalActivity{{MachineId: "a", Activity: running()}})
		if g.Total != 1 || g.Running != 1 {
			t.Fatalf("counts wrong: %+v", g)
		}
		if g.Summary.Phase != "running" {
			t.Fatalf("summary should be running, got %+v", g.Summary)
		}
	})

	t.Run("attention is loudest", func(t *testing.T) {
		g := RollupActivity([]TerminalActivity{
			{MachineId: "a", Activity: idleExit(0)},
			{MachineId: "b", Activity: running()},
			{MachineId: "c", Activity: idleExit(1)},
			{MachineId: "d", Activity: attention("review diff")},
		})
		if g.Total != 4 || g.Running != 1 || g.Failed != 1 || g.Attention != 1 {
			t.Fatalf("counts wrong: %+v", g)
		}
		if g.Summary.Signal != ActivitySignalAttention || g.Summary.Message != "review diff" {
			t.Fatalf("summary should be the attention terminal, got %+v", g.Summary)
		}
	})

	t.Run("failed beats running beats idle", func(t *testing.T) {
		g := RollupActivity([]TerminalActivity{
			{MachineId: "a", Activity: idleExit(0)},
			{MachineId: "b", Activity: running()},
			{MachineId: "c", Activity: idleExit(2)},
		})
		if g.Summary.LastExitCode == nil || *g.Summary.LastExitCode != 2 {
			t.Fatalf("summary should be the failed terminal, got %+v", g.Summary)
		}
	})
}

func TestActivityTrackerFeed(t *testing.T) {
	osc := func(body string) string { return "\x1b]" + body + "\x07" }

	t.Run("OSC 133 running then exit code", func(t *testing.T) {
		tr := NewActivityTracker()
		tr.Feed([]byte(osc("133;C")))
		if got := tr.Snapshot(); got.Phase != "running" {
			t.Fatalf("want running, got %q", got.Phase)
		}
		tr.Feed([]byte(osc("133;D;0")))
		got := tr.Snapshot()
		if got.Phase != "idle" || got.LastExitCode == nil || *got.LastExitCode != 0 {
			t.Fatalf("want idle exit 0, got %+v", got)
		}
		tr.Feed([]byte(osc("133;C") + osc("133;D;1")))
		if got := tr.Snapshot(); got.LastExitCode == nil || *got.LastExitCode != 1 {
			t.Fatalf("want exit 1, got %+v", got)
		}
	})

	t.Run("piano OSC 1337 signal + base64 message", func(t *testing.T) {
		tr := NewActivityTracker()
		b64 := base64.StdEncoding.EncodeToString([]byte("review the diff"))
		tr.Feed([]byte(osc("1337;Piano;attention;" + b64)))
		got := tr.Snapshot()
		if got.Signal != ActivitySignalAttention || got.Message != "review the diff" {
			t.Fatalf("want attention/decoded message, got %+v", got)
		}
		if got.AttentionAt == nil {
			t.Fatalf("AttentionAt should be set")
		}
	})

	t.Run("bell sets attention", func(t *testing.T) {
		tr := NewActivityTracker()
		tr.Feed([]byte("ding\x07"))
		if tr.Snapshot().AttentionAt == nil {
			t.Fatalf("bell should set AttentionAt")
		}
	})

	t.Run("CSI colour codes do not trigger OSC", func(t *testing.T) {
		tr := NewActivityTracker()
		tr.Feed([]byte("\x1b[0;1mhello\x1b[0m"))
		got := tr.Snapshot()
		if got.Phase != "" || got.Signal != "" {
			t.Fatalf("CSI should not change activity, got %+v", got)
		}
	})

	t.Run("OSC split across chunk boundary", func(t *testing.T) {
		tr := NewActivityTracker()
		tr.Feed([]byte("\x1b]133;")) // sequence starts, no terminator yet
		if tr.Snapshot().Phase == "running" {
			t.Fatalf("should not be running before terminator")
		}
		tr.Feed([]byte("C\x07")) // completes the sequence
		if tr.Snapshot().Phase != "running" {
			t.Fatalf("want running after boundary-split sequence")
		}
	})

	t.Run("unrelated OSC (title) is ignored, state intact", func(t *testing.T) {
		tr := NewActivityTracker()
		tr.Feed([]byte(osc("133;C")))
		tr.Feed([]byte(osc("0;my window title")))
		if tr.Snapshot().Phase != "running" {
			t.Fatalf("title OSC must not clobber phase")
		}
	})

	t.Run("ST-terminated OSC (ESC backslash)", func(t *testing.T) {
		tr := NewActivityTracker()
		b64 := base64.StdEncoding.EncodeToString([]byte("hi"))
		tr.Feed([]byte("\x1b]1337;Piano;working;" + b64 + "\x1b\\"))
		got := tr.Snapshot()
		if got.Signal != "working" || got.Message != "hi" {
			t.Fatalf("ST-terminated OSC parse failed: %+v", got)
		}
	})
}
