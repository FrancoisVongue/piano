package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/piano-app/piano-cli/internal/api"
	"github.com/piano-app/piano-cli/internal/render"
	"github.com/spf13/cobra"
)

var (
	writeContent string
	writeVersion int
	writeAppend  bool
)

var canvasWriteCmd = &cobra.Command{
	Use:   "write <node-id>",
	Short: "Update a node's content (stdin by default, --content '...' otherwise)",
	Long: `Reads new content from stdin (or --content) and PATCHes the node.

By default this command first GETs the node to learn its current version,
then writes — convenient but race-prone if another writer (human or AI)
touches the same node concurrently. Pass --version=<n> to assert the
version you expect; mismatch returns a 409 with the current row so the
caller can re-read and retry.

--append concatenates onto the node's existing content (newline-joined)
instead of replacing it. Handy for subscription manifests:

  piano canvas write my_inbox --append --content "+engineering_chat"`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cc, err := canvasClient()
		if err != nil {
			return err
		}

		// Resolve the new content: --content wins, otherwise consume stdin.
		content := writeContent
		if content == "" {
			b, err := io.ReadAll(os.Stdin)
			if err != nil {
				return fmt.Errorf("read stdin: %w", err)
			}
			content = string(b)
		}

		// One raw GET covers both needs: the current version (for the
		// optimistic check) and, for --append, the existing body to
		// concatenate onto. Raw because resolution would be wasted work.
		version := writeVersion
		if writeAppend || version == 0 {
			cur, err := cc.CanvasGet(args[0], true)
			if err != nil {
				return err
			}
			if version == 0 {
				version = cur.Version
			}
			if writeAppend {
				// Empty node → write content as-is (no stray leading newline).
				if base := strings.TrimRight(cur.Content, "\n"); base != "" {
					content = base + "\n" + content
				}
			}
		}

		updated, err := cc.CanvasUpdate(args[0], api.UpdateNodeRequest{
			ExpectedVersion: version,
			Content:         &content,
		})
		if err != nil {
			return err
		}
		if jsonOutput {
			return render.JSON(updated)
		}
		fmt.Fprintf(os.Stderr, "Updated %s (v%d → v%d)\n", updated.ID, version, updated.Version)
		return nil
	},
}

func init() {
	canvasWriteCmd.Flags().StringVar(&writeContent, "content", "", "Content to write (default: read from stdin)")
	canvasWriteCmd.Flags().IntVar(&writeVersion, "version", 0, "Expected version (0 = auto-read current)")
	canvasWriteCmd.Flags().BoolVar(&writeAppend, "append", false, "Append to existing content (newline-joined) instead of replacing")
	canvasCmd.AddCommand(canvasWriteCmd)
}
