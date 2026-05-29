package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os/exec"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ControlMessage is the JSON envelope for daemon↔backend communication.
//
// Traceparent is a W3C trace-context header value (`00-<traceId>-<spanId>-<flags>`).
// Backend injects it for every command originating from a traced HTTP request;
// the daemon attaches it to log lines so all daemon-side activity for that
// request shows up under the same trace_id in Cloud Logging / Cloud Trace.
type ControlMessage struct {
	Type        string          `json:"type"`
	MachineId   string          `json:"machineId,omitempty"`
	Data        json.RawMessage `json:"data,omitempty"`
	Traceparent string          `json:"traceparent,omitempty"`
}

// ControlClient maintains a persistent WebSocket connection to the backend.
// When `token` is non-empty the daemon authenticates by Bearer token (paired
// mode); otherwise the URL itself carries identity (legacy ?userId= mode,
// kept only for the standalone --dev path with no token).
//
// localPort is the port our own /ws listener runs on — used by terminal
// sessions so we can dial localhost:<localPort>/ws and re-use the existing
// PTY-attach handler instead of duplicating its logic. See terminal_session.go.
type ControlClient struct {
	backendURL string
	token      string
	localPort  int
	mgr        *MachineManager
	conn       *websocket.Conn
	mu         sync.Mutex
	done       chan struct{}

	sessionsMu sync.Mutex
	sessions   map[string]*terminalSession
}

func NewControlClient(backendURL, token string, localPort int, mgr *MachineManager) *ControlClient {
	return &ControlClient{
		backendURL: backendURL,
		token:      token,
		localPort:  localPort,
		mgr:        mgr,
		done:       make(chan struct{}),
		sessions:   make(map[string]*terminalSession),
	}
}

// Start connects to the backend and handles messages. Reconnects on failure.
// Also starts the periodic output + metrics push loops.
func (c *ControlClient) Start() {
	go c.connectLoop()
	go c.outputPushLoop()
	go c.metricsPushLoop()
	go c.activityPushLoop()
}

func (c *ControlClient) connectLoop() {
	for {
		select {
		case <-c.done:
			return
		default:
		}

		err := c.connect()
		if err != nil {
			log.Printf("[control] connection failed: %v (retrying in 5s)", err)
			time.Sleep(5 * time.Second)
			continue
		}

		// Read messages until disconnect.
		c.readLoop()
		// Drop every terminal session opened on this control connection. The
		// new control WS knows nothing about them, so leaving them open just
		// leaks PTY viewers + goroutines until process exit.
		c.cleanupAllSessions()
		log.Println("[control] disconnected from backend (retrying in 2s)")
		time.Sleep(2 * time.Second)
	}
}

func (c *ControlClient) connect() error {
	u, err := url.Parse(c.backendURL)
	if err != nil {
		return err
	}

	var headers http.Header
	if c.token != "" {
		headers = http.Header{"Authorization": []string{"Bearer " + c.token}}
	}
	conn, _, err := websocket.DefaultDialer.Dial(u.String(), headers)
	if err != nil {
		return err
	}

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()

	log.Printf("[control] connected to backend: %s", c.backendURL)
	return nil
}

func (c *ControlClient) readLoop() {
	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			return
		}

		var msg ControlMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			log.Printf("[control] invalid message: %v", err)
			continue
		}

		c.handleMessage(msg)
	}
}

