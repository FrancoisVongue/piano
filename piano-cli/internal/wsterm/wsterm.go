// Package wsterm is the WebSocket ↔ local-PTY bridge used by
// `piano canvas machines attach`. It owns the trickier piece of attach:
// raw-mode stdin, JSON framing inbound, binary outbound, SIGWINCH
// resize. The command file just composes endpoint + token + sessionId
// and hands the wiring here.
package wsterm

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/term"
)

// clientMessage mirrors daemon/protocol.go: ClientMessage. Inbound to
// the daemon is JSON; outbound from daemon is binary PTY bytes.
type clientMessage struct {
	Type string `json:"type"`           // "input" | "resize"
	Data string `json:"data,omitempty"` // for "input"
	Cols uint16 `json:"cols,omitempty"` // for "resize"
	Rows uint16 `json:"rows,omitempty"` // for "resize"
}

// Bridge dials the given WS URL with the bearer token, puts stdin into
// raw mode, and shuttles bytes both ways until either side closes.
// httpEndpoint is the backend's HTTP URL — we toggle the scheme to
// ws/wss and append wsPath.
func Bridge(httpEndpoint, wsPath, bearer string) error {
	wsURL, err := toWSURL(httpEndpoint, wsPath)
	if err != nil {
		return err
	}

	header := http.Header{}
	header.Set("Authorization", "Bearer "+bearer)
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		return fmt.Errorf("ws dial: %w", err)
	}
	defer ws.Close()

	// Raw stdin so per-keystroke bytes hit the remote, not line-buffered
	// readline. Restore on exit (deferred BEFORE we run, so any panic
	// returns us to a sane terminal).
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		oldState, err := term.MakeRaw(fd)
		if err == nil {
			defer term.Restore(fd, oldState)
		}
	}

	// Initial size — without this the remote PTY uses the default 80x24,
	// which is the only thing more annoying than a broken resize.
	if w, h, err := term.GetSize(fd); err == nil {
		_ = sendJSON(ws, clientMessage{Type: "resize", Cols: uint16(w), Rows: uint16(h)})
	}

	// SIGWINCH — fire a resize frame each time our terminal resizes.
	// Linux-only signal; on other platforms signal.Notify just never
	// fires for it, which is the right no-op behavior.
	winch := make(chan os.Signal, 1)
	signal.Notify(winch, syscall.SIGWINCH)
	defer signal.Stop(winch)

	var wsWrite sync.Mutex // gorilla requires serialised writes

	// stdin → ws (text JSON "input" frames)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				wsWrite.Lock()
				err2 := sendJSON(ws, clientMessage{Type: "input", Data: string(buf[:n])})
				wsWrite.Unlock()
				if err2 != nil {
					return
				}
			}
			if err != nil {
				// stdin EOF → tell the server we're done.
				wsWrite.Lock()
				_ = ws.WriteControl(
					websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, "client EOF"),
					time.Now().Add(2*time.Second),
				)
				wsWrite.Unlock()
				return
			}
		}
	}()

	// SIGWINCH → ws (resize JSON frames)
	go func() {
		for range winch {
			if w, h, err := term.GetSize(fd); err == nil {
				wsWrite.Lock()
				_ = sendJSON(ws, clientMessage{Type: "resize", Cols: uint16(w), Rows: uint16(h)})
				wsWrite.Unlock()
			}
		}
	}()

	// ws → stdout (binary frames from daemon's PTY; text frames are
	// daemon-internal control sequences like piano:replay-done — we
	// ignore those because we attached fresh).
	for {
		mt, data, err := ws.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err,
				websocket.CloseNormalClosure,
				websocket.CloseGoingAway,
				websocket.CloseNoStatusReceived,
			) {
				return nil
			}
			return fmt.Errorf("ws read: %w", err)
		}
		if mt == websocket.BinaryMessage {
			if _, err := os.Stdout.Write(data); err != nil {
				return err
			}
		}
		// Text frames: discard. The daemon uses them for replay-done /
		// other OSC-style annotations the browser handles; in the CLI
		// they'd just clutter the terminal.
	}
}

func sendJSON(ws *websocket.Conn, msg clientMessage) error {
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return ws.WriteMessage(websocket.TextMessage, b)
}

func toWSURL(httpEndpoint, wsPath string) (string, error) {
	u, err := url.Parse(httpEndpoint)
	if err != nil {
		return "", err
	}
	switch strings.ToLower(u.Scheme) {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	default:
		return "", fmt.Errorf("unexpected endpoint scheme %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + wsPath
	return u.String(), nil
}
