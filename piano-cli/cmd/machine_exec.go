package cmd

import (
	"fmt"

	"github.com/piano-app/piano-cli/internal/resolve"
	"github.com/piano-app/piano-cli/internal/sshx"
	"github.com/spf13/cobra"
)

var execTTY bool

var machineExecCmd = &cobra.Command{
	Use:   "exec <machine> -- <cmd>...",
	Short: "Run a command on a machine (non-interactive)",
	Args:  cobra.MinimumNArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		// Cobra fills ArgsLenAtDash with the index of `--` in positional args.
		// We require it to sit right after the machine ref.
		if cmd.ArgsLenAtDash() != 1 {
			return fmt.Errorf("usage: piano machine exec <machine> -- <cmd>...")
		}
		id, err := resolve.MachineWith(client, args[0])
		if err != nil {
			return err
		}
		return sshx.Run(sshx.LocalTarget(id), args[1:], execTTY)
	},
}

func init() {
	machineExecCmd.Flags().BoolVarP(&execTTY, "tty", "t", false, "Force a PTY (for interactive commands like vim)")
	machineCmd.AddCommand(machineExecCmd)
}
