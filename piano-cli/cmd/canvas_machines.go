package cmd

import "github.com/spf13/cobra"

// canvasMachinesCmd is the peer-machine surface inside a piano machine.
// Symmetric to `piano machine *` on the host: ls / get / logs / new /
// freeze / rm / exec — the same verbs `docker` and `podman` use.
var canvasMachinesCmd = &cobra.Command{
	Use:     "machines",
	Aliases: []string{"m"},
	Short:   "Manage peer machines on my canvas (ls, get, logs, new, freeze, rm, exec)",
}

func init() {
	canvasCmd.AddCommand(canvasMachinesCmd)
}