func (c *ControlClient) handleMessage(msg ControlMessage) {
	// Per-message logger bound to the backend's trace_id so every line below
	// shows up alongside the originating HTTP request in Cloud Logging.
	ctx := WithTraceparent(context.Background(), msg.Traceparent)
	log := LogWith(ctx).With("domain", "control", "machineId", msg.MachineId, "msgType", msg.Type)

	// Helper closures: error response + ok response. Both inherit traceparent
	// from the inbound message so the backend can stitch the round-trip.
	sendErr := func(err string) {
		c.SendInContext(ctx, ControlMessage{
			Type: "error", MachineId: msg.MachineId,
			Data: mustMarshal(map[string]string{"error": err}),
		})
	}
	sendOk := func(replyType string, data any) {
		var raw json.RawMessage
		if data != nil {
			raw = mustMarshal(data)
		}
		c.SendInContext(ctx, ControlMessage{Type: replyType, MachineId: msg.MachineId, Data: raw})
	}

	// Recover from any panic so a single bad command doesn't kill the daemon.
	defer func() {
		if r := recover(); r != nil {
			log.Error("PANIC handling command", "panic", fmt.Sprintf("%v", r))
			sendErr(fmt.Sprintf("daemon panic: %v", r))
		}
	}()

	// Terminal multiplex frames ride over the same WS — peel them off here
	// so the rest of the switch only sees control commands.
	if msg.Type == "terminal:open" || msg.Type == "terminal:in" || msg.Type == "terminal:close" {
		c.terminalDispatch(msg)
		return
	}

	switch msg.Type {
	case "command:freeze":
		log.Info("freezing")
		if err := c.mgr.Freeze(msg.MachineId); err != nil {
			log.Error("freeze failed", "err", err)
			sendErr(err.Error())
			return
		}
		sendOk("machine:frozen", nil)

	case "command:branch":
		var data struct {
			ChildId     string `json:"childId"`
			MachineName string `json:"machineName"`
		}
		if err := json.Unmarshal(msg.Data, &data); err != nil || data.ChildId == "" {
			sendErr("missing childId")
			return
		}
		child, err := c.mgr.Branch(msg.MachineId, data.ChildId, data.MachineName)
		if err != nil {
			log.Error("branch failed", "err", err)
			sendErr(err.Error())
			return
		}
		sendOk("machine:branched", map[string]string{"childId": child.Id})

	case "command:share":
		var data struct {
			ChildId string `json:"childId"`
		}
		if err := json.Unmarshal(msg.Data, &data); err != nil || data.ChildId == "" {
			sendErr("missing childId")
			return
		}
		child, err := c.mgr.Share(msg.MachineId, data.ChildId)
		if err != nil {
			log.Error("share failed", "err", err)
			sendErr(err.Error())
			return
		}
		sendOk("machine:shared", map[string]string{"childId": child.Id})

	case "command:delete":
		// DeleteBatch handles running, frozen, and shared-child cleanup uniformly,
		// so command:delete is just the single-target variant of the same flow.
		// Idempotent: deleting a missing machine is a no-op, still reports success.
		c.mgr.DeleteBatch([]string{msg.MachineId})
		sendOk("machine:deleted", nil)

	case "command:delete-batch":
		var data struct {
			MachineIds []string `json:"machineIds"`
		}
		if err := json.Unmarshal(msg.Data, &data); err != nil {
			sendErr("invalid delete-batch data")
			return
		}
		c.mgr.DeleteBatch(data.MachineIds)
		sendOk("machines:deleted", map[string]any{"count": len(data.MachineIds)})

	case "command:activate":
		ports, err := c.mgr.Activate(msg.MachineId)
		if err != nil {
			log.Error("activate failed", "err", err)
			sendErr(err.Error())
			return
		}
		sendOk("machine:activated", map[string]any{"ports": ports})

	case "command:deactivate":
		c.mgr.Deactivate()
		sendOk("machine:deactivated", nil)

	case "command:create-template":
		var data struct {
			TemplateId string `json:"templateId"`
			Name       string `json:"name"`
		}
		if err := json.Unmarshal(msg.Data, &data); err != nil || data.TemplateId == "" || data.Name == "" {
			sendErr("missing templateId or name")
			return
		}
		// Freeze the machine first if it's running.
		m := c.mgr.Get(msg.MachineId)
		if m != nil && m.State != MachineFrozen {
			if err := c.mgr.Freeze(msg.MachineId); err != nil {
				sendErr("freeze before template: " + err.Error())
				return
			}
		}
		if err := CreateTemplate(msg.MachineId, data.TemplateId, data.Name); err != nil {
			log.Error("create-template failed", "err", err)
			sendErr(err.Error())
			return
		}
		// Source machine is consumed: the template now owns a copy of its upper dir,
		// so the source's frozen state and on-disk data are no longer needed.
		if err := c.mgr.ConsumeFrozen(msg.MachineId); err != nil {
			log.Error("consume frozen failed", "err", err)
		}
		sendOk("template:created", map[string]string{"templateId": data.TemplateId})

	case "command:delete-template":
		if err := DeleteTemplate(msg.MachineId); err != nil {
			log.Error("delete-template failed", "err", err)
			sendErr(err.Error())
			return
		}
		sendOk("template:deleted", nil)

	case "command:create-from-template":
		// Empty templateId is allowed and means "create a blank machine from base layer".
		// machineName, if provided, becomes the container hostname (visible in prompts).
		var data struct {
			TemplateId  string `json:"templateId"`
			MachineName string `json:"machineName"`
		}
		_ = json.Unmarshal(msg.Data, &data)
		if _, err := c.mgr.CreateFromTemplate(msg.MachineId, data.TemplateId, data.MachineName); err != nil {
			log.Error("create-from-template failed", "err", err)
			sendErr(err.Error())
			return
		}
		sendOk("machine:created", map[string]string{"templateId": data.TemplateId})

	case "command:inject-secrets":
		var data struct {
			Secrets []KeyValue `json:"secrets"`
		}
		if err := json.Unmarshal(msg.Data, &data); err != nil {
			sendErr("invalid secrets data")
			return
		}
		if err := InjectSecrets(msg.MachineId, data.Secrets); err != nil {
			log.Error("inject-secrets failed", "err", err)
			sendErr(err.Error())
			return
		}
		sendOk("secrets:injected", nil)

	case "command:get-output":
		m := c.mgr.Get(msg.MachineId)
		output := ""
		if m != nil && m.outputLog != nil {
			output = m.outputLog.ReadCleanTail(8192)
		}
		sendOk("machine:output", map[string]string{"output": output})

	case "command:fs-list":
		var data struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal(msg.Data, &data)
		abs, entries, err := FsList(msg.MachineId, data.Path)
		if err != nil {
			log.Error("fs-list failed", "err", err)
			sendErr(err.Error())
			return
		}
		sendOk("machine:fs-list", map[string]any{
			"path":    abs,
			"entries": entries,
		})

	case "command:exec":
		// One-shot run-and-return. Used by /api/canvas/machines/:id/exec
		// — an agent inside one machine running a command on a peer in
		// the same arrangement. Distinct from `command:share` (which
		// creates a persistent shared PTY session) — this is the
		// docker-exec-without-tty equivalent.
		var data struct {
			Cmd     []string `json:"cmd"`
			Workdir string   `json:"workdir"`
		}
		if err := json.Unmarshal(msg.Data, &data); err != nil || len(data.Cmd) == 0 {
			sendErr("exec: missing cmd")
			return
		}
		workdir := data.Workdir
		if workdir == "" {
			_, _, _, home := hostUser()
			workdir = home
		}
		out, err := ExecCommandNonInteractive(msg.MachineId, data.Cmd, workdir).CombinedOutput()
		exitCode := 0
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				// Process ran and exited non-zero. That's a NORMAL exec
				// result, not an infra failure — caller gets the code +
				// stdout/stderr and decides what to do.
				exitCode = ee.ExitCode()
			} else {
				// Setup failure (couldn't even spawn). Surface as a
				// daemon error so callers don't mistake it for "command
				// ran and failed".
				log.Error("exec setup failed", "err", err)
				sendErr(fmt.Sprintf("exec: %v", err))
				return
			}
		}
		sendOk("machine:execed", map[string]any{
			"output":   string(out),
			"exitCode": exitCode,
		})

	case "command:fs-read":
		var data struct {
			Path     string `json:"path"`
			MaxBytes int64  `json:"maxBytes"`
		}
		_ = json.Unmarshal(msg.Data, &data)
		res, err := FsRead(msg.MachineId, data.Path, data.MaxBytes)
		if err != nil {
			log.Error("fs-read failed", "err", err)
			sendErr(err.Error())
			return
		}
		sendOk("machine:fs-read", res)

	default:
		log.Warn("unknown message type")
	}
}

