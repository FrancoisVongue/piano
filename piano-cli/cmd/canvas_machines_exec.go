package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var canvasExecWorkdir string

var canvasMachinesExecCmd = &cobra.Command{
	Use:   "exec <machine-id> -- <cmd>...",
	Short: "Run a command on a peer machine (docker-exec equivalent, non-interactive)",
	Long: `Runs <cmd> on the given peer machine in this arrangement. Returns
the combined stdout+stderr to the caller and exits with the same code
the remote process did. Non-zero exit is a NORMAL result (process ran
and failed) — error output indicates the daemon couldn't even start it.

For multi-step Claude Code conversations, pair this with claude --resume:

  SID=$(piano canvas machines exec W -- claude -p --output-format json "$INITIAL" | jq -r .session_id)
  piano canvas machines exec W -- claude -p --resume "$SID" "$FOLLOWUP"`,
	Args: cobra.MinimumNArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		// Same `--` discipline as `piano machine exec`.
		if cmd.ArgsLenAtDash() != 1 {
			return fmt.Errorf("usage: piano canvas machines exec <machine-id> -- <cmd>...")
		}
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		result, err := cc.CanvasMachinesExec(args[0], args[1:], canvasExecWorkdir)
		if err != nil {
			return err
		}
		// stdout for output (so it's pipe-friendly). stderr for exit-line
		// hint when non-zero, suppressed on success — matches `bash` behavior.
		fmt.Print(result.Output)
		if result.ExitCode != 0 {
			fmt.Fprintf(os.Stderr, "exit code: %d\n", result.ExitCode)
			os.Exit(result.ExitCode)
		}
		return nil
	},
}

func init() {
	canvasMachinesExecCmd.Flags().StringVar(&canvasExecWorkdir, "workdir", "", "Working directory (default: machine's home)")
	canvasMachinesCmd.AddCommand(canvasMachinesExecCmd)
}
