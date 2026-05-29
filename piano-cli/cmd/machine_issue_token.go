package cmd

import (
	"fmt"
	"os"

	"github.com/piano-app/piano-cli/internal/api"
	"github.com/piano-app/piano-cli/internal/resolve"
	"github.com/spf13/cobra"
)

var machineIssueTokenCmd = &cobra.Command{
	Use:   "issue-token <machine>",
	Short: "Mint a bearer token for the canvas gateway (returns plaintext once)",
	Long: `Mints a fresh Authorization: Bearer token for the given machine.
The plaintext is printed to stdout once — copy it into the container as
PIANO_TOKEN so 'piano canvas *' can authenticate.

Requires a host-side login (run 'piano login' first).`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		// 1) Resolve the ref against the LOCAL daemon — that's where the
		// machine list lives. (Backend has no flat-list endpoint for V1.)
		id, err := resolve.MachineWith(client, args[0])
		if err != nil {
			return err
		}

		// 2) Mint via the BACKEND with the user's session cookies.
		userClient := api.NewUser(backendEndpoint())
		resp, err := userClient.MachineIssueCanvasToken(id)
		if err != nil {
			return err
		}

		// Print plaintext to stdout (so it pipes); helper text to stderr
		// (so it survives `$(piano machine issue-token x)` capture).
		fmt.Fprintf(os.Stderr,
			"Token for %s — copy this into the container as PIANO_TOKEN.\n"+
				"It will not be shown again.\n",
			resp.MachineID,
		)
		fmt.Println(resp.Token)
		return nil
	},
}

func init() {
	machineCmd.AddCommand(machineIssueTokenCmd)
}
