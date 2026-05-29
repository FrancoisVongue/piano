package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// Tunnel keeps an outbound reverse-SSH connection alive to the configured
// sish VPS, requesting a TCP forward on the public port the backend handed
// us at pair time. Inbound connections to that public port land here as
// new chans, and we splice them to localhost:2200 (the daemon's own SSH
// gateway). Auto-reconnects on disconnect with a 5s backoff.
//
// The whole thing runs as a goroutine off main(); no separate process /
// systemd unit needed.
type Tunnel struct {
	sishHost  string
	sshPort   int
	localPort int // where the daemon's SSH gateway listens (= 2200)
	signer    ssh.Signer
	stop      chan struct{}
	stopOnce  sync.Once
}

// NewTunnel constructs a tunnel ready to Run(). Loads or creates the sish
// SSH keypair on first use so the operator only has to copy the pubkey to
// sish's authorized_keys once. `pubkeyDest`, if non-empty, also writes a
// world-readable copy of the public key to that path — used by Tilt to drop
// the key directly into the sish container's pubkeys volume so dev needs
// no manual copy step.
func NewTunnel(sishHost string, sshPort int, localPort int, pubkeyDest string) (*Tunnel, error) {
	if sishHost == "" {
		return nil, errors.New("sishHost is empty")
	}
	if sshPort <= 0 || sshPort > 65535 {
		return nil, fmt.Errorf("invalid sshPort %d", sshPort)
	}
	signer, err := loadOrCreateSishKey(pubkeyDest)
	if err != nil {
		return nil, fmt.Errorf("sish key: %w", err)
	}
	return &Tunnel{
		sishHost:  sishHost,
		sshPort:   sshPort,
		localPort: localPort,
		signer:    signer,
		stop:      make(chan struct{}),
	}, nil
}

// Run loops forever (until Stop) bringing the tunnel up, splicing
// connections, and reconnecting on disconnect.
func (t *Tunnel) Run(ctx context.Context) {
	for {
		select {
		case <-t.stop:
			return
		case <-ctx.Done():
			return
		default:
		}

		err := t.runOnce(ctx)
		select {
		case <-t.stop:
			return
		case <-ctx.Done():
			return
		default:
		}
		if err != nil {
			log.Printf("[tunnel] disconnected: %v (retrying in 5s)", err)
		}
		select {
		case <-time.After(5 * time.Second):
		case <-t.stop:
			return
		case <-ctx.Done():
			return
		}
	}
}

func (t *Tunnel) Stop() {
	t.stopOnce.Do(func() { close(t.stop) })
}

// runOnce is one connection lifetime: dial, request forward, splice.
func (t *Tunnel) runOnce(ctx context.Context) error {
	cfg := &ssh.ClientConfig{
		User: "piano",
		Auth: []ssh.AuthMethod{ssh.PublicKeys(t.signer)},
		// TODO(host-key): pin sish's host key. InsecureIgnoreHostKey is
		// acceptable for MVP since the operator runs both sides — they
		// trust their own VPS — but a real MITM check is cheap to add.
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         30 * time.Second,
	}
	addr := fmt.Sprintf("%s:2222", t.sishHost) // sish listens on :2222 by default
	slog.Warn("sish host key verification disabled — set --sish-host-key flag for production")
	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return fmt.Errorf("dial %s: %w", addr, err)
	}
	defer client.Close()

	listener, err := client.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", t.sshPort))
	if err != nil {
		return fmt.Errorf("request forward :%d: %w", t.sshPort, err)
	}
	defer listener.Close()
	log.Printf("[tunnel] up: %s:%d → localhost:%d", t.sishHost, t.sshPort, t.localPort)

	errCh := make(chan error, 1)
	go func() {
		for {
			inbound, acceptErr := listener.Accept()
			if acceptErr != nil {
				errCh <- acceptErr
				return
			}
			go t.handle(inbound)
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-t.stop:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// handle splices one inbound (from sish) to localhost:<sshGatewayPort>
// (our own SSH gateway). The gateway authenticates the user end-to-end —
// sish never sees the user's SSH key, just the encrypted bytes.
//
// Half-close splice: when one direction EOFs we CloseWrite the OTHER side
// so its Read returns naturally; we wait for BOTH copies to finish before
// tearing down. A naive "wait for one then close both" splice race-fires
// and drops mid-banner SSH bytes.
func (t *Tunnel) handle(inbound net.Conn) {
	defer inbound.Close()
	outbound, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", t.localPort))
	if err != nil {
		log.Printf("[tunnel] dial localhost:%d: %v", t.localPort, err)
		return
	}
	defer outbound.Close()

	closeWrite := func(c net.Conn) {
		if cw, ok := c.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
			return
		}
		_ = c.Close()
	}

	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(outbound, inbound)
		closeWrite(outbound)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(inbound, outbound)
		closeWrite(inbound)
		done <- struct{}{}
	}()
	<-done
	<-done
}

