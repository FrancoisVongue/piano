// Package sshx is a thin wrapper around the system `ssh` binary. The
// daemon's SSH gateway already does the heavy lifting (PTY allocation,
// terminal resize, port forwarding) — the CLI just needs to compose the
// right argv and exec.
package sshx

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
)

// Defaults for V1 — local daemon, fixed gateway. The daemon's SSH gateway
// always binds 0.0.0.0:2200 (see daemon/ssh_gateway.go:32), so for a
// localhost-only CLI these are constants, not config.
const (
	DefaultHost = "localhost"
	DefaultPort = 2200
)

type Target struct {
	Host string
	Port int
	User string // = machineId for piano's gateway
}

// LocalTarget builds a Target pointing at the local daemon's SSH gateway
// for the given machine id. Callers that just want the local default
// shouldn't have to spell out the host/port every time.
func LocalTarget(machineID string) Target {
	return Target{Host: DefaultHost, Port: DefaultPort, User: machineID}
}

// Run execs `ssh -p <port> <user>@<host> [cmd...]` and inherits stdio.
// With no cmd, ssh auto-allocates a PTY because stdin is the user's
// terminal. With a cmd, ssh runs non-interactively unless `forceTTY`
// (mapped to ssh's -t) is set.
func Run(t Target, cmdArgs []string, forceTTY bool) error {
	args := []string{
		"-p", strconv.Itoa(t.Port),
		// Generated keys can rotate when the daemon restarts in dev. accept-new
		// lets first contact succeed while still failing on later key mismatch
		// (the actual "someone is MITM-ing you" case).
		"-o", "StrictHostKeyChecking=accept-new",
	}
	if forceTTY {
		args = append(args, "-t")
	}
	args = append(args, t.User+"@"+t.Host)
	args = append(args, cmdArgs...)

	cmd := exec.Command("ssh", args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		// ssh's non-zero exit shouldn't print "exit status N" — the underlying
		// command already wrote whatever it wanted. Pass the code through.
		var ee *exec.ExitError
		if asExitError(err, &ee) {
			os.Exit(ee.ExitCode())
		}
		return fmt.Errorf("ssh: %w", err)
	}
	return nil
}

// asExitError is a one-line errors.As wrapper kept inline for readability.
func asExitError(err error, target **exec.ExitError) bool {
	if e, ok := err.(*exec.ExitError); ok {
		*target = e
		return true
	}
	return false
}
