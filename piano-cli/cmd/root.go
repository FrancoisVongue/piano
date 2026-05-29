package cmd

import (
	"fmt"
	"os"

	"github.com/piano-app/piano-cli/internal/api"
	"github.com/spf13/cobra"
)

// State shared across subcommands. Set by PersistentPreRun on the root.
// Subcommands read these directly — no context.Value gymnastics.
var (
	client *api.Client

	jsonOutput bool
	endpoint   string
)

var rootCmd = &cobra.Command{
	Use:           "piano",
	Short:         "Piano — control your local daemon's machines from the terminal",
	SilenceUsage:  true,
	SilenceErrors: true,

	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		client = api.New(endpoint)
	},
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.PersistentFlags().BoolVar(&jsonOutput, "json", false, "Output as JSON instead of a table")
	rootCmd.PersistentFlags().StringVar(&endpoint, "endpoint", "", "Daemon HTTP endpoint (default: "+api.DaemonURL+")")
}
