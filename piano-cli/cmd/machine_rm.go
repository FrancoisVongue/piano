package cmd

import (
	"fmt"

	"github.com/piano-app/piano-cli/internal/resolve"
	"github.com/spf13/cobra"
)

var rmYes bool

var machineRmCmd = &cobra.Command{
	Use:     "rm <machine>",
	Aliases: []string{"delete"},
	Short:   "Delete a machine on the local daemon",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		id, err := resolve.MachineWith(client, args[0])
		if err != nil {
			return err
		}
		if !rmYes {
			fmt.Printf("Delete machine %s? Re-run with --yes to confirm.\n", id)
			return nil
		}
		if err := client.MachineDelete(id); err != nil {
			return err
		}
		fmt.Printf("Deleted %s\n", id)
		return nil
	},
}

func init() {
	machineRmCmd.Flags().BoolVarP(&rmYes, "yes", "y", false, "Skip the confirmation prompt")
	machineCmd.AddCommand(machineRmCmd)
}
