package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var (
	canvasNewFromTemplate string
	canvasNewLabel        string
)

var canvasMachinesNewCmd = &cobra.Command{
	Use:     "new",
	Aliases: []string{"run"},
	Short:   "Spawn a new peer machine in my arrangement (from template or blank)",
	RunE: func(cmd *cobra.Command, args []string) error {
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		result, err := cc.CanvasMachinesSpawn(canvasNewFromTemplate, canvasNewLabel)
		if err != nil {
			return err
		}
		// Print machineId to stdout so it's pipe-able into a subsequent
		// `piano canvas machines exec $(piano canvas machines new ...)`.
		fmt.Println(result.MachineID)
		return nil
	},
}

func init() {
	canvasMachinesNewCmd.Flags().StringVar(&canvasNewFromTemplate, "from", "", "Template id to clone from (omit for blank)")
	canvasMachinesNewCmd.Flags().StringVar(&canvasNewLabel, "label", "", "Human-readable label for the new machine")
	canvasMachinesCmd.AddCommand(canvasMachinesNewCmd)
}
