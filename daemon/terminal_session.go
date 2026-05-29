package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"

	"github.com/gorilla/websocket"
)

// terminalSession is a single browser ↔ machine terminal stream multiplexed
// over the daemon ↔ backend control WS. Lifetime:
//
//   1. Backend sends `terminal:open {sessionId, machineId}`.
//   2. We dial our own /ws?machineId=… on localhost so the existing PTY-attach
//      handler can do its job — no duplicated logic, no new entrypoints.
//   3. Output goroutine pumps `inner.ReadMessage()` → control plane as
//      `terminal:out {sessionId, frame:base64}` (base64 keeps the JSON
//      envelope clean for arbitrary PTY bytes).
//   4. Backend `terminal:in {sessionId, frame}` → forwarded as a raw text
//      frame to the loopback WS. Frame format is the same JSON shape the
//      browser /ws handler already speaks.
//   5. Either side closing → close inner WS, drop from map, send
//      `terminal:close` so the peer can release its half.
type terminalSession struct {
	id        string
	machineId string
	inner     *websocket.Conn
}

// openTerminal — handler for `terminal:open`. Dials loopback, sends ack,
// kicks off the output pump. Failures land as `terminal:open-failed` so the
// backend's awaiting promise can reject without a 30s timeout.
func (c *ControlClient) openTerminal(sessionId, machineId string) {
	if sessionId == "" || machineId == "" {
		c.sendOpenFailed(sessionId, machineId, "missing sessionId or machineId")
		return
	}

	u := url.URL{
		Scheme:   "ws",
		Host:     fmt.Sprintf("127.0.0.1:%d", c.localPort),
		Path:     "/ws",
		RawQuery: "machineId=" + url.QueryEscape(machineId),
	}
	// Loopback dialer has no browser-set Origin; supply a localhost one so
	// the daemon's own CheckOrigin (which rejects empty Origin to keep
	// browser pages out) lets this in.
	headers := http.Header{"Origin": []string{"http://127.0.0.1"}}
	inner, _, err := websocket.DefaultDialer.Dial(u.String(), headers)
	if err != nil {
		log.Printf("[terminal/%s] loopback dial failed: %v", sessionId, err)
		c.sendOpenFailed(sessionId, machineId, err.Error())
		return
	}

	s := &terminalSession{id: sessionId, machineId: machineId, inner: inner}
	c.sessionsMu.Lock()
	c.sessions[sessionId] = s
	c.sessionsMu.Unlock()

	c.Send(ControlMessage{
		Type:      "terminal:opened",
		MachineId: machineId,
		Data:      mustMarshal(map[string]string{"sessionId": sessionId}),
	})
	log.Printf("[terminal/%s] opened (machine %s)", sessionId, machineId)

	go c.pumpTerminalOut(s)
}

func (c *ControlClient) sendOpenFailed(sessionId, machineId, reason string) {
	c.Send(ControlMessage{
		Type:      "terminal:open-failed",
		MachineId: machineId,
		Data:      mustMarshal(map[string]string{"sessionId": sessionId, "error": reason}),
	})
}

