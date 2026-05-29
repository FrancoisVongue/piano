package main

import (
	"encoding/json"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

type MachineState int

const (
	MachineRunning  MachineState = iota // PTY alive, viewer attached
	MachineDetached                     // PTY alive, no viewer
	MachineFrozen                       // Overlay unmounted, upper dir is the frozen state
	MachineStopped                      // Container removed, overlay cleaned up
)

func (s MachineState) String() string {
	switch s {
	case MachineRunning:
		return "running"
	case MachineDetached:
		return "detached"
	case MachineFrozen:
		return "frozen"
	case MachineStopped:
		return "stopped"
	default:
		return "unknown"
	}
}

// Machine represents an isolated environment with an OverlayFS layer and Podman container.
type Machine struct {
	Id         string
	State      MachineState
	createdAt  time.Time
	parentId   string // empty for root machines (kept for UI display only)
	sharedWith string // non-empty = shared terminal (exec into parent's container)
	hostname   string // container hostname shown in shell prompts

	initialWorkdir string // passed to podman exec -w (always $HOME)

	// homeOverlayMounted tracks whether the kernel overlay for $HOME at
	// layersDir/{id}/home-merged is currently mounted.
	homeOverlayMounted bool

	// Podman state
	containerID string     // Podman container ID
	machineIP   string     // container IP (lazy — resolved by IP() on first call)
	ipResolving sync.Mutex // serializes lazy IP resolution

	// Overlay state
	overlayMergedDir string // mount point passed to podman --rootfs
	overlayUpperDir  string // writable layer — THIS IS the machine's state
	overlayWorkDir   string // OverlayFS work directory
	overlayMounted   bool   // true if overlay is currently mounted

	// PTY state (the podman exec process)
	ptmx      *os.File
	cmd       *exec.Cmd
	outputLog *OutputLog
	activity  *ActivityTracker // derives idle/running/exit/signal from the PTY stream

	mu      sync.Mutex      // protects conn
	conn    *websocket.Conn // current viewer (nil = no one watching)
	writeMu sync.Mutex      // serializes WebSocket writes (gorilla requirement)

	wg   sync.WaitGroup // tracks the single PTY reader goroutine
	once sync.Once      // for Destroy
}

// NewMachine creates a Machine and starts its background PTY reader.
func NewMachine(id string, ptmx *os.File, cmd *exec.Cmd) *Machine {
	t := time.Now()
	ol, err := OpenOutputLog(id)
	log.Printf("[machine/%s] OpenOutputLog: %v", id, time.Since(t))
	if err != nil {
		log.Printf("[machine/%s] failed to open output log: %v", id, err)
	}

	m := &Machine{
		Id:        id,
		State:     MachineDetached,
		createdAt: time.Now(),
		ptmx:      ptmx,
		cmd:       cmd,
		outputLog: ol,
		activity:  NewActivityTracker(),
	}
	m.wg.Add(1)
	go m.readPTY()
	return m
}

// NewFrozenMachine creates a Machine in the frozen state (no PTY, no container, overlay unmounted).
// Used during recovery of frozen machines from disk.
func NewFrozenMachine(id string, createdAt time.Time, parentId string, upperDir string, hostname string) *Machine {
	return &Machine{
		Id:              id,
		State:           MachineFrozen,
		createdAt:       createdAt,
		parentId:        parentId,
		hostname:        hostname,
		overlayUpperDir: upperDir,
		overlayMounted:  false,
	}
}

// IP returns the container IP, resolving it lazily on first call.
// Kept off the hot create path — a podman inspect fork costs ~30ms.
func (m *Machine) IP() string {
	m.mu.Lock()
	if m.machineIP != "" {
		ip := m.machineIP
		m.mu.Unlock()
		return ip
	}
	m.mu.Unlock()

	// Serialize resolvers so only one forks podman inspect.
	m.ipResolving.Lock()
	defer m.ipResolving.Unlock()

	m.mu.Lock()
	if m.machineIP != "" {
		ip := m.machineIP
		m.mu.Unlock()
		return ip
	}
	m.mu.Unlock()

	ip, err := ContainerIP(m.Id)
	if err != nil {
		log.Printf("%s resolve IP failed: %v", m.tag(), err)
		return ""
	}
	m.mu.Lock()
	m.machineIP = ip
	m.mu.Unlock()
	return ip
}

// Freeze stops the container, unmounts overlay, and marks the machine as frozen.
// Synchronous — takes ~0.5s total. Upper dir IS the frozen snapshot.
func (m *Machine) Freeze() {
	// Kick viewer.
	m.mu.Lock()
	conn := m.conn
	m.conn = nil
	m.mu.Unlock()
	if conn != nil {
		conn.Close()
	}

	// Clean up local PTY first.
	if m.cmd != nil {
		KillProcess(m.cmd)
	}
	if m.ptmx != nil {
		m.ptmx.Close()
		m.wg.Wait()
	}
	if m.cmd != nil {
		_ = m.cmd.Wait()
	}
	if m.outputLog != nil {
		m.outputLog.Close()
	}

	// Remove container (force — stops + removes).
	if err := RemoveContainer(m.Id); err != nil {
		log.Printf("%s remove container failed: %v", m.tag(), err)
	}
	if m.containerID != "" {
		ForgetFreezerPath(m.containerID)
	}

	// Unmount home overlay first (it's the outer mount for host-kind machines).
	if m.homeOverlayMounted {
		if err := unmountHomeOverlay(layersDir, m.Id); err != nil {
			log.Printf("%s home overlay unmount failed: %v", m.tag(), err)
		}
		m.homeOverlayMounted = false
	}

	// Unmount overlay — upper dir retains all changes.
	if m.overlayMounted {
		if err := UnmountOverlay(m.overlayMergedDir); err != nil {
			log.Printf("%s unmount failed: %v", m.tag(), err)
		}
		m.overlayMounted = false
	}

	m.State = MachineFrozen
	log.Printf("%s frozen", m.tag())
}

func (m *Machine) tag() string {
	short := m.Id
	if len(short) > 12 {
		short = short[:12]
	}
	return "[machine/" + short + "]"
}

// readPTY reads PTY output forever, buffers it, and sends to the current viewer.
func (m *Machine) readPTY() {
	defer m.wg.Done()

	buf := make([]byte, 4096)
	for {
		n, err := m.ptmx.Read(buf)
		if n > 0 {
			// Answer known terminal capability queries locally before the data
			// rides the round-trip to xterm.js. See answerTerminalQueries below
			// for the full rationale — TL;DR: short-lived TUI commands exit
			// before xterm.js's async replies come back, and the stray replies
			// end up mangled in the user's shell prompt. Answering locally
			// makes the response path take microseconds instead of milliseconds.
			answerTerminalQueries(m.ptmx, buf[:n])

			if m.outputLog != nil {
				m.outputLog.Write(buf[:n])
			}
			if m.activity != nil {
				m.activity.Feed(buf[:n])
			}
			m.sendToViewer(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

func (m *Machine) sendToViewer(data []byte) {
	m.mu.Lock()
	conn := m.conn
	m.mu.Unlock()

	if conn == nil {
		return
	}

	m.writeMu.Lock()
	err := conn.WriteMessage(websocket.BinaryMessage, data)
	m.writeMu.Unlock()

	if err != nil {
		m.mu.Lock()
		if m.conn == conn {
			m.conn = nil
			m.State = MachineDetached
		}
		m.mu.Unlock()
	}
}

// Attach connects a WebSocket viewer with output replay.
func (m *Machine) Attach(conn *websocket.Conn) {
	m.mu.Lock()
	old := m.conn
	m.conn = conn
	m.State = MachineRunning
	m.mu.Unlock()

	if old != nil {
		old.Close()
	}

	// Replay buffered output for seamless reconnect.
	m.writeMu.Lock()
	firstConnect := true
	if m.outputLog != nil {
		if replay := m.outputLog.ReplayBytes(); len(replay) > 0 {
			_ = conn.WriteMessage(websocket.BinaryMessage, replay)
			firstConnect = false
		}
	}
	if firstConnect {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("\x1b]piano:replay-done:first-connect\x07"))
	} else {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("\x1b]piano:replay-done\x07"))
	}
	m.writeMu.Unlock()

	log.Printf("%s viewer attached", m.tag())
}

// Detach removes a specific WebSocket viewer.
func (m *Machine) Detach(conn *websocket.Conn) {
	m.mu.Lock()
	if m.conn == conn {
		m.conn = nil
		m.State = MachineDetached
		log.Printf("%s viewer detached", m.tag())
	}
	m.mu.Unlock()

	_ = conn.WriteMessage(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
	)
	conn.Close()
}

// Destroy tears down the PTY, removes the container, and unmounts the overlay.
func (m *Machine) Destroy() {
	m.once.Do(func() {
		log.Printf("%s destroying", m.tag())

		// Kick viewer.
		m.mu.Lock()
		conn := m.conn
		m.conn = nil
		m.mu.Unlock()
		if conn != nil {
			conn.Close()
		}

		if m.cmd != nil {
			KillProcess(m.cmd)
		}
		if m.ptmx != nil {
			m.ptmx.Close()
			m.wg.Wait()
		}
		if m.cmd != nil {
			_ = m.cmd.Wait()
		}

		if m.outputLog != nil {
			m.outputLog.Close()
		}

		if m.sharedWith != "" {
			// Shared terminal: only owns its PTY exec session, not the container or overlay.
			m.State = MachineStopped
			log.Printf("%s destroyed (shared)", m.tag())
			return
		}

		// Standalone machine: remove container and unmount overlay.
		_ = RemoveContainer(m.Id)
		if m.containerID != "" {
			ForgetFreezerPath(m.containerID)
		}

		if m.homeOverlayMounted {
			if err := unmountHomeOverlay(layersDir, m.Id); err != nil {
				log.Printf("%s home overlay unmount failed: %v", m.tag(), err)
			}
			m.homeOverlayMounted = false
		}

		if m.overlayMounted {
			if err := UnmountOverlay(m.overlayMergedDir); err != nil {
				log.Printf("%s unmount failed: %v", m.tag(), err)
			}
			m.overlayMounted = false
		}

		m.State = MachineStopped
		log.Printf("%s destroyed", m.tag())
	})
}

// writeFile writes content to a file inside the machine's container.
func (m *Machine) writeFile(filePath string, content string) error {
	targetId := m.Id
	if m.sharedWith != "" {
		targetId = m.sharedWith
	}
	return WriteToContainer(targetId, filePath, content)
}

// HandleInput reads JSON messages from the WebSocket and dispatches to the PTY.
func (m *Machine) HandleInput(conn *websocket.Conn) {
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseNormalClosure,
				websocket.CloseGoingAway,
				websocket.CloseNoStatusReceived,
				websocket.CloseAbnormalClosure,
			) {
				log.Printf("%s ws read error: %v", m.tag(), err)
			}
			return
		}

		var msg ClientMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			log.Printf("%s invalid json: %v", m.tag(), err)
			continue
		}

		switch msg.Type {
		case MsgTypeInput:
			if _, err := m.ptmx.Write([]byte(msg.Data)); err != nil {
				log.Printf("%s pty write error: %v", m.tag(), err)
				return
			}
		case MsgTypeResize:
			if msg.Cols > 0 && msg.Rows > 0 {
				if err := pty.Setsize(m.ptmx, &pty.Winsize{Cols: msg.Cols, Rows: msg.Rows}); err != nil {
					log.Printf("%s pty resize error: %v", m.tag(), err)
				}
			}
		case MsgTypeFile:
			if err := m.writeFile(msg.Path, msg.Data); err != nil {
				log.Printf("%s file write error: %v", m.tag(), err)
			}
		default:
			log.Printf("%s unknown message type: %s", m.tag(), msg.Type)
		}
	}
}