// ----- key management ------------------------------------------------------

const sishKeyPath = "/etc/piano/sish_ed25519"

// loadOrCreateSishKey returns the daemon's ed25519 SSH identity for sish.
// If the key doesn't exist, generates one. When `pubkeyDest` is non-empty,
// also writes a copy of the pubkey to that path with mode 0644 so a sidecar
// container (sish in dev) can read it — saves a manual copy step.
func loadOrCreateSishKey(pubkeyDest string) (ssh.Signer, error) {
	maybeCopyPubkey := func() {
		if pubkeyDest == "" {
			return
		}
		pubData, err := os.ReadFile(sishKeyPath + ".pub")
		if err != nil {
			log.Printf("[tunnel] read pubkey for copy failed: %v", err)
			return
		}
		if err := os.MkdirAll(filepath.Dir(pubkeyDest), 0755); err != nil {
			log.Printf("[tunnel] mkdir %s failed: %v", filepath.Dir(pubkeyDest), err)
			return
		}
		tmp := pubkeyDest + ".tmp"
		if err := os.WriteFile(tmp, pubData, 0644); err != nil {
			log.Printf("[tunnel] write pubkey copy %s failed: %v", pubkeyDest, err)
			return
		}
		if err := os.Rename(tmp, pubkeyDest); err != nil {
			log.Printf("[tunnel] rename pubkey copy %s failed: %v", pubkeyDest, err)
			return
		}
		log.Printf("[tunnel] pubkey copy written to %s", pubkeyDest)
	}

	if data, err := os.ReadFile(sishKeyPath); err == nil {
		signer, err := ssh.ParsePrivateKey(data)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", sishKeyPath, err)
		}
		maybeCopyPubkey()
		return signer, nil
	}

	if err := os.MkdirAll(filepath.Dir(sishKeyPath), 0700); err != nil {
		return nil, err
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}

	pemBlock, err := ssh.MarshalPrivateKey(priv, "piano-daemon@"+hostname())
	if err != nil {
		return nil, err
	}
	keyBytes := pem.EncodeToMemory(pemBlock)
	// Atomic write — see saveDaemonConfig. A truncated key file is unrecoverable.
	tmpKey := sishKeyPath + ".tmp"
	if err := os.WriteFile(tmpKey, keyBytes, 0600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmpKey, sishKeyPath); err != nil {
		return nil, err
	}

	signer, err := ssh.ParsePrivateKey(keyBytes)
	if err != nil {
		return nil, err
	}

	pubKey, err := ssh.NewPublicKey(pub)
	if err != nil {
		return nil, err
	}
	authorizedKey := string(ssh.MarshalAuthorizedKey(pubKey))
	pubKeyPath := sishKeyPath + ".pub"
	tmpPub := pubKeyPath + ".tmp"
	if err := os.WriteFile(tmpPub, []byte(authorizedKey), 0644); err == nil {
		_ = os.Rename(tmpPub, pubKeyPath)
	}

	log.Printf("[tunnel] generated new sish key at %s", sishKeyPath)
	log.Printf("[tunnel] === ACTION REQUIRED: add this pubkey to sish's pubkeys/ folder ===")
	log.Printf("[tunnel] %s", authorizedKey)
	log.Printf("[tunnel] (saved at %s — `ssh-copy-id` it to your sish VPS)", pubKeyPath)

	maybeCopyPubkey()
	return signer, nil
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}
