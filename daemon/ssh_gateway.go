package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	gossh "golang.org/x/crypto/ssh"
)

// SSHGateway is a single-port SSH server that multiplexes connections to
// any machine managed by MachineManager. The SSH username IS the machineId.
// Authentication uses the host user's ~/.ssh/authorized_keys.
type SSHGateway struct {
	mgr      *MachineManager
	port     int
	config   *gossh.ServerConfig
	listener net.Listener
	done     chan struct{}
	wg       sync.WaitGroup
}

// NewSSHGateway creates a gateway. Call Start() to begin accepting connections.
// `port` is the local TCP port to bind — caller is responsible for picking
// a slot-aware value in dev (set via --ssh-gateway-port flag in main.go).
func NewSSHGateway(mgr *MachineManager, port int) (*SSHGateway, error) {
	gw := &SSHGateway{
		mgr:  mgr,
		port: port,
		done: make(chan struct{}),
	}

	hostKey, err := loadOrGenerateHostKey()
	if err != nil {
		return nil, fmt.Errorf("host key: %w", err)
	}

	authorizedKeys, err := loadAuthorizedKeys()
	if err != nil {
		log.Printf("[ssh-gw] warning: no authorized_keys found: %v", err)
		log.Printf("[ssh-gw] public key auth will be unavailable")
	}

	gw.config = &gossh.ServerConfig{
		PublicKeyCallback: func(conn gossh.ConnMetadata, key gossh.PublicKey) (*gossh.Permissions, error) {
			if authorizedKeys == nil {
				return nil, fmt.Errorf("no authorized keys configured")
			}
			for _, ak := range authorizedKeys {
				if bytes.Equal(key.Marshal(), ak.Marshal()) {
					return &gossh.Permissions{}, nil
				}
			}
			return nil, fmt.Errorf("unknown public key for %s", conn.User())
		},
	}
	gw.config.AddHostKey(hostKey)

	return gw, nil
}

// Start begins listening for SSH connections.
func (gw *SSHGateway) Start() error {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", gw.port))
	if err != nil {
		return fmt.Errorf("ssh listen: %w", err)
	}
	gw.listener = ln
	log.Printf("[ssh-gw] listening on :%d", gw.port)

	gw.wg.Add(1)
	go func() {
		defer gw.wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				select {
				case <-gw.done:
					return
				default:
					log.Printf("[ssh-gw] accept: %v", err)
					continue
				}
			}
			go gw.handleConnection(conn)
		}
	}()
	return nil
}

// Stop shuts down the gateway.
func (gw *SSHGateway) Stop() {
	close(gw.done)
	if gw.listener != nil {
		gw.listener.Close()
	}
	gw.wg.Wait()
	log.Println("[ssh-gw] stopped")
}

func (gw *SSHGateway) handleConnection(netConn net.Conn) {
	defer netConn.Close()

	sshConn, chans, reqs, err := gossh.NewServerConn(netConn, gw.config)
	if err != nil {
		log.Printf("[ssh-gw] handshake failed: %v", err)
		return
	}
	defer sshConn.Close()

	machineId := sshConn.User()
	log.Printf("[ssh-gw] connected: machine=%s from=%s", machineId, netConn.RemoteAddr())

	// Verify machine exists and is running
	m := gw.mgr.Get(machineId)
	if m == nil {
		log.Printf("[ssh-gw] machine not found: %s", machineId)
		return
	}

	// Discard global requests (keepalive etc.)
	go gossh.DiscardRequests(reqs)

	// Handle channels
	for newChannel := range chans {
		switch newChannel.ChannelType() {
		case "session":
			go gw.handleSession(newChannel, machineId)
		case "direct-tcpip":
			go gw.handleDirectTCPIP(newChannel, m)
		default:
			newChannel.Reject(gossh.UnknownChannelType, fmt.Sprintf("unknown channel type: %s", newChannel.ChannelType()))
		}
	}
	log.Printf("[ssh-gw] disconnected: machine=%s", machineId)
}

