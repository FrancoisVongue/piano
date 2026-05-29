package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// HostTemplateSentinel is the reserved templateId for backward compatibility.
const HostTemplateSentinel = "host-template"

// ContainerOpts returns the Podman run flags for a machine.
// Daemon runs as root (sudo). Container runs as root but exec sessions
// use --user to run as the host user.
func ContainerOpts(layersDir, machineId string) CreateContainerOpts {
	home := os.Getenv("PIANO_USER_HOME")
	userName := os.Getenv("PIANO_USER_NAME")
	homeMerged := filepath.Join(layersDir, machineId, "home-merged")

	return CreateContainerOpts{
		EnvVars: []string{"HOME=" + home, "USER=" + userName},
		Workdir: home,
		Volumes: []string{fmt.Sprintf("%s:%s", homeMerged, home)},
	}
}

// hostUser returns the UID, GID, username and home of the real host user.
// Set by main() from PIANO_USER_* env vars (passed before sudo).
func hostUser() (uid, gid int, name, home string) {
	name = os.Getenv("PIANO_USER_NAME")
	home = os.Getenv("PIANO_USER_HOME")
	uid, _ = strconv.Atoi(os.Getenv("PIANO_USER_UID"))
	gid, _ = strconv.Atoi(os.Getenv("PIANO_USER_GID"))
	if name == "" || home == "" {
		// Fallback: look up the real user (not root)
		if u, err := user.Lookup(os.Getenv("SUDO_USER")); err == nil {
			name = u.Username
			home = u.HomeDir
			uid, _ = strconv.Atoi(u.Uid)
			gid, _ = strconv.Atoi(u.Gid)
		}
	}
	return
}

// addUserToRootfs adds the host user to /etc/passwd, /etc/shadow, /etc/group
// in the overlay upper dir so the user exists inside the container.
func addUserToRootfs(upperDir string) {
	uid, gid, name, home := hostUser()
	if name == "" {
		return
	}

	passwdEntry := fmt.Sprintf("%s:x:%d:%d:%s:%s:/usr/bin/zsh\n", name, uid, gid, name, home)
	shadowEntry := fmt.Sprintf("%s:*:19000:0:99999:7:::\n", name)
	groupEntry := fmt.Sprintf("%s:x:%d:\n", name, gid)

	// Copy base files to upper, then append user entry.
	// Must copy first — if upper has a file, overlay hides the base version.
	for _, entry := range []struct {
		file, line string
		mode       os.FileMode
	}{
		{"etc/passwd", passwdEntry, 0644},
		{"etc/shadow", shadowEntry, 0640},
		{"etc/group", groupEntry, 0644},
	} {
		upperPath := filepath.Join(upperDir, entry.file)
		os.MkdirAll(filepath.Dir(upperPath), 0755)

		// Copy from base rootfs if not already in upper
		if _, err := os.Stat(upperPath); err != nil {
			basePath := filepath.Join(baseRootfs, entry.file)
			if data, err := os.ReadFile(basePath); err == nil {
				os.WriteFile(upperPath, data, entry.mode)
			}
		}

		f, err := os.OpenFile(upperPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, entry.mode)
		if err != nil {
			log.Printf("[overlay] failed to write %s: %v", upperPath, err)
			continue
		}
		f.WriteString(entry.line)
		f.Close()
	}
}

// btrfsSnapshot creates an O(1) BTRFS subvolume snapshot.
// Unlike cp --reflink (which is O(files)), this is a single atomic metadata
// operation regardless of how many files the source contains.
func btrfsSnapshot(src, dst string) error {
	start := time.Now()
	out, err := exec.Command("btrfs", "subvolume", "snapshot", src, dst).CombinedOutput()
	if err != nil {
		return fmt.Errorf("btrfs snapshot %s -> %s: %w\noutput: %s", src, dst, err, out)
	}
	log.Printf("[btrfs] snapshot %s -> %s (%v)", filepath.Base(src), filepath.Base(dst), time.Since(start))
	return nil
}

// btrfsSubvolumeCreate creates a new BTRFS subvolume at the given path.
func btrfsSubvolumeCreate(path string) error {
	out, err := exec.Command("btrfs", "subvolume", "create", path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("btrfs subvolume create %s: %w\noutput: %s", path, err, out)
	}
	return nil
}

