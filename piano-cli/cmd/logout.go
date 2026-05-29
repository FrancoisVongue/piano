package cmd

import (
	"fmt"

	"github.com/piano-app/piano-cli/internal/api"
	"github.com/piano-app/piano-cli/internal/config"
	"github.com/spf13/cobra"
)

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Sign out and clear local credentials",
	RunE: func(cmd *cobra.Command, args []string) error {
		c := api.NewUser(backendEndpoint())
		_ = c.Logout() // best-effort; clearing local cookies is what matters
		if err := config.ClearCookies(); err != nil {
			return err
		}
		fmt.Println("Logged out.")
		return nil
	},
}

func init() {
	rootCmd.AddCommand(logoutCmd)
}
