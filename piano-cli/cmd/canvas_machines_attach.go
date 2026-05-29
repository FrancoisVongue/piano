package cmd

import (
	"fmt"
	"os"

	"github.com/piano-app/piano-cli/internal/wsterm"
	"github.com/spf13/cobra"
)

var canvasMachinesAttachCmd = &cobra.Command{
	Use:   "attach <machine-id>",
	Short: "Open an interactive shell on a peer machine (docker-attach equivalent)",
	Long: `Opens a fresh interactive PTY session on the peer's container — the
docker exec -it equivalent for cross-machine work. The session is one-off:
when the WebSocket closes (Ctrl+D / closed terminal), the daemon-side
shell exits and the session id is invalidated.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		token := os.Getenv("PIANO_TOKEN")
		if token == "" {
			return fmt.Errorf("PIANO_TOKEN env required — issue one on the host with 'piano machine issue-token <machine>'")
		}
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		session, err := cc.CanvasMachinesAttachStart(args[0])
		if err != nil {
			return err
		}
		// Hand off to the wsterm bridge — same token authorises the WS.
		return wsterm.Bridge(backendEndpoint(), session.WsPath, token)
	},
}

func init() {
	canvasMachinesCmd.AddCommand(canvasMachinesAttachCmd)
}