func (gw *SSHGateway) handleSession(newChannel gossh.NewChannel, machineId string) {
	channel, requests, err := newChannel.Accept()
	if err != nil {
		log.Printf("[ssh-gw] session accept: %v", err)
		return
	}
	defer channel.Close()

	// Wait for a request (exec, shell, or subsystem)
	for req := range requests {
		switch req.Type {
		case "exec":
			gw.handleExec(channel, req, machineId)
			return
		case "shell":
			if req.WantReply {
				req.Reply(true, nil)
			}
			gw.handleShell(channel, machineId)
			return
		case "subsystem":
			gw.handleSubsystem(channel, req, machineId)
			return
		case "env":
			// VS Code sends env requests before exec/shell — accept and ignore
			if req.WantReply {
				req.Reply(true, nil)
			}
		case "pty-req":
			// Accept PTY allocation
			if req.WantReply {
				req.Reply(true, nil)
			}
		default:
			log.Printf("[ssh-gw] unknown session request: %s", req.Type)
			if req.WantReply {
				req.Reply(false, nil)
			}
		}
	}
}

func (gw *SSHGateway) handleExec(channel gossh.Channel, req *gossh.Request, machineId string) {
	// Parse command from the request payload
	if len(req.Payload) < 4 {
		if req.WantReply {
			req.Reply(false, nil)
		}
		return
	}
	cmdLen := int(req.Payload[0])<<24 | int(req.Payload[1])<<16 | int(req.Payload[2])<<8 | int(req.Payload[3])
	if cmdLen+4 > len(req.Payload) {
		if req.WantReply {
			req.Reply(false, nil)
		}
		return
	}
	command := string(req.Payload[4 : 4+cmdLen])

	if req.WantReply {
		req.Reply(true, nil)
	}

	cmd := ExecCommandNonInteractive(machineId, []string{"sh", "-c", command}, "")
	cmd.Stdin = channel
	cmd.Stdout = channel
	cmd.Stderr = channel.Stderr()

	err := cmd.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}

	// Send exit status
	payload := []byte{0, 0, 0, 0}
	payload[0] = byte(exitCode >> 24)
	payload[1] = byte(exitCode >> 16)
	payload[2] = byte(exitCode >> 8)
	payload[3] = byte(exitCode)
	channel.SendRequest("exit-status", false, payload)
}

func (gw *SSHGateway) handleShell(channel gossh.Channel, machineId string) {
	// NOTE: this is a standalone `podman exec` wired directly to the SSH
	// channel — it does NOT flow through Machine.readPTY, so the activity
	// tracker (OSC 133 / `piano` / bell) does not observe anything typed in an
	// SSH/editor session. Activity signalling only works in Piano terminal
	// panes. See daemon/activity.go for the coverage boundary.
	_, _, _, home := hostUser()
	cmd := ExecCommandNonInteractive(machineId, []string{"zsh", "-l"}, home)
	cmd.Stdin = channel
	cmd.Stdout = channel
	cmd.Stderr = channel.Stderr()

	err := cmd.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
	}

	payload := []byte{byte(exitCode >> 24), byte(exitCode >> 16), byte(exitCode >> 8), byte(exitCode)}
	channel.SendRequest("exit-status", false, payload)
}

func (gw *SSHGateway) handleSubsystem(channel gossh.Channel, req *gossh.Request, machineId string) {
	// Parse subsystem name
	if len(req.Payload) < 4 {
		if req.WantReply {
			req.Reply(false, nil)
		}
		return
	}
	nameLen := int(req.Payload[0])<<24 | int(req.Payload[1])<<16 | int(req.Payload[2])<<8 | int(req.Payload[3])
	if nameLen+4 > len(req.Payload) {
		if req.WantReply {
			req.Reply(false, nil)
		}
		return
	}
	subsystem := string(req.Payload[4 : 4+nameLen])

	if subsystem != "sftp" {
		log.Printf("[ssh-gw] unknown subsystem: %s", subsystem)
		if req.WantReply {
			req.Reply(false, nil)
		}
		return
	}

	if req.WantReply {
		req.Reply(true, nil)
	}

	// Run sftp-server inside the container
	cmd := ExecCommandNonInteractive(machineId, []string{"/usr/lib/openssh/sftp-server"}, "")
	cmd.Stdin = channel
	cmd.Stdout = channel
	cmd.Stderr = channel.Stderr()

	err := cmd.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
	}
	payload := []byte{byte(exitCode >> 24), byte(exitCode >> 16), byte(exitCode >> 8), byte(exitCode)}
	channel.SendRequest("exit-status", false, payload)
}

