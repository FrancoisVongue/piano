package cmd

import (
	"fmt"

	"github.com/piano-app/piano-cli/internal/api"
	"github.com/piano-app/piano-cli/internal/render"
	"github.com/piano-app/piano-cli/internal/sshx"
	"github.com/spf13/cobra"
)

var machineListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List all machines on the local daemon",
	RunE: func(cmd *cobra.Command, args []string) error {
		machines, err := client.MachineList()
		if err != nil {
			return err
		}
		if jsonOutput {
			return render.JSON(machines)
		}
		return render.Table(machines, []render.Column[api.Machine]{
			{Header: "NAME", Get: func(m api.Machine) string { return m.DisplayName() }},
			{Header: "ID", Get: func(m api.Machine) string { return m.ID }},
			{Header: "STATE", Get: func(m api.Machine) string { return m.State }},
			{Header: "PARENT", Get: func(m api.Machine) string {
				if m.ParentID == "" {
					return "-"
				}
				return m.ParentID
			}},
			{Header: "SSH", Get: func(m api.Machine) string {
				return fmt.Sprintf("ssh -p %d %s@%s", sshx.DefaultPort, m.ID, sshx.DefaultHost)
			}},
		})
	},
}

func init() {
	machineCmd.AddCommand(machineListCmd)
}