// btrfsSubvolumeDelete deletes a BTRFS subvolume. No-op if path doesn't exist.
func btrfsSubvolumeDelete(path string) {
	if _, err := os.Stat(path); err != nil {
		return
	}
	out, err := exec.Command("btrfs", "subvolume", "delete", path).CombinedOutput()
	if err != nil {
		log.Printf("[btrfs] subvolume delete %s: %v\noutput: %s", path, err, out)
	}
}

// mountHomeOverlay mounts the $HOME overlay with flat architecture.
// lowerdir is just the host $HOME. All inherited state lives in home-upper.
func mountHomeOverlay(layersDir, machineId string) error {
	uid, gid, _, home := hostUser()
	if home == "" {
		return fmt.Errorf("host user home not set")
	}

	base := filepath.Join(layersDir, machineId)
	upperDir := filepath.Join(base, "home-upper")
	workDir := filepath.Join(base, "home-work")
	mergedDir := filepath.Join(base, "home-merged")
	os.MkdirAll(upperDir, 0755)
	// Clean work dir — may have stale state from parent snapshot.
	os.RemoveAll(workDir)
	os.MkdirAll(workDir, 0755)
	os.MkdirAll(mergedDir, 0755)
	// home-upper must be owned by the host user so writes from exec
	// sessions (--user uid:gid) succeed (e.g. .zsh_history).
	os.Chown(upperDir, uid, gid)

	// Seed a default ~/.zshrc into the machine's upper overlay if the host
	// has none. This (a) skips zsh's first-run wizard and (b) gives every
	// machine a sensible baseline (oh-my-zsh + a couple of plugins + git
	// aliases). Host $HOME stays untouched. If the user later puts a real
	// ~/.zshrc on their host, NEW machines will use that instead (the stub
	// is per-machine, written to the overlay's upper dir, not host-wide).
	hostZshrc := filepath.Join(home, ".zshrc")
	if _, err := os.Stat(hostZshrc); os.IsNotExist(err) {
		upperZshrc := filepath.Join(upperDir, ".zshrc")
		if _, err := os.Stat(upperZshrc); os.IsNotExist(err) {
			stub := []byte(defaultZshrc)
			if err := os.WriteFile(upperZshrc, stub, 0644); err == nil {
				os.Chown(upperZshrc, uid, gid)
			}
		}
	}

	// Shadow host docker binaries in $HOME/bin with symlinks to our wrapper
	binDir := filepath.Join(upperDir, "bin")
	for _, name := range []string{"docker", "docker-compose"} {
		hostBin := filepath.Join(home, "bin", name)
		if _, err := os.Stat(hostBin); err == nil {
			os.MkdirAll(binDir, 0755)
			link := filepath.Join(binDir, name)
			os.Remove(link)
			os.Symlink("/usr/local/bin/podman", link)
		}
	}

	return MountOverlay([]string{home}, upperDir, workDir, mergedDir)
}

// unmountHomeOverlay tears down the home-merged mount point.
func unmountHomeOverlay(layersDir, machineId string) error {
	return UnmountOverlay(filepath.Join(layersDir, machineId, "home-merged"))
}

// MountOverlay mounts a kernel overlay filesystem.
func MountOverlay(lowerDirs []string, upperDir, workDir, mergedDir string) error {
	_ = exec.Command("umount", mergedDir).Run()

	opts := fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s",
		strings.Join(lowerDirs, ":"), upperDir, workDir)

	cmd := exec.Command("mount", "-t", "overlay", "overlay", "-o", opts, mergedDir)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("overlay mount: %w\noutput: %s", err, out)
	}
	return nil
}

// UnmountOverlay unmounts an overlay. Retries once on EBUSY.
func UnmountOverlay(mergedDir string) error {
	out, err := exec.Command("umount", mergedDir).CombinedOutput()
	if err == nil {
		return nil
	}
	if strings.Contains(string(out), "busy") {
		time.Sleep(500 * time.Millisecond)
		out, err = exec.Command("umount", mergedDir).CombinedOutput()
		if err == nil {
			return nil
		}
	}
	return fmt.Errorf("umount %s: %w\noutput: %s", mergedDir, err, out)
}

var baseBuildInputs = []string{
	"Containerfile.machine",
	"env/packages.txt",
}

