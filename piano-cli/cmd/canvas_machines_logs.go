package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var canvasMachinesLogsCmd = &cobra.Command{
	Use:     "logs <machine-id>",
	Aliases: []string{"output"},
	Short:   "Recent PTY output of a peer (docker-logs equivalent)",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		out, err := cc.CanvasMachinesOutput(args[0])
		if err != nil {
			return err
		}
		fmt.Print(out)
		return nil
	},
}

func init() {
	canvasMachinesCmd.AddCommand(canvasMachinesLogsCmd)
}
