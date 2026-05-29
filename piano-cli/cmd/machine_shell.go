package cmd

import (
	"github.com/piano-app/piano-cli/internal/resolve"
	"github.com/piano-app/piano-cli/internal/sshx"
	"github.com/spf13/cobra"
)

var machineShellCmd = &cobra.Command{
	Use:     "attach <machine>",
	Aliases: []string{"shell", "sh"},
	Short:   "Open an interactive shell on a machine (docker-attach equivalent)",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		id, err := resolve.MachineWith(client, args[0])
		if err != nil {
			return err
		}
		return sshx.Run(sshx.LocalTarget(id), nil, false)
	},
}

func init() {
	machineCmd.AddCommand(machineShellCmd)
}