// handleDirectTCPIP proxies TCP connections (port forwarding) into the container.
// Services inside containers typically listen on 127.0.0.1, which is unreachable
// from the host via the container IP. We proxy through podman exec + socat.
func (gw *SSHGateway) handleDirectTCPIP(newChannel gossh.NewChannel, m *Machine) {
	// Parse the direct-tcpip extra data
	var payload struct {
		DestAddr string
		DestPort uint32
		SrcAddr  string
		SrcPort  uint32
	}
	if err := gossh.Unmarshal(newChannel.ExtraData(), &payload); err != nil {
		newChannel.Reject(gossh.ConnectionFailed, "invalid payload")
		return
	}

	channel, _, err := newChannel.Accept()
	if err != nil {
		return
	}
	defer channel.Close()

	// Use socat inside the container to reach localhost-bound services.
	target := fmt.Sprintf("TCP:127.0.0.1:%d", payload.DestPort)
	cmd := ExecCommandNonInteractive(m.Id, []string{"socat", "-", target}, "")
	cmd.Stdin = channel
	cmd.Stdout = channel
	cmd.Stderr = channel.Stderr()

	if err := cmd.Run(); err != nil {
		log.Printf("[ssh-gw] direct-tcpip %s:%d failed: %v", payload.DestAddr, payload.DestPort, err)
	}
}

// --- Host key management ---

func hostKeyPath() string {
	return filepath.Join(layersDir, "ssh_host_ed25519_key")
}

func loadOrGenerateHostKey() (gossh.Signer, error) {
	path := hostKeyPath()

	// Try loading existing key
	data, err := os.ReadFile(path)
	if err == nil {
		signer, err := gossh.ParsePrivateKey(data)
		if err == nil {
			log.Printf("[ssh-gw] loaded host key from %s", path)
			return signer, nil
		}
	}

	// Generate new ed25519 key
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}

	pemBlock, err := gossh.MarshalPrivateKey(priv, "")
	if err != nil {
		return nil, err
	}

	pemData := pem.EncodeToMemory(pemBlock)
	if err := os.WriteFile(path, pemData, 0600); err != nil {
		return nil, fmt.Errorf("write host key: %w", err)
	}

	signer, err := gossh.ParsePrivateKey(pemData)
	if err != nil {
		return nil, err
	}

	log.Printf("[ssh-gw] generated new host key at %s", path)
	return signer, nil
}

// --- Authorized keys ---

func loadAuthorizedKeys() ([]gossh.PublicKey, error) {
	_, _, _, home := hostUser()
	path := filepath.Join(home, ".ssh", "authorized_keys")

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}

	var keys []gossh.PublicKey
	rest := data
	for len(rest) > 0 {
		key, _, _, r, err := gossh.ParseAuthorizedKey(rest)
		if err != nil {
			// Skip unparseable lines
			if idx := indexOf(rest, '\n'); idx >= 0 {
				rest = rest[idx+1:]
				continue
			}
			break
		}
		keys = append(keys, key)
		rest = r
	}

	if len(keys) == 0 {
		return nil, fmt.Errorf("no valid keys in %s", path)
	}

	log.Printf("[ssh-gw] loaded %d authorized key(s) from %s", len(keys), path)
	return keys, nil
}

func indexOf(data []byte, b byte) int {
	return strings.IndexByte(string(data), b)
}
