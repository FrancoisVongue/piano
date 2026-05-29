package cmd

import (
	"fmt"

	"github.com/piano-app/piano-cli/internal/render"
	"github.com/spf13/cobra"
)

var canvasRollbackCmd = &cobra.Command{
	Use:   "rollback <node-id> <version-id>",
	Short: "Switch a node's content to a stored snapshot (reversible — snaps current first)",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		updated, err := cc.CanvasRollback(args[0], args[1])
		if err != nil {
			return err
		}
		if jsonOutput {
			return render.JSON(updated)
		}
		fmt.Printf("Rolled back %s to version %s (now v%d)\n", updated.ID, args[1], updated.Version)
		return nil
	},
}

func init() {
	canvasCmd.AddCommand(canvasRollbackCmd)
}
