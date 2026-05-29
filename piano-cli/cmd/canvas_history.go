package cmd

import (
	"github.com/piano-app/piano-cli/internal/api"
	"github.com/piano-app/piano-cli/internal/render"
	"github.com/spf13/cobra"
)

var canvasHistoryCmd = &cobra.Command{
	Use:     "history <node-id>",
	Aliases: []string{"versions"},
	Short:   "List stored snapshots of a node (newest first, capped at 4)",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cc, err := canvasClient()
		if err != nil {
			return err
		}
		versions, err := cc.CanvasHistory(args[0])
		if err != nil {
			return err
		}
		if jsonOutput {
			return render.JSON(versions)
		}
		return render.Table(versions, []render.Column[api.NoteVersion]{
			{Header: "VERSION-ID", Get: func(v api.NoteVersion) string { return v.ID }},
			{Header: "CREATED", Get: func(v api.NoteVersion) string { return v.CreatedAt }},
			{Header: "AUTHOR", Get: func(v api.NoteVersion) string {
				if v.Author == nil {
					return "-"
				}
				return *v.Author
			}},
			{Header: "CONTENT", Get: func(v api.NoteVersion) string { return preview(v.Content, 60) }},
		})
	},
}

func init() {
	canvasCmd.AddCommand(canvasHistoryCmd)
}
