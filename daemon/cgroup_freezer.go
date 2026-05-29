package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// cgroupFreezerCache maps containerID -> absolute path of its cgroup.freeze
// (v2) or freezer.state (v1) file. Resolved lazily on first Pause.
var (
	cgroupFreezerCache   = map[string]string{}
	cgroupFreezerCacheMu sync.RWMutex
)

// cgroupV2 returns true if the host uses unified cgroup v2 hierarchy.
func cgroupV2() bool {
	_, err := os.Stat("/sys/fs/cgroup/cgroup.controllers")
	return err == nil
}

// resolveFreezerPath walks /sys/fs/cgroup looking for the libpod cgroup
// scope/dir belonging to containerID. Cached after first hit.
func resolveFreezerPath(containerID string) (string, error) {
	cgroupFreezerCacheMu.RLock()
	if p, ok := cgroupFreezerCache[containerID]; ok {
		cgroupFreezerCacheMu.RUnlock()
		return p, nil
	}
	cgroupFreezerCacheMu.RUnlock()

	var needle, fileName string
	if cgroupV2() {
		needle = "libpod-" + containerID + ".scope"
		fileName = "cgroup.freeze"
	} else {
		needle = "libpod_" + containerID
		fileName = "freezer.state"
	}

	var found string
	_ = filepath.WalkDir("/sys/fs/cgroup", func(p string, d os.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		if strings.HasSuffix(p, needle) {
			found = filepath.Join(p, fileName)
			return filepath.SkipAll
		}
		return nil
	})
	if found == "" {
		return "", fmt.Errorf("freezer path for %s not found", containerID)
	}

	cgroupFreezerCacheMu.Lock()
	cgroupFreezerCache[containerID] = found
	cgroupFreezerCacheMu.Unlock()
	return found, nil
}

// ErrFreezerUnavailable signals caller should fall back to podman CLI.
var ErrFreezerUnavailable = errors.New("cgroup freezer file unavailable")

func FreezeCgroup(containerID string) error {
	path, err := resolveFreezerPath(containerID)
	if err != nil {
		return ErrFreezerUnavailable
	}
	val := []byte("1")
	if !cgroupV2() {
		val = []byte("FROZEN")
	}
	return os.WriteFile(path, val, 0)
}

func UnfreezeCgroup(containerID string) error {
	path, err := resolveFreezerPath(containerID)
	if err != nil {
		return ErrFreezerUnavailable
	}
	val := []byte("0")
	if !cgroupV2() {
		val = []byte("THAWED")
	}
	return os.WriteFile(path, val, 0)
}

// ForgetFreezerPath clears the cache for a container (call on RemoveContainer).
func ForgetFreezerPath(containerID string) {
	cgroupFreezerCacheMu.Lock()
	delete(cgroupFreezerCache, containerID)
	cgroupFreezerCacheMu.Unlock()
}
