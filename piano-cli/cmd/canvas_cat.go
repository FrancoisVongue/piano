package cmd

import (
	"fmt"

	"github.com/piano-app/piano-cli/internal/render"
	"github.com/spf13/cobra"
)

var (
	catMeta bool
	catRaw  bool
)

var canvasCatCmd = &cobra.Command{
	Use:   "cat <node-id>",
	Short: "Read a node — `+<id>` references resolved and inlined by default",
	Long: `Reads a node's content. By default the backend walks every
`+ "`+<id>`" + ` reference in the content forward and inlines it (the PULL
model — resolution happens at read time, never on write).

  --raw    print the content verbatim, with bare `+ "`+<id>`" + ` markers
  --meta   print the full row as JSON (id, version, resolvedContent, ...)`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		node, err := cc.CanvasGet(args[0], catRaw)
		if err != nil {
			return err
		}
		if jsonOutput || catMeta {
			return render.JSON(node)
		}
		if catRaw {
			fmt.Println(node.Content)
			return nil
		}
		// Resolved is the default. ResolvedContent is non-nil for a
		// non-raw read; the Content fallback only fires if the backend
		// somehow skipped resolution.
		if node.ResolvedContent != nil {
			fmt.Println(*node.ResolvedContent)
		} else {
			fmt.Println(node.Content)
		}
		return nil
	},
}

func init() {
	canvasCatCmd.Flags().BoolVar(&catMeta, "meta", false, "Print the full row as JSON")
	canvasCatCmd.Flags().BoolVar(&catRaw, "raw", false, "Print raw content without resolving +<id> references")
	canvasCmd.AddCommand(canvasCatCmd)
}
