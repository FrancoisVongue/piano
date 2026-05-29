package cmd

import (
	"fmt"

	"github.com/piano-app/piano-cli/internal/render"
	"github.com/spf13/cobra"
)

var canvasMeCmd = &cobra.Command{
	Use:   "me",
	Short: "Show this machine's identity (id, arrangement, user)",
	RunE: func(cmd *cobra.Command, args []string) error {
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		ctx, err := cc.CanvasMe()
		if err != nil {
			return err
		}
		if jsonOutput {
			return render.JSON(ctx)
		}
		fmt.Printf("machine:      %s\narrangement:  %s\nuser:         %s\n", ctx.ID, ctx.ArrangementID, ctx.UserID)
		return nil
	},
}

func init() {
	canvasCmd.AddCommand(canvasMeCmd)
}