// Send sends a message to the backend (no trace context).
func (c *ControlClient) Send(msg ControlMessage) {
	c.SendInContext(context.Background(), msg)
}

// SendInContext is like Send but propagates the trace context attached to
// ctx into the outbound envelope (so the backend can stitch the round-trip
// onto the originating trace).
func (c *ControlClient) SendInContext(ctx context.Context, msg ControlMessage) {
	if msg.Traceparent == "" {
		msg.Traceparent = TraceparentFromContext(ctx)
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.conn == nil {
		return
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		LogWith(ctx).Error("control send failed", "err", err)
	}
}

// SendMachineStatus notifies the backend about a machine state change.
func (c *ControlClient) SendMachineStatus(machineId string, status string) {
	c.Send(ControlMessage{
		Type:      "machine:status",
		MachineId: machineId,
		Data:      mustMarshal(map[string]string{"status": status}),
	})
}

// outputPushLoop sends ANSI-stripped output for all running machines every 5 seconds.
func (c *ControlClient) outputPushLoop() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			c.pushAllOutputs()
		}
	}
}

func (c *ControlClient) pushAllOutputs() {
	c.mu.Lock()
	connected := c.conn != nil
	c.mu.Unlock()
	if !connected {
		return
	}

	machines := c.mgr.List()
	for _, info := range machines {
		if info.State == "frozen" || info.State == "stopped" {
			continue
		}
		m := c.mgr.Get(info.Id)
		if m == nil || m.outputLog == nil {
			continue
		}
		output := m.outputLog.ReadCleanTail(8192)
		if output == "" {
			continue
		}
		c.Send(ControlMessage{
			Type:      "machine:output-sync",
			MachineId: info.Id,
			Data:      mustMarshal(map[string]string{"output": output}),
		})
	}
}

