package main

// Message types sent by the client over WebSocket.
const (
	MsgTypeInput  = "input"
	MsgTypeResize = "resize"
	MsgTypeFile   = "file"
)

// ClientMessage is the JSON envelope the browser sends over the WebSocket.
type ClientMessage struct {
	Type string `json:"type"`
	Data string `json:"data"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
	Path string `json:"path"`
}
