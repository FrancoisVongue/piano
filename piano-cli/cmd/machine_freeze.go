package cmd

import (
	"fmt"

	"github.com/piano-app/piano-cli/internal/resolve"
	"github.com/spf13/cobra"
)

var machineFreezeCmd = &cobra.Command{
	Use:   "freeze <machine>",
	Short: "Freeze a machine (snapshot upper dir; container goes away, can be branched)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		id, err := resolve.MachineWith(client, args[0])
		if err != nil {
			return err
		}
		if err := client.MachineFreeze(id); err != nil {
			return err
		}
		fmt.Printf("Frozen %s\n", id)
		return nil
	},
}

func init() {
	machineCmd.AddCommand(machineFreezeCmd)
}
