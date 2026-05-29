package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const containerPrefix = "piano-"

// CreateContainerOpts customizes Podman run flags.
type CreateContainerOpts struct {
	EnvVars  []string // e.g. ["HOME=/home/user", "USER=user"]
	Workdir  string   // e.g. "/home/user"
	Volumes  []string // raw -v specs
	Hostname string   // optional container hostname shown in shell prompts
}

func containerName(machineId string) string {
	return containerPrefix + machineId
}

func normalizeHostname(raw string) string {
	raw = strings.ToLower(strings.TrimSpace(raw))
	var b strings.Builder
	lastHyphen := false
	for _, r := range raw {
		isAlnum := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if isAlnum {
			b.WriteRune(r)
			lastHyphen = false
			continue
		}
		if !lastHyphen && b.Len() > 0 {
			b.WriteByte('-')
			lastHyphen = true
		}
	}
	hostname := strings.Trim(b.String(), "-")
	if len(hostname) > 32 {
		hostname = strings.TrimRight(hostname[:32], "-")
	}
	return hostname
}

func hostnameOrFallback(raw string, fallback string) string {
	hostname := normalizeHostname(raw)
	if hostname == "" {
		hostname = normalizeHostname(fallback)
	}
	if hostname == "" {
		return "piano"
	}
	return hostname
}

// CreateContainer creates and starts a rootful container using --rootfs.
// No user namespace — daemon runs as root, container runs as root.
// Exec sessions use --user to run as the host user.
func CreateContainer(machineId string, mergedDir string, opts CreateContainerOpts) (string, error) {
	name := containerName(machineId)
	hostname := hostnameOrFallback(opts.Hostname, machineId)

	args := []string{
		"run", "-d",
		"--init",
		"--privileged",
		"--ulimit", "nofile=65535:65535",
		"--name", name,
		"--hostname", hostname,
		"--add-host", hostname + ":127.0.0.1",
	}
	for _, kv := range opts.EnvVars {
		args = append(args, "-e", kv)
	}
	for _, v := range opts.Volumes {
		args = append(args, "-v", v)
	}
	if opts.Workdir != "" {
		args = append(args, "--workdir", opts.Workdir)
	}
	// Entrypoint: start podman API socket (for docker-compose/Tilt), then sleep.
	// No sudo needed — container runs as root.
	args = append(args,
		"--rootfs", mergedDir,
		"sh", "-c",
		"mkdir -p /run/podman && podman system migrate && podman system service --time=0 unix:///run/podman/podman.sock & sleep 1 && chmod 666 /run/podman/podman.sock; exec sleep infinity",
	)

	out, err := exec.Command("podman", args...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("podman run --rootfs: %w\noutput: %s", err, out)
	}

	containerID := strings.TrimSpace(string(out))
	log.Printf("[podman] container %s created (rootfs: %s)", name, mergedDir)
	return containerID, nil
}

// ErrPauseUnsupported signals the runtime has no cgroup available for this container
// (e.g. podman configured with cgroups = "disabled"). Callers should degrade gracefully.
var ErrPauseUnsupported = errors.New("container pause unsupported (no cgroup)")

// isNoCgroupErr detects podman's "cannot pause without using Cgroups" message.
func isNoCgroupErr(out []byte, err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(string(out))
	return strings.Contains(s, "without using cgroups") ||
		strings.Contains(s, "does not have a cgroup")
}

// PauseContainer freezes all processes in a container via cgroups freezer.
// Used during hot branching to get a consistent snapshot of the upper dir.
// Returns ErrPauseUnsupported when the container has no cgroup.
func PauseContainer(machineId string) error {
	out, err := exec.Command("podman", "pause", containerName(machineId)).CombinedOutput()
	if err != nil {
		if isNoCgroupErr(out, err) {
			return ErrPauseUnsupported
		}
		return fmt.Errorf("podman pause: %w\noutput: %s", err, out)
	}
	return nil
}

// UnpauseContainer resumes a paused container.
func UnpauseContainer(machineId string) error {
	out, err := exec.Command("podman", "unpause", containerName(machineId)).CombinedOutput()
	if err != nil {
		if isNoCgroupErr(out, err) {
			return ErrPauseUnsupported
		}
		return fmt.Errorf("podman unpause: %w\noutput: %s", err, out)
	}
	return nil
}

// PauseContainerByID freezes a container directly via its cgroup freezer file,
// avoiding the ~30-50ms podman CLI fork. Falls back to PauseContainer on error.
// Returns ErrPauseUnsupported if neither method can pause (no cgroup available).
func PauseContainerByID(containerID, machineId string) error {
	if containerID != "" {
		err := FreezeCgroup(containerID)
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrFreezerUnavailable) {
			log.Printf("[podman] cgroup freeze failed, falling back to CLI: %v", err)
		}
	}
	return PauseContainer(machineId)
}

// UnpauseContainerByID thaws a container directly via its cgroup freezer file.
// Falls back to UnpauseContainer on error.
func UnpauseContainerByID(containerID, machineId string) error {
	if containerID != "" {
		err := UnfreezeCgroup(containerID)
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrFreezerUnavailable) {
			log.Printf("[podman] cgroup thaw failed, falling back to CLI: %v", err)
		}
	}
	return UnpauseContainer(machineId)
}

