package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"
)

// layersDir is set from main.go at startup.
var layersDir = "/layers"

// MachineMetadata is the on-disk representation of a machine in {layersDir}/{id}/meta.json.
type MachineMetadata struct {
	Id          string    `json:"id"`
	State       string    `json:"state"`
	CreatedAt   time.Time `json:"createdAt"`
	ParentId    string    `json:"parentId,omitempty"`
	SharedWith  string    `json:"sharedWith,omitempty"`
	Hostname    string    `json:"hostname,omitempty"`
	ContainerID string    `json:"containerId,omitempty"`
	MachineIP   string    `json:"machineIP,omitempty"`

	InitialWorkdir string `json:"initialWorkdir,omitempty"`

	// Overlay state
	OverlayUpperDir string `json:"overlayUpperDir,omitempty"`
	OverlayMounted  bool   `json:"overlayMounted"`
}

func metaPath(id string) string {
	return filepath.Join(layersDir, id, "meta.json")
}

// SaveMetadata writes the machine's current state to disk.
func SaveMetadata(m *Machine) error {
	meta := MachineMetadata{
		Id:              m.Id,
		State:           m.State.String(),
		CreatedAt:       m.createdAt,
		ParentId:        m.parentId,
		SharedWith:      m.sharedWith,
		Hostname:        m.hostname,
		ContainerID:     m.containerID,
		MachineIP:       m.machineIP,
		InitialWorkdir:  m.initialWorkdir,
		OverlayUpperDir: m.overlayUpperDir,
		OverlayMounted:  m.overlayMounted,
	}
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(metaPath(m.Id), data, 0644)
}

// DeleteMetadata removes the machine's metadata directory from disk.
// Machine dir is a BTRFS subvolume — delete it with btrfs subvolume delete.
func DeleteMetadata(id string) {
	machineDir := filepath.Join(layersDir, id)
	btrfsSubvolumeDelete(machineDir)
	// Fallback: if not a subvolume (e.g. dev mode), rm -rf.
	os.RemoveAll(machineDir)
}

// LoadAllMetadata scans {layersDir}/*/meta.json and returns all valid entries.
// Standalone machines first, shared machines second (shared depend on parent).
func LoadAllMetadata() []MachineMetadata {
	pattern := filepath.Join(layersDir, "*", "meta.json")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		log.Printf("glob %s: %v", pattern, err)
		return nil
	}

	var standalone, shared []MachineMetadata
	for _, path := range matches {
		data, err := os.ReadFile(path)
		if err != nil {
			log.Printf("skip %s: %v", path, err)
			continue
		}
		var meta MachineMetadata
		if err := json.Unmarshal(data, &meta); err != nil {
			log.Printf("skip %s: invalid json: %v", path, err)
			continue
		}
		if meta.Id == "" {
			log.Printf("skip %s: missing id", path)
			continue
		}
		if meta.SharedWith != "" {
			shared = append(shared, meta)
		} else {
			standalone = append(standalone, meta)
		}
	}

	return append(standalone, shared...)
}
