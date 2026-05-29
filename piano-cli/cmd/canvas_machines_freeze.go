package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var canvasMachinesFreezeCmd = &cobra.Command{
	Use:   "freeze <machine-id>",
	Short: "Freeze a peer machine (snapshot, container goes away)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		if err := cc.CanvasMachinesFreeze(args[0]); err != nil {
			return err
		}
		fmt.Printf("Frozen %s\n", args[0])
		return nil
	},
}

func init() {
	canvasMachinesCmd.AddCommand(canvasMachinesFreezeCmd)
}
