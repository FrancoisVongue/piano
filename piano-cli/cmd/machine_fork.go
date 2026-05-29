package cmd

import (
	"fmt"

	"github.com/piano-app/piano-cli/internal/id"
	"github.com/piano-app/piano-cli/internal/resolve"
	"github.com/spf13/cobra"
)

var machineForkCmd = &cobra.Command{
	Use:   "fork <parent> [name]",
	Short: "Fork a machine — create a child off a running or frozen parent",
	Args:  cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		parentID, err := resolve.MachineWith(client, args[0])
		if err != nil {
			return err
		}
		hostname := ""
		if len(args) == 2 {
			hostname = args[1]
		}
		child, err := client.MachineBranch(parentID, id.New(), hostname)
		if err != nil {
			return err
		}
		fmt.Printf("Forked %s → %s\n", child.ParentID, child.ID)
		return nil
	},
}

func init() {
	machineCmd.AddCommand(machineForkCmd)
}
