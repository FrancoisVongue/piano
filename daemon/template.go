package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type TemplateInfo struct {
	Id               string `json:"id"`
	Name             string `json:"name"`
	ParentTemplateId string `json:"parentTemplateId,omitempty"`
	CreatedAt        string `json:"createdAt"`
}

type KeyValue struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

func templatesDir() string {
	return filepath.Join(layersDir, "templates")
}

func templatePath(templateId string) string {
	return filepath.Join(templatesDir(), templateId)
}

// CreateTemplate copies a frozen machine's upper dir to the templates directory.
// The machine must be frozen (overlay unmounted, upper dir is the snapshot).
func CreateTemplate(machineId, templateId, name string) error {
	srcDir := filepath.Join(layersDir, machineId)
	if _, err := os.Stat(filepath.Join(srcDir, "upper")); err != nil {
		return fmt.Errorf("machine %s upper dir not found (is it frozen?): %w", machineId, err)
	}

	os.MkdirAll(templatesDir(), 0755)
	dstDir := templatePath(templateId)

	// BTRFS snapshot: O(1) regardless of file count.
	if err := btrfsSnapshot(srcDir, dstDir); err != nil {
		return fmt.Errorf("snapshot template: %w", err)
	}

	// Write metadata.
	meta := TemplateInfo{
		Id:        templateId,
		Name:      name,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	data, _ := json.MarshalIndent(meta, "", "  ")
	if err := os.WriteFile(filepath.Join(dstDir, "meta.json"), data, 0644); err != nil {
		return fmt.Errorf("write template meta: %w", err)
	}

	log.Printf("[template] created %s from machine %s", templateId, machineId)
	return nil
}

// DeleteTemplate removes a template directory.
func DeleteTemplate(templateId string) error {
	dir := templatePath(templateId)
	if _, err := os.Stat(dir); err != nil {
		return fmt.Errorf("template not found: %s", templateId)
	}
	// Template dir is a BTRFS subvolume.
	btrfsSubvolumeDelete(dir)
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("remove template: %w", err)
	}
	log.Printf("[template] deleted %s", templateId)
	return nil
}

// ListTemplates scans the templates directory and returns metadata for all templates.
func ListTemplates() []TemplateInfo {
	dir := templatesDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var templates []TemplateInfo
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		metaPath := filepath.Join(dir, entry.Name(), "meta.json")
		data, err := os.ReadFile(metaPath)
		if err != nil {
			continue
		}
		var info TemplateInfo
		if err := json.Unmarshal(data, &info); err != nil {
			continue
		}
		templates = append(templates, info)
	}
	return templates
}

// InjectSecrets writes secrets as environment variables to /root/.env inside a running container.
func InjectSecrets(machineId string, secrets []KeyValue) error {
	if len(secrets) == 0 {
		return nil
	}

	var envContent strings.Builder
	for _, s := range secrets {
		envContent.WriteString(fmt.Sprintf("export %s=%q\n", s.Key, s.Value))
	}

	// Write the .env file.
	if err := WriteToContainer(machineId, "/root/.env", envContent.String()); err != nil {
		return fmt.Errorf("write .env: %w", err)
	}

	// Ensure .bashrc sources it.
	sourceCmd := `grep -q 'source /root/.env' /root/.bashrc 2>/dev/null || echo 'source /root/.env' >> /root/.bashrc`
	out, err := exec.Command("podman", "exec", containerName(machineId),
		"sh", "-c", sourceCmd).CombinedOutput()
	if err != nil {
		return fmt.Errorf("update .bashrc: %w\noutput: %s", err, out)
	}

	// Also source in .zshrc if it exists.
	sourceZsh := `grep -q 'source /root/.env' /root/.zshrc 2>/dev/null || echo 'source /root/.env' >> /root/.zshrc`
	exec.Command("podman", "exec", containerName(machineId),
		"sh", "-c", sourceZsh).Run() // best-effort

	log.Printf("[template] injected %d secrets into %s", len(secrets), machineId)
	return nil
}
