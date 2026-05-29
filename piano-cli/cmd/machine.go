package cmd

import "github.com/spf13/cobra"

var machineCmd = &cobra.Command{
	Use:     "machine",
	Aliases: []string{"m"},
	Short:   "Manage machines (list, attach, exec, fork, freeze, rm, issue-token) — docker-like",
}

func init() {
	rootCmd.AddCommand(machineCmd)
}
