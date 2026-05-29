package cmd

import (
	"strconv"

	"github.com/piano-app/piano-cli/internal/api"
	"github.com/piano-app/piano-cli/internal/render"
	"github.com/spf13/cobra"
)

var canvasListCmd = &cobra.Command{
	Use:     "ls",
	Aliases: []string{"list"},
	Short:   "List all nodes on my canvas",
	RunE: func(cmd *cobra.Command, args []string) error {
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		nodes, err := cc.CanvasList()
		if err != nil {
			return err
		}
		if jsonOutput {
			return render.JSON(nodes)
		}
		return render.Table(nodes, []render.Column[api.CanvasNode]{
			{Header: "NAME", Get: func(n api.CanvasNode) string { return n.DisplayName() }},
			{Header: "ID", Get: func(n api.CanvasNode) string { return n.ID }},
			{Header: "TYPE", Get: func(n api.CanvasNode) string { return n.Type }},
			{Header: "VER", Get: func(n api.CanvasNode) string { return strconv.Itoa(n.Version) }},
			{Header: "CONTENT", Get: func(n api.CanvasNode) string { return preview(n.Content, 60) }},
		})
	},
}

// preview clips a content string for the LIST column — full body is available
// via `piano canvas cat <id>`.
func preview(s string, n int) string {
	// Replace newlines so the row stays on one line in the table.
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r == '\n' || r == '\r' || r == '\t' {
			out = append(out, ' ')
			continue
		}
		out = append(out, r)
	}
	if len(out) > n {
		return string(out[:n-1]) + "…"
	}
	return string(out)
}

func init() {
	canvasCmd.AddCommand(canvasListCmd)
}
