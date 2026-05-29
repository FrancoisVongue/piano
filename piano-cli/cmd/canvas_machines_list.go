package cmd

import (
	"github.com/piano-app/piano-cli/internal/api"
	"github.com/piano-app/piano-cli/internal/render"
	"github.com/spf13/cobra"
)

var canvasMachinesListCmd = &cobra.Command{
	Use:     "ls",
	Aliases: []string{"list", "ps"},
	Short:   "List peer machines on my canvas",
	RunE: func(cmd *cobra.Command, args []string) error {
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		peers, err := cc.CanvasMachinesList()
		if err != nil {
			return err
		}
		if jsonOutput {
			return render.JSON(peers)
		}
		return render.Table(peers, []render.Column[api.PeerMachine]{
			{Header: "NAME", Get: func(p api.PeerMachine) string { return p.DisplayName() }},
			{Header: "MACHINE-ID", Get: func(p api.PeerMachine) string {
				if p.MachineID == nil {
					return "-"
				}
				return *p.MachineID
			}},
			{Header: "TYPE", Get: func(p api.PeerMachine) string { return p.Type }},
			{Header: "STATUS", Get: func(p api.PeerMachine) string {
				if p.Status == nil {
					return "-"
				}
				return *p.Status
			}},
		})
	},
}

func init() {
	canvasMachinesCmd.AddCommand(canvasMachinesListCmd)
}