func computeBaseBuildHash() (string, error) {
	h := sha256.New()
	for _, path := range baseBuildInputs {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", path, err)
		}
		h.Write([]byte(path))
		h.Write([]byte{'\n'})
		h.Write(data)
		h.Write([]byte{'\n'})
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// baseContainerName is the persistent container whose mounted rootfs serves
// as the lowerdir for all machine overlays. No export/tar — just podman mount.
const baseContainerName = "piano-base-layer"

// PrepareBaseLayer builds the piano-base image and extracts its rootfs to BTRFS.
// The extracted rootfs is used as overlay lowerdir. Lives on the same BTRFS volume
// as machine uppers to avoid overlayfs-on-overlayfs cross-device errors.
func PrepareBaseLayer(layersDir string) error {
	hashFile := filepath.Join(layersDir, "base.build-hash")

	currentHash, hashErr := computeBaseBuildHash()

	// Check if base container already exists and is up to date
	if exec.Command("podman", "container", "exists", baseContainerName).Run() == nil {
		if hashErr != nil {
			log.Printf("[overlay] base container exists (hash check skipped: %v)", hashErr)
			return ensureBaseExtracted()
		}
		prev, _ := os.ReadFile(hashFile)
		if string(prev) == currentHash {
			log.Println("[overlay] base layer up to date")
			return ensureBaseExtracted()
		}
		log.Printf("[overlay] base layer is stale — rebuilding")
		exec.Command("podman", "rm", "-f", baseContainerName).Run()
		// Remove old extracted rootfs so it gets re-extracted from new image.
		os.RemoveAll(filepath.Join(layersDir, "base-rootfs"))
	}

	log.Println("[overlay] building base image...")
	build := exec.Command("podman", "build", "-t", "piano-base:latest",
		"-f", "Containerfile.machine", "env/")
	build.Stdout = os.Stdout
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		return fmt.Errorf("build base image: %w", err)
	}

	log.Println("[overlay] creating base container...")
	out, err := exec.Command("podman", "create", "--replace", "--name", baseContainerName,
		"piano-base:latest", "/bin/true").CombinedOutput()
	if err != nil {
		return fmt.Errorf("create base container: %w\noutput: %s", err, out)
	}

	if hashErr == nil {
		if err := os.WriteFile(hashFile, []byte(currentHash), 0644); err != nil {
			log.Printf("[overlay] failed to save build hash: %v", err)
		}
	}

	return ensureBaseExtracted()
}

// ensureBaseExtracted exports the base container's rootfs to a directory on BTRFS.
// Unlike "podman mount" (which returns an overlayfs path), this creates a flat directory
// on the same BTRFS filesystem as machine uppers — avoiding overlayfs-on-overlayfs
// stacking which causes EXDEV (cross-device link) errors.
func ensureBaseExtracted() error {
	baseRootfs = filepath.Join(layersDir, "base-rootfs")

	// Extraction publishes atomically (extract into .incoming, then rename), so
	// base-rootfs only ever exists in a complete state — its mere presence is a
	// valid "already extracted" sentinel. A half-written tree (e.g. the daemon
	// was SIGKILL'd mid-export) lives under .incoming and never claims this name,
	// so it can't masquerade as complete and poison every machine overlay.
	if _, err := os.Stat(baseRootfs); err == nil {
		log.Printf("[overlay] base rootfs already at %s", baseRootfs)
		return nil
	}

	incoming := baseRootfs + ".incoming"
	os.RemoveAll(incoming) // discard any leftover from a previously-killed extraction
	log.Printf("[overlay] extracting base rootfs to %s ...", baseRootfs)
	if err := os.MkdirAll(incoming, 0755); err != nil {
		return fmt.Errorf("mkdir base rootfs staging: %w", err)
	}

	// podman export gives a flat tar of the container's filesystem.
	exportCmd := exec.Command("podman", "export", baseContainerName)
	tarCmd := exec.Command("tar", "-xf", "-", "-C", incoming)

	pipe, err := exportCmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("pipe setup: %w", err)
	}
	tarCmd.Stdin = pipe
	tarCmd.Stderr = os.Stderr

	if err := exportCmd.Start(); err != nil {
		return fmt.Errorf("podman export start: %w", err)
	}
	if err := tarCmd.Start(); err != nil {
		exportCmd.Process.Kill()
		os.RemoveAll(incoming)
		return fmt.Errorf("tar start: %w", err)
	}

	if err := exportCmd.Wait(); err != nil {
		tarCmd.Process.Kill()
		os.RemoveAll(incoming)
		return fmt.Errorf("podman export: %w", err)
	}
	if err := tarCmd.Wait(); err != nil {
		os.RemoveAll(incoming)
		return fmt.Errorf("tar extract: %w", err)
	}

	// Only now, after a fully successful extraction, publish under the real name.
	// Same-filesystem rename is atomic — readers see either the old dir or the
	// complete new one, never a partial tree.
	if err := os.Rename(incoming, baseRootfs); err != nil {
		os.RemoveAll(incoming)
		return fmt.Errorf("publish base rootfs: %w", err)
	}

	log.Printf("[overlay] base rootfs extracted to %s", baseRootfs)
	return nil
}

