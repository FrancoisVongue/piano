package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// No init() re-exec needed — daemon runs as root (sudo).
// PIANO_USER_* env vars carry the real user's identity.

func main() {
	// Subcommand dispatch — `pair <code>` and `set-token <encoded>` both
	// write /etc/piano/daemon.json and exit; `set-token` skips the HTTP
	// roundtrip because the token is already valid (rotate flow).
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "pair":
			if os.Getuid() != 0 {
				log.Fatal("piano-daemon pair must run as root (sudo) so the token can be saved to /etc/piano/daemon.json")
			}
			if err := runPair(os.Args[2:]); err != nil {
				log.Fatalf("pair failed: %v", err)
			}
			return
		case "set-token":
			if os.Getuid() != 0 {
				log.Fatal("piano-daemon set-token must run as root (sudo) to write /etc/piano/daemon.json")
			}
			if err := runSetToken(os.Args[2:]); err != nil {
				log.Fatalf("set-token failed: %v", err)
			}
			return
		}
	}

	// Wire structured logging (JSON, GCP severity) before anything else logs.
	// All stdlib `log.*` calls in the daemon get re-emitted as structured
	// JSON via the bridge installed inside SetupLogging.
	SetupLogging("piano-daemon")

	// Verify running as root
	if os.Getuid() != 0 {
		log.Fatal("piano daemon must run as root (sudo). Use: sudo ./piano-daemon ...")
	}

	var (
		devMode           bool
		port              int
		backendURL        string
		flagToken         string
		layersDirF        string
		flagSishHost      string
		flagSishPort      int
		flagPubkeyDest    string
		flagSshGatewayPort int
	)
	flag.BoolVar(&devMode, "dev", false, "dev mode: skip overlay, use temp dirs")
	flag.IntVar(&port, "port", 9718, "HTTP listen port")
	flag.StringVar(&backendURL, "backend-url", "", "backend WebSocket URL for control plane (overrides paired config)")
	flag.StringVar(&flagToken, "token", "", "Bearer token override — used by Tilt with PIANO_DEV_DAEMON_TOKEN")
	flag.StringVar(&layersDirF, "layers-dir", "", "override layers directory (default: /var/tmp/piano/<uid>)")
	flag.StringVar(&flagSishHost, "sish-host", "", "sish reverse-tunnel host (overrides paired config — used by Tilt for dev)")
	flag.IntVar(&flagSishPort, "sish-port", 0, "sish public port to bind (overrides paired config — used by Tilt for dev)")
	flag.StringVar(&flagPubkeyDest, "sish-pubkey-dest", "", "additional path to drop the sish public key — used by Tilt to land it in sish container's pubkeys volume without manual copy")
	flag.IntVar(&flagSshGatewayPort, "ssh-gateway-port", 2200, "local TCP port for the SSH gateway — slot-derived in dev so multiple parallel daemons don't collide")
	flag.Parse()

	// Resolve credentials. Three sources in priority order:
	//   1. --backend-url + --token (Tilt / dev): explicit, no /etc/piano file.
	//   2. /etc/piano/daemon.json (production / self-host): written by `pair`.
	//   3. --dev with neither: standalone, no control plane, only local /ws.
	authToken := ""
	tunnelHost := ""
	tunnelPort := 0
	if backendURL != "" && flagToken != "" {
		authToken = flagToken
		log.Printf("[control] using token from --token flag")
	} else if backendURL == "" {
		cfg, cfgErr := loadDaemonConfig()
		switch {
		case cfgErr == nil && cfg != nil:
			backendURL = cfg.BackendURL + "/api/daemon/ws"
			authToken = cfg.Token
			tunnelHost = cfg.SshHost
			tunnelPort = cfg.SshPort
			log.Printf("[control] using paired identity: %s (id=%s)", cfg.Name, cfg.DaemonId)
		case devMode:
			log.Println("[control] no --backend-url and no paired config — running standalone (dev only)")
		case os.IsNotExist(cfgErr):
			log.Fatalf("daemon is not paired. Run:\n    sudo piano-daemon pair <PAIRING_CODE> --backend <BACKEND_URL>\nfirst — that writes %s with the credentials this process needs.", configPath)
		default:
			log.Fatalf("could not read paired config at %s: %v\n(Re-run `piano-daemon pair ...` to recreate it.)", configPath, cfgErr)
		}
	}

	// Explicit --sish-host/--sish-port wins over whatever came from
	// daemon.json. In dev (Tilt) the daemon has no daemon.json — these
	// flags are how the tunnel goroutine learns where to dial.
	if flagSishHost != "" && flagSishPort != 0 {
		tunnelHost = flagSishHost
		tunnelPort = flagSishPort
	}

	var mgr *MachineManager
	defer func() {
		if mgr != nil {
			mgr.Shutdown()
		}
	}()

	// Resolve host user from SUDO_USER or PIANO_USER_* env vars
	uid, _, name, _ := hostUser()
	if name == "" {
		log.Fatal("cannot determine host user — set PIANO_USER_NAME or run via sudo")
	}
	log.Printf("[user] host user: %s (uid=%d)", name, uid)

	if layersDirF != "" {
		layersDir = layersDirF
	} else {
		layersDir = fmt.Sprintf("/var/tmp/piano/%d", uid)
	}
	os.MkdirAll(layersDir, 0755)
	log.Printf("[layers] using %s", layersDir)

	if devMode {
		log.Println("running in DEV mode")
	}

	if !devMode {
		if err := Preflight(); err != nil {
			log.Fatalf("preflight failed: %v", err)
		}

		if err := EnsureBtrfsStorage(layersDir); err != nil {
			log.Fatalf("BTRFS storage setup failed: %v", err)
		}

		if err := PrepareBaseLayer(layersDir); err != nil {
			log.Fatalf("failed to prepare base layer: %v", err)
		}
	}

	mgr = NewMachineManager(devMode)
	mgr.RecoverFromDisk()

	// SSH Gateway — single-port SSH server for "Open in IDE"
	sshGw, err := NewSSHGateway(mgr, flagSshGatewayPort)
	if err != nil {
		log.Printf("[ssh-gw] failed to create gateway: %v (IDE integration disabled)", err)
	} else {
		if err := sshGw.Start(); err != nil {
			log.Printf("[ssh-gw] failed to start: %v (IDE integration disabled)", err)
		}
	}

	if backendURL != "" {
		ctrl := NewControlClient(backendURL, authToken, port, mgr)
		mgr.control = ctrl
		ctrl.Start()
		log.Printf("control plane connecting to %s", backendURL)
	}

	// IDE reverse-tunnel goroutine. Runs only when the backend handed us a
	// sish host+port at pair time. Lives for the lifetime of this process —
	// no separate systemd unit. Stops cleanly on signal via the shutdown
	// handler below.
	var tunnel *Tunnel
	if tunnelHost != "" && tunnelPort != 0 {
		t, err := NewTunnel(tunnelHost, tunnelPort, flagSshGatewayPort, flagPubkeyDest)
		if err != nil {
			log.Printf("[tunnel] init failed: %v (IDE access disabled)", err)
		} else {
			tunnel = t
			go tunnel.Run(context.Background())
			log.Printf("[tunnel] starting reverse-SSH to %s:%d", tunnelHost, tunnelPort)
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", HandleWS(mgr))
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	})
	mux.HandleFunc("/machines", HandleListMachines(mgr))
	mux.HandleFunc("/machines/", routeMachineAction(mgr))

	srv := &http.Server{
		Addr:    fmt.Sprintf("127.0.0.1:%d", port),
		Handler: withCORS(mux),
	}

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT)
		s := <-sig
		log.Printf("[signal] received %s; shutting down...", s)

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)

		mgr.Shutdown()

		if sshGw != nil {
			sshGw.Stop()
		}
		if mgr.control != nil {
			mgr.control.Stop()
		}
		if tunnel != nil {
			tunnel.Stop()
		}

		log.Println("shutdown complete")
		os.Exit(0)
	}()

	log.Printf("piano-terminal listening on %s", srv.Addr)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Printf("[fatal] listen: %v; cleaning up via defers", err)
	}
}

func routeMachineAction(mgr *MachineManager) http.HandlerFunc {
	deleteFn := HandleDeleteMachine(mgr)
	freezeFn := HandleFreezeMachine(mgr)
	branchFn := HandleBranchMachine(mgr)

	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, "/freeze"):
			freezeFn(w, r)
		case strings.HasSuffix(path, "/branch"):
			branchFn(w, r)
		default:
			deleteFn(w, r)
		}
	}
}
