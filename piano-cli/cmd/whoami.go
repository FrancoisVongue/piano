package cmd

import (
	"fmt"

	"github.com/piano-app/piano-cli/internal/api"
	"github.com/spf13/cobra"
)

var whoamiCmd = &cobra.Command{
	Use:   "whoami",
	Short: "Show the currently signed-in user (or 'not logged in')",
	RunE: func(cmd *cobra.Command, args []string) error {
		c := api.NewUser(backendEndpoint())
		s, err := c.Whoami()
		if err != nil {
			return err
		}
		if s.User == nil {
			fmt.Println("not logged in")
			return nil
		}
		fmt.Println(s.User.Email)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(whoamiCmd)
}