// ExecCommand returns a podman exec command that runs as the host user.
// Container runs as root, but exec sessions use --user uid:gid.
func ExecCommand(machineId string, command []string, workdir string) *exec.Cmd {
	uid, gid, name, home := hostUser()
	if workdir == "" {
		workdir = home
	}
	args := []string{
		"exec", "-it",
		"--user", fmt.Sprintf("%d:%d", uid, gid),
		"-w", workdir,
		"-e", "LANG=C.UTF-8",
		"-e", "HOME=" + home,
		"-e", "USER=" + name,
		containerName(machineId),
	}
	args = append(args, command...)
	cmd := exec.Command("podman", args...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	return cmd
}

// ExecCommandNonInteractive is like ExecCommand but without -it flags.
// Used by SSH Gateway where stdin/stdout are piped through SSH channels.
func ExecCommandNonInteractive(machineId string, command []string, workdir string) *exec.Cmd {
	uid, gid, name, home := hostUser()
	if workdir == "" {
		workdir = home
	}
	args := []string{
		"exec", "-i",
		"--user", fmt.Sprintf("%d:%d", uid, gid),
		"-w", workdir,
		"-e", "LANG=C.UTF-8",
		"-e", "HOME=" + home,
		"-e", "USER=" + name,
		containerName(machineId),
	}
	args = append(args, command...)
	cmd := exec.Command("podman", args...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	return cmd
}

func StopContainer(machineId string) error {
	out, err := exec.Command("podman", "stop", "-t", "5", containerName(machineId)).CombinedOutput()
	if err != nil {
		return fmt.Errorf("podman stop: %w\noutput: %s", err, out)
	}
	return nil
}

func RemoveContainer(machineId string) error {
	out, err := exec.Command("podman", "rm", "-f", containerName(machineId)).CombinedOutput()
	if err != nil {
		return fmt.Errorf("podman rm: %w\noutput: %s", err, out)
	}
	log.Printf("[podman] container %s removed", containerName(machineId))
	return nil
}

func ContainerIP(machineId string) (string, error) {
	out, err := exec.Command("podman", "inspect",
		"--format", "{{.NetworkSettings.IPAddress}}",
		containerName(machineId),
	).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("podman inspect ip: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

func ContainerPID(machineId string) (int, error) {
	out, err := exec.Command("podman", "inspect",
		"--format", "{{.State.Pid}}",
		containerName(machineId),
	).CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("podman inspect pid: %w", err)
	}
	var pid int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(out)), "%d", &pid); err != nil {
		return 0, fmt.Errorf("parse pid: %w", err)
	}
	return pid, nil
}

// ContainerPIDFast reads the container PID from the podman pidfile, avoiding
// the ~30ms podman inspect CLI fork. Callers should fall back to ContainerPID
// if this returns an error (e.g. non-standard storage layout).
func ContainerPIDFast(containerID string) (int, error) {
	pidfile := filepath.Join("/run/containers/storage/overlay-containers",
		containerID, "userdata", "pidfile")
	data, err := os.ReadFile(pidfile)
	if err != nil {
		return 0, err
	}
	var pid int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(data)), "%d", &pid); err != nil {
		return 0, fmt.Errorf("parse pid: %w", err)
	}
	return pid, nil
}

func ContainerExists(machineId string) bool {
	return exec.Command("podman", "container", "exists", containerName(machineId)).Run() == nil
}

func WriteToContainer(machineId string, filePath string, content string) error {
	cmd := exec.Command("podman", "exec", "-i", containerName(machineId),
		"sh", "-c", fmt.Sprintf("cat > %s", filePath))
	cmd.Stdin = strings.NewReader(content)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("write to container: %w\noutput: %s", err, out)
	}
	return nil
}

func DetectPortsInContainer(machineId string) []int {
	// -p adds the `users:((...))` column so we can filter out "ghost" listeners
	// that leak in from a shared netns (e.g. the daemon's own host-side port
	// forward listeners). Rows without a user process attached are not real
	// services inside this container.
	out, err := exec.Command("podman", "exec", containerName(machineId),
		"ss", "-tlnHp",
	).CombinedOutput()
	if err != nil {
		return nil
	}
	seen := make(map[int]bool)
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "users:((") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		idx := strings.LastIndex(fields[3], ":")
		if idx < 0 {
			continue
		}
		port, err := strconv.Atoi(fields[3][idx+1:])
		if err != nil || port == 0 {
			continue
		}
		// Drop SSH gateway / sshd itself — noise, not a user service.
		if port == 22 || port == 2200 {
			continue
		}
		seen[port] = true
	}
	var ports []int
	for p := range seen {
		ports = append(ports, p)
	}
	return ports
}

func ContainerState(machineId string) string {
	out, err := exec.Command("podman", "inspect",
		"--format", "{{.State.Status}}",
		containerName(machineId),
	).CombinedOutput()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func ListContainers() []string {
	out, err := exec.Command("podman", "ps", "-a",
		"--filter", "name=^"+containerPrefix,
		"--format", "json",
	).CombinedOutput()
	if err != nil {
		return nil
	}
	var containers []struct {
		Names []string `json:"Names"`
	}
	if err := json.Unmarshal(out, &containers); err != nil {
		return nil
	}
	var ids []string
	for _, c := range containers {
		for _, name := range c.Names {
			id := strings.TrimPrefix(name, containerPrefix)
			if id != name {
				ids = append(ids, id)
			}
		}
	}
	return ids
}
