package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

const (
	green  = "\033[32m"
	red    = "\033[31m"
	yellow = "\033[33m"
	cyan   = "\033[36m"
	bold   = "\033[1m"
	reset  = "\033[0m"
)

func ok(msg string)   { fmt.Printf("  %s✓%s %s\n", green, reset, msg) }
func fail(msg string) { fmt.Printf("  %s✗%s %s\n", red, reset, msg) }
func warn(msg string) { fmt.Printf("  %s!%s %s\n", yellow, reset, msg) }
func info(msg string) { fmt.Printf("  %s→%s %s\n", cyan, reset, msg) }

// Preflight checks system dependencies.
func Preflight() error {
	fmt.Printf("\n%s%s piano-daemon preflight%s\n\n", bold, cyan, reset)

	if runtime.GOOS != "linux" {
		return fmt.Errorf("piano-daemon requires Linux (got %s)", runtime.GOOS)
	}
	ok("linux")

	if os.Geteuid() != 0 {
		return fmt.Errorf("piano-daemon must run as root (sudo)")
	}
	ok("running as root")

	if !hasCommand("podman") {
		return fmt.Errorf("podman not found — install with: apt install podman")
	}
	ok(fmt.Sprintf("podman (%s)", commandVersion("podman", "--version")))

	if !hasCommand("crun") {
		return fmt.Errorf("crun not found — install with: apt install crun")
	}
	ok(fmt.Sprintf("crun (%s)", commandVersion("crun", "--version")))

	if !hasCommand("mkfs.btrfs") {
		return fmt.Errorf("mkfs.btrfs not found — install with: apt install btrfs-progs")
	}
	ok("btrfs-progs (mkfs.btrfs available)")

	// inotify instances: Turbopack/webpack/nodemon need many inotify instances.
	// inotify_init() returns EMFILE ("Too many open files") when this is exhausted.
	const minInotifyInstances = 512
	if instances, err := readSysctl("fs/inotify/max_user_instances"); err == nil {
		if instances < minInotifyInstances {
			warn(fmt.Sprintf("inotify max_user_instances=%d (low — recommend %d+)", instances, minInotifyInstances))
			info(fmt.Sprintf("fix: sudo sysctl fs.inotify.max_user_instances=%d", minInotifyInstances))
		} else {
			ok(fmt.Sprintf("inotify max_user_instances=%d", instances))
		}
	}

	fmt.Println()
	return nil
}

func hasCommand(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func readSysctl(path string) (int, error) {
	data, err := os.ReadFile("/proc/sys/" + path)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(data)))
}

func commandVersion(name string, args ...string) string {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return "unknown"
	}
	v := string(out)
	if len(v) > 40 {
		v = v[:40]
	}
	for len(v) > 0 && (v[len(v)-1] == '\n' || v[len(v)-1] == '\r') {
		v = v[:len(v)-1]
	}
	return v
}