// baseRootfs holds the extracted base rootfs path on BTRFS.
// Set by ensureBaseExtracted, used by flatLowerDirs.
var baseRootfs string

// flatLowerDirs returns the single-element lowerdir for flat overlay architecture.
// Every machine uses just the base rootfs as lowerdir. All inherited state is in upperdir.
func flatLowerDirs() []string {
	return []string{baseRootfs}
}

// PrepareMachineDirs creates the overlay directories for a machine.
// The machine dir is a BTRFS subvolume (enables O(1) snapshots for branching).
// upper/work/merged are regular dirs inside it (same st_dev — required by overlayfs).
// If machine dir already exists (pre-populated by branch/template snapshot), it is kept as-is.
func PrepareMachineDirs(layersDir, machineId string) (upper, work, merged string) {
	base := filepath.Join(layersDir, machineId)
	upper = filepath.Join(base, "upper")
	work = filepath.Join(base, "work")
	merged = filepath.Join(base, "merged")
	// Machine dir is a BTRFS subvolume. Only create if not already present
	// (branch/template pre-populates it via btrfsSnapshot).
	if _, err := os.Stat(base); os.IsNotExist(err) {
		if err := btrfsSubvolumeCreate(base); err != nil {
			log.Printf("[overlay] WARNING: btrfs subvolume create %s: %v (falling back to mkdir)", base, err)
			os.MkdirAll(base, 0755)
		}
	}
	os.MkdirAll(upper, 0755)
	os.MkdirAll(work, 0755)
	os.MkdirAll(merged, 0755)
	return
}

// defaultZshrc is the starter ~/.zshrc piano-daemon writes into a new
// machine's home overlay when the host has none. Skips zsh's first-run
// wizard and gives the machine a working oh-my-zsh setup out of the box
// (the base image installs oh-my-zsh + zsh-autosuggestions + zsh-syntax-
// highlighting system-wide at /usr/share/oh-my-zsh).
//
// Override by editing this file inside the machine, or by putting a real
// ~/.zshrc on your host before creating a machine — the host file shines
// through the overlay and this stub never gets written.
const defaultZshrc = `# Piano machine ~/.zshrc — sensible defaults.
# Edit freely; changes persist in this machine's overlay. To have your own
# ~/.zshrc on every new machine, put it in your host $HOME — the daemon
# leaves the host file alone and lets it shine through the overlay.

# Oh My Zsh (installed system-wide in the piano-base image).
export ZSH="/usr/share/oh-my-zsh"
ZSH_THEME="kphoen"
plugins=(
  git
  sudo
  history
  zsh-autosuggestions
  zsh-syntax-highlighting
)
[ -r "$ZSH/oh-my-zsh.sh" ] && source "$ZSH/oh-my-zsh.sh"

# NVM — sourced only if you install it inside the machine.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Aliases.
alias ls="ls -lha --color=auto"
alias vim="nvim"
alias python="python3"
alias gco="git checkout"
alias gmc="git branch --merged | grep -Ev '(^\*|master|main|dev)' | xargs git branch -d"
alias gl="git log --graph --abbrev-commit --decorate --format=format:'%C(bold blue)%h%C(reset) - %C(bold green)(%ar)%C(reset) %C(white)%s%C(reset) %C(dim white)- %an%C(reset)%C(bold yellow)%d%C(reset)'"
`