// metricsPushLoop collects + pushes per-machine metrics every 30s.
// Pushes ALL machines, frozen included — the UI shows disk usage even for
// frozen rows. Gets a 2s head start after daemon boot so the UI gets data fast.
func (c *ControlClient) metricsPushLoop() {
	select {
	case <-c.done:
		return
	case <-time.After(2 * time.Second):
	}
	c.pushAllMetrics()

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			c.pushAllMetrics()
		}
	}
}

// activityPushLoop streams per-machine activity to the backend the moment it
// changes, so the UI feels live without waiting for the 30s metrics tick. It
// polls the in-process activity state at a fast cadence (cheap — no I/O) and
// sends a "machine:activity" message only for machines whose activity actually
// changed since the last push (fingerprint diff). This is the realtime path;
// the 30s metrics push remains the source of truth for cpu/mem/disk/ports.
func (c *ControlClient) activityPushLoop() {
	select {
	case <-c.done:
		return
	case <-time.After(1 * time.Second):
	}

	ticker := time.NewTicker(750 * time.Millisecond)
	defer ticker.Stop()

	lastSent := map[string]string{}
	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			c.mu.Lock()
			connected := c.conn != nil
			c.mu.Unlock()
			if !connected {
				continue
			}

			seen := map[string]bool{}
			for _, p := range c.mgr.CollectActivity() {
				seen[p.MachineId] = true
				data := mustMarshal(p)
				if lastSent[p.MachineId] == string(data) {
					continue // unchanged — skip
				}
				lastSent[p.MachineId] = string(data)
				c.Send(ControlMessage{
					Type:      "machine:activity",
					MachineId: p.MachineId,
					Data:      data,
				})
			}
			// Drop fingerprints for machines that no longer exist so the map
			// doesn't grow with churn.
			for id := range lastSent {
				if !seen[id] {
					delete(lastSent, id)
				}
			}
		}
	}
}

func (c *ControlClient) pushAllMetrics() {
	c.mu.Lock()
	connected := c.conn != nil
	c.mu.Unlock()
	if !connected {
		return
	}

	for _, info := range c.mgr.List() {
		m := c.mgr.Get(info.Id)
		if m == nil {
			continue
		}
		metrics := CollectMetrics(m)
		// Only primary machines carry the container rollup; shared terminals
		// (panes) are folded into their parent's group, not summarized alone.
		if info.SharedWith == "" {
			metrics.Group = c.mgr.ActivityGroup(info.Id)
		}
		c.Send(ControlMessage{
			Type:      "machine:metrics-push",
			MachineId: info.Id,
			Data:      mustMarshal(metrics),
		})
	}
}

// Stop closes the connection.
func (c *ControlClient) Stop() {
	close(c.done)
	c.mu.Lock()
	if c.conn != nil {
		c.conn.Close()
	}
	c.mu.Unlock()
}

func mustMarshal(v any) json.RawMessage {
	data, _ := json.Marshal(v)
	return data
}