// pumpTerminalOut reads everything the loopback WS emits and forwards to the
// backend. Reader and sender are split across two goroutines connected by a
// buffered channel so a slow control-plane write doesn't hold c.mu while the
// PTY keeps emitting.
//
// On top of the decoupling we drain the channel into 32KB batches before
// each Send: under heavy stdout this turns thousands of small frames into
// a handful of larger ones, dropping JSON+base64 overhead and c.mu acquire
// count by 1-2 orders of magnitude.
//
// Backpressure: when the channel buffer (128) fills, the reader blocks on
// `frames <- raw`. ReadMessage blocks. The OS TCP buffer fills next.
// Eventually the program writing to the PTY blocks on its write — exactly
// the right thing.
func (c *ControlClient) pumpTerminalOut(s *terminalSession) {
	defer func() {
		c.sessionsMu.Lock()
		// Only delete if we're still the registered session — closeTerminal
		// from an external trigger may have already replaced or removed us.
		if cur, ok := c.sessions[s.id]; ok && cur == s {
			delete(c.sessions, s.id)
		}
		c.sessionsMu.Unlock()
		s.inner.Close()
		c.Send(ControlMessage{
			Type:      "terminal:close",
			MachineId: s.machineId,
			Data:      mustMarshal(map[string]string{"sessionId": s.id}),
		})
		log.Printf("[terminal/%s] closed", s.id)
	}()

	const batchCap = 32 * 1024
	frames := make(chan []byte, 128)

	// Reader goroutine — copies into the channel because gorilla reuses the
	// returned slice on the next ReadMessage.
	go func() {
		defer close(frames)
		for {
			_, raw, err := s.inner.ReadMessage()
			if err != nil {
				return
			}
			frames <- append([]byte(nil), raw...)
		}
	}()

	for first := range frames {
		batch := first
	drain:
		for len(batch) < batchCap {
			select {
			case extra, ok := <-frames:
				if !ok {
					break drain
				}
				batch = append(batch, extra...)
			default:
				break drain
			}
		}
		c.Send(ControlMessage{
			Type:      "terminal:out",
			MachineId: s.machineId,
			Data: mustMarshal(map[string]string{
				"sessionId": s.id,
				"frame":     base64.StdEncoding.EncodeToString(batch),
			}),
		})
	}
}

// terminalIn forwards a frame the browser sent (already JSON, e.g.
// {"type":"input","data":"a"}) into the loopback WS.
func (c *ControlClient) terminalIn(sessionId, frame string) {
	c.sessionsMu.Lock()
	s := c.sessions[sessionId]
	c.sessionsMu.Unlock()
	if s == nil {
		return
	}
	if err := s.inner.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
		log.Printf("[terminal/%s] write failed: %v", sessionId, err)
	}
}

// closeTerminal — handler for backend's `terminal:close` (browser closed).
// Closing the loopback WS triggers pumpTerminalOut's deferred cleanup.
func (c *ControlClient) closeTerminal(sessionId string) {
	c.sessionsMu.Lock()
	s := c.sessions[sessionId]
	c.sessionsMu.Unlock()
	if s == nil {
		return
	}
	s.inner.Close()
}

// cleanupAllSessions — invoked when the control WS to backend dies. Sessions
// are bound to a specific control connection (the backend tracks them in its
// terminalSessions map keyed by sessionId, which a fresh connection has no
// memory of). Closing inner WS lets pumpTerminalOut exit and the map drain.
func (c *ControlClient) cleanupAllSessions() {
	c.sessionsMu.Lock()
	conns := make([]*websocket.Conn, 0, len(c.sessions))
	for id, s := range c.sessions {
		conns = append(conns, s.inner)
		delete(c.sessions, id)
	}
	c.sessionsMu.Unlock()
	for _, conn := range conns {
		conn.Close()
	}
}

// terminalDispatch is invoked from the control-plane message loop so the
// envelope unmarshal lives next to the rest of the routing in control.go but
// the per-message logic stays here.
func (c *ControlClient) terminalDispatch(msg ControlMessage) {
	switch msg.Type {
	case "terminal:open":
		var d struct {
			SessionId string `json:"sessionId"`
		}
		if err := json.Unmarshal(msg.Data, &d); err != nil {
			c.sendOpenFailed("", msg.MachineId, "invalid terminal:open data")
			return
		}
		go c.openTerminal(d.SessionId, msg.MachineId)
	case "terminal:in":
		var d struct {
			SessionId string `json:"sessionId"`
			Frame     string `json:"frame"`
		}
		if err := json.Unmarshal(msg.Data, &d); err != nil {
			return
		}
		c.terminalIn(d.SessionId, d.Frame)
	case "terminal:close":
		var d struct {
			SessionId string `json:"sessionId"`
		}
		if err := json.Unmarshal(msg.Data, &d); err != nil {
			return
		}
		c.closeTerminal(d.SessionId)
	}
}
