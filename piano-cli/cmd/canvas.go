package cmd

import (
	"fmt"
	"os"

	"github.com/piano-app/piano-cli/internal/api"
	"github.com/spf13/cobra"
)

var canvasCmd = &cobra.Command{
	Use:     "canvas",
	Aliases: []string{"c"},
	Short:   "Read / write the canvas this machine lives on (run from inside a machine)",
	Long: `Canvas commands let an agent INSIDE a piano machine see and edit
its arrangement — the nodes around it, their content, their positions —
like a tiny filesystem onto the canvas.

References (the +<id> primitive):

  A node's content can import other nodes with a whitespace-prefixed
  token, e.g.   "my inbox\n+engineering_chat\n+founder_log".
  When you read a node ('piano canvas cat <id>'), the backend walks those
  references forward and inlines them — resolution happens at READ time,
  never on write. There's no push, no subscription state: a node
  "subscribes" simply by listing +refs you choose to read.

  Unresolved tokens (no such node, a cycle, too deep) are left verbatim,
  so a stray "+foo" is harmless. Use 'cat --raw' to see tokens unresolved.
  Build a subscription manifest with 'write --append --content "+chan"'.

These commands require:

  PIANO_TOKEN     bearer token issued by 'piano machine issue-token <machine>'
                  on the host. Whoever holds this token speaks AS that
                  machine to the canvas API.

  PIANO_BACKEND   backend URL (default: http://localhost:3009)

Both are normally injected by the daemon when the machine starts. In
local dev you set them by hand against a running backend.`,
}

// canvasClient builds an HTTP client that auto-stamps Authorization:
// Bearer on every request. Called by every canvas_*.go subcommand.
func canvasClient() (*api.Client, error) {
	token := os.Getenv("PIANO_TOKEN")
	if token == "" {
		return nil, fmt.Errorf("PIANO_TOKEN env required — issue one on the host with 'piano machine issue-token <machine>'")
	}
	return api.NewCanvas(backendEndpoint(), token), nil
}

func init() {
	rootCmd.AddCommand(canvasCmd)
}
