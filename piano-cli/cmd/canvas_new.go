package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/piano-app/piano-cli/internal/api"
	"github.com/piano-app/piano-cli/internal/render"
	"github.com/spf13/cobra"
)

var (
	newContent string
	newLabel   string
	newX       float64
	newY       float64
)

var canvasNewCmd = &cobra.Command{
	Use:   "new",
	Short: "Create a new TEXT node on my canvas",
	Long: `Creates a new TEXT-type node in the calling machine's arrangement.

Content comes from --content '…' or stdin if --content is omitted.
Position defaults to (0,0); the canvas will surface the node wherever its
viewport happens to be — pass --x and --y to place it explicitly.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		content := newContent
		if content == "" {
			// Only read stdin when it's actually piped — otherwise `piano canvas new`
			// with no flags would block forever waiting for the user to type something.
			stat, _ := os.Stdin.Stat()
			if stat != nil && (stat.Mode()&os.ModeCharDevice) == 0 {
				b, err := io.ReadAll(os.Stdin)
				if err != nil {
					return fmt.Errorf("read stdin: %w", err)
				}
				content = string(b)
			}
		}
		req := api.CreateNodeRequest{
			Content: content,
			Label:   newLabel,
			X:       newX,
			Y:       newY,
		}
		created, err := cc.CanvasCreate(req)
		if err != nil {
			return err
		}
		if jsonOutput {
			return render.JSON(created)
		}
		fmt.Println(created.ID)
		return nil
	},
}

func init() {
	canvasNewCmd.Flags().StringVar(&newContent, "content", "", "Initial content (default: stdin if piped, else empty)")
	canvasNewCmd.Flags().StringVar(&newLabel, "label", "", "Optional human-readable label")
	canvasNewCmd.Flags().Float64Var(&newX, "x", 0, "Canvas X coordinate")
	canvasNewCmd.Flags().Float64Var(&newY, "y", 0, "Canvas Y coordinate")
	canvasCmd.AddCommand(canvasNewCmd)
}
