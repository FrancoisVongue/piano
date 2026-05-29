package cmd

import (
	"fmt"

	"github.com/piano-app/piano-cli/internal/render"
	"github.com/spf13/cobra"
)

var canvasMachinesGetCmd = &cobra.Command{
	Use:     "get <machine-id>",
	Aliases: []string{"inspect"},
	Short:   "Show one peer's metadata",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		peer, err := cc.CanvasMachinesGet(args[0])
		if err != nil {
			return err
		}
		if jsonOutput {
			return render.JSON(peer)
		}
		// Brief human view. Labels/values aligned with `piano machine list`.
		fmt.Printf("name:        %s\n", peer.DisplayName())
		if peer.MachineID != nil {
			fmt.Printf("machine-id:  %s\n", *peer.MachineID)
		}
		fmt.Printf("type:        %s\n", peer.Type)
		if peer.Status != nil {
			fmt.Printf("status:      %s\n", *peer.Status)
		}
		if peer.ParentMachineNodeID != nil {
			fmt.Printf("parent:      %s\n", *peer.ParentMachineNodeID)
		}
		if peer.DaemonID != nil {
			fmt.Printf("daemon:      %s\n", *peer.DaemonID)
		}
		fmt.Printf("created:     %s\n", peer.CreatedAt)
		return nil
	},
}

func init() {
	canvasMachinesCmd.AddCommand(canvasMachinesGetCmd)
}
