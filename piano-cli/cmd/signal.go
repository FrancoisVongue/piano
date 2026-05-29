package cmd

import (
	"github.com/piano-app/piano-cli/internal/signal"
	"github.com/spf13/cobra"
)

// signal / notify / done — the in-machine activity primitive, ported from the
// former wrapper/piano.sh so the single `piano` binary carries both the canvas
// surface and the activity signal. These emit an OSC escape the daemon reads
// off the PTY (see internal/signal + daemon/activity.go): no backend, no token,
// no network. Only observed when run inside a Piano terminal pane.

var signalCmd = &cobra.Command{
	Use:     "signal [state] [message]",
	Aliases: []string{"status"},
	Short:   `Signal machine activity to the host (state defaults to "working")`,
	Long: `Emit a free-form activity <state> (+ optional message) the Piano host
reads off the terminal stream. The host stores the label verbatim; "attention"
is the one that surfaces loudest. Only observed inside a Piano terminal pane —
SSH / "Open in IDE" sessions bypass the daemon's PTY reader.

  piano signal working "building frontend"
  piano signal            # defaults state to "working"`,
	Args: cobra.MaximumNArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		state := "working"
		msg := ""
		if len(args) > 0 {
			state = args[0]
		}
		if len(args) > 1 {
			msg = args[1]
		}
		return signal.Emit(state, msg)
	},
}

var notifyCmd = &cobra.Command{
	Use:   "notify [message]",
	Short: "Attention ping — ask the supervisor to look at this machine",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		msg := ""
		if len(args) > 0 {
			msg = args[0]
		}
		return signal.Emit(signal.StateAttention, msg)
	},
}

var doneCmd = &cobra.Command{
	Use:   "done [message]",
	Short: "Mark the current unit of work finished",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		msg := ""
		if len(args) > 0 {
			msg = args[0]
		}
		return signal.Emit("done", msg)
	},
}

func init() {
	rootCmd.AddCommand(signalCmd, notifyCmd, doneCmd)
}
