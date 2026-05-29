package main

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

const defaultShell = "/usr/bin/zsh"

// StartPTY spawns a zsh shell inside a Podman container and returns the PTY master fd.
func StartPTY(machineId string, workdir string) (*os.File, *exec.Cmd, error) {
	if workdir == "" {
		workdir = os.Getenv("HOME")
	}
	cmd := ExecCommand(machineId, []string{defaultShell}, workdir)
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 200, Rows: 50})
	if err != nil {
		return nil, nil, err
	}
	return ptmx, cmd, nil
}

// KillProcess kills the shell process (the podman exec subprocess).
func KillProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
