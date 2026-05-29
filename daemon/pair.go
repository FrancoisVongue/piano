package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"time"
)

// Persisted daemon identity: written by `piano-daemon pair`, read on every
// subsequent normal startup. Lives at /etc/piano/daemon.json (root only) so
// it survives user logouts and isn't tied to a particular $HOME.
const configPath = "/etc/piano/daemon.json"

type DaemonConfig struct {
	DaemonId   string `json:"daemonId"`
	Name       string `json:"name"`
	Token      string `json:"token"`
	BackendURL string `json:"backendURL"`
	// Sish reverse-tunnel config — set by the backend at pair time when
	// PIANO_SISH_HOST is configured. Empty SshHost means this Piano
	// installation doesn't expose IDE access; the daemon skips the tunnel
	// goroutine entirely.
	SshHost string `json:"sshHost,omitempty"`
	SshPort int    `json:"sshPort,omitempty"`
}

type pairRequestBody struct {
	Code           string `json:"code"`
	DefaultWorkdir string `json:"defaultWorkdir,omitempty"`
}

// resolveHostHome figures out the human-user $HOME on the daemon host —
// even when the daemon was launched via `sudo`, which strips $HOME to
// /root. Used for the "Open in IDE" workdir so Cursor/VSCode lands in a
// directory the in-container user (which is the same host user, since
// piano machines mount $HOME from host) can read.
//
// Priority:
//  1. PIANO_USER_HOME — explicit override from Tilt / orchestrator
//  2. user.Lookup(SUDO_USER) — reads passwd entry for the real home dir;
//     falls back to /home/<user> only if Lookup fails
//  3. $HOME — only when not running under sudo (otherwise it'd be /root)
//
// Returns "" if nothing usable found; runPair omits the field then.
func resolveHostHome() string {
	if h := os.Getenv("PIANO_USER_HOME"); h != "" {
		return h
	}
	if su := os.Getenv("SUDO_USER"); su != "" {
		if u, err := user.Lookup(su); err == nil && u.HomeDir != "" {
			return u.HomeDir
		}
		return "/home/" + su
	}
	if h := os.Getenv("HOME"); h != "" && h != "/root" {
		return h
	}
	return ""
}

type pairResponseBody struct {
	Success *struct {
		DaemonId string `json:"daemonId"`
		Name     string `json:"name"`
		Token    string `json:"token"`
		SshHost  string `json:"sshHost"`
		SshPort  int    `json:"sshPort"`
	} `json:"success,omitempty"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// runSetToken handles `piano-daemon set-token <encoded> --backend <url>`.
// `encoded` is the `piano-token.<daemonId>.<token>` blob the backend hands
// back from a rotate-token request — the token is already valid, so there's
// no HTTP roundtrip; we just overwrite the config file.
func runSetToken(args []string) error {
	fs := flag.NewFlagSet("set-token", flag.ExitOnError)
	var backendURL string
	fs.StringVar(&backendURL, "backend", "", "backend HTTP base URL")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 1 {
		return errors.New("usage: piano-daemon set-token <piano-token.ID.TOKEN> --backend <url>")
	}
	if backendURL == "" {
		return errors.New("--backend is required")
	}
	parts := strings.SplitN(fs.Arg(0), ".", 3)
	if len(parts) != 3 || parts[0] != "piano-token" || parts[1] == "" || parts[2] == "" {
		return errors.New("expected 'piano-token.DAEMONID.TOKEN'")
	}
	daemonId, token := parts[1], parts[2]

	// Preserve previously-paired metadata — rotation only swaps the token.
	name, sshHost, sshPort := "", "", 0
	if existing, err := loadDaemonConfig(); err == nil && existing != nil {
		name = existing.Name
		sshHost = existing.SshHost
		sshPort = existing.SshPort
	}
	cfg := DaemonConfig{
		DaemonId:   daemonId,
		Name:       name,
		Token:      token,
		BackendURL: backendURL,
		SshHost:    sshHost,
		SshPort:    sshPort,
	}
	if err := saveDaemonConfig(cfg); err != nil {
		return fmt.Errorf("save config: %w", err)
	}
	log.Printf("[set-token] token written to %s — restart the daemon to reconnect.", configPath)
	return nil
}

// runPair handles `piano-daemon pair <code> --backend <url>`. Exchanges the
// one-time code for a long-lived bearer token and persists everything to
// /etc/piano/daemon.json.
func runPair(args []string) error {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	var backendURL string
	var force bool
	fs.StringVar(&backendURL, "backend", "", "backend HTTP base URL, e.g. https://api.your-piano.example.com")
	fs.BoolVar(&force, "force", false, "overwrite an existing /etc/piano/daemon.json (replaces the daemon's identity)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if fs.NArg() < 1 {
		return errors.New("usage: piano-daemon pair <code> --backend <url> [--force]")
	}
	code := fs.Arg(0)
	if backendURL == "" {
		return errors.New("--backend is required (e.g. --backend https://api.your-piano.example.com)")
	}

	// Refuse to clobber an existing pairing without --force. Re-pairing
	// replaces the daemon's identity (new daemonId, new token, new sish
	// port allocation); a still-running process keeps the OLD identity in
	// memory while the backend revokes it, so the user ends up with a
	// daemon that loops failing auth.
	if !force {
		if existing, err := loadDaemonConfig(); err == nil && existing != nil {
			return fmt.Errorf("already paired as %q (id=%s). Stop the running daemon and use --force to overwrite", existing.Name, existing.DaemonId)
		}
	}

	body, _ := json.Marshal(pairRequestBody{
		Code:           code,
		DefaultWorkdir: resolveHostHome(),
	})
	req, err := http.NewRequest("POST", backendURL+"/api/daemons/pair", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connect to backend: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	var pr pairResponseBody
	_ = json.Unmarshal(raw, &pr)
	if resp.StatusCode != http.StatusOK || pr.Success == nil {
		msg := "unknown"
		if pr.Error != nil {
			msg = pr.Error.Message
		}
		return fmt.Errorf("pair failed (%d): %s", resp.StatusCode, msg)
	}

	cfg := DaemonConfig{
		DaemonId:   pr.Success.DaemonId,
		Name:       pr.Success.Name,
		Token:      pr.Success.Token,
		BackendURL: backendURL,
		SshHost:    pr.Success.SshHost,
		SshPort:    pr.Success.SshPort,
	}
	if err := saveDaemonConfig(cfg); err != nil {
		return fmt.Errorf("save config: %w", err)
	}
	log.Printf("[pair] paired as %q (id=%s)", cfg.Name, cfg.DaemonId)
	if cfg.SshHost != "" && cfg.SshPort != 0 {
		log.Printf("[pair] IDE tunnel allocated: %s:%d", cfg.SshHost, cfg.SshPort)
	} else {
		log.Printf("[pair] no IDE tunnel (PIANO_SISH_HOST not configured on backend)")
	}
	log.Printf("[pair] config written to %s — start the daemon to connect.", configPath)
	return nil
}

func saveDaemonConfig(cfg DaemonConfig) error {
	if err := os.MkdirAll(filepath.Dir(configPath), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	// Atomic write: pair / set-token can be killed mid-flight (Ctrl+C,
	// OOM-kill, power loss). os.WriteFile is NOT atomic — it truncates
	// the destination first, so a kill before all bytes are flushed
	// leaves an unparseable half-file and the daemon refuses to start.
	tmp := configPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, configPath)
}

func loadDaemonConfig() (*DaemonConfig, error) {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return nil, err
	}
	var cfg DaemonConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}
