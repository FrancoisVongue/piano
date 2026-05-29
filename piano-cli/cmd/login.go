package cmd

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/piano-app/piano-cli/internal/api"
	"github.com/piano-app/piano-cli/internal/config"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var loginEmail string

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Sign in to the backend (host-side, needed for token-issuing operations)",
	RunE: func(cmd *cobra.Command, args []string) error {
		email := loginEmail
		if email == "" {
			fmt.Print("Email: ")
			r := bufio.NewReader(os.Stdin)
			line, err := r.ReadString('\n')
			if err != nil {
				return err
			}
			email = strings.TrimSpace(line)
		}
		if email == "" {
			return fmt.Errorf("email is required")
		}

		fmt.Print("Password: ")
		pw, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil {
			return err
		}

		c := api.NewUser(backendEndpoint())
		resp, err := c.Login(email, string(pw))
		if err != nil {
			return err
		}
		if err := config.SaveCookies(c.Jar(), c.Endpoint()); err != nil {
			return fmt.Errorf("save cookies: %w", err)
		}

		who := resp.User.Email
		if who == "" {
			who = email
		}
		fmt.Printf("Logged in as %s\n", who)
		return nil
	},
}

func init() {
	loginCmd.Flags().StringVar(&loginEmail, "email", "", "Email (prompts if omitted)")
	rootCmd.AddCommand(loginCmd)
}
