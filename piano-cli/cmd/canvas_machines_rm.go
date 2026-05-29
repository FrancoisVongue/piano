package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var canvasRmYes bool

var canvasMachinesRmCmd = &cobra.Command{
	Use:     "rm <machine-id>",
	Aliases: []string{"delete"},
	Short:   "Destroy a peer machine (container + canvas note)",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !canvasRmYes {
			fmt.Printf("Delete peer %s? Re-run with --yes to confirm.\n", args[0])
			return nil
		}
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		if err := cc.CanvasMachinesRemove(args[0]); err != nil {
			return err
		}
		fmt.Printf("Deleted %s\n", args[0])
		return nil
	},
}

func init() {
	canvasMachinesRmCmd.Flags().BoolVarP(&canvasRmYes, "yes", "y", false, "Skip the confirmation prompt")
	canvasMachinesCmd.AddCommand(canvasMachinesRmCmd)
}
