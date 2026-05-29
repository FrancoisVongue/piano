package api

import "net/http"

// Canvas methods speak the /api/canvas/* surface — the inverse-direction
// API where a process INSIDE a machine reads/writes its own arrangement.
// Auth is "I am machine X", injected on every request by a RoundTripper
// configured at client-creation time (see NewCanvas).
//
// Mirroring client.go's discipline: this file only declares types and
// thin method wrappers. The HTTP plumbing stays in client.go.

// CanvasNode is the wire shape returned by /api/canvas/nodes/:id. A subset of
// Prisma's Note row; we ignore fields the agent doesn't need (color,
// tags, scale...) so this struct stays small and obvious.
type CanvasNode struct {
	ID                  string  `json:"id"`
	Type                string  `json:"type"`
	Content             string  `json:"content"`
	Label               *string `json:"label"`
	X                   float64 `json:"x"`
	Y                   float64 `json:"y"`
	Version             int     `json:"version"`
	ParentID            *string `json:"parentId"`
	MachineID           *string `json:"machineId"`
	ParentMachineNodeID *string `json:"parentMachineNodeId"`
	ArrangementID       string  `json:"arrangementId"`
	// ResolvedContent is the assembled text with `+<id>` references
	// inlined. Non-nil when the read resolved (the default); nil for
	// `--raw` reads. `Content` always stays the raw text.
	ResolvedContent *string `json:"resolvedContent"`
}

func (n CanvasNode) DisplayName() string {
	if n.Label != nil && *n.Label != "" {
		return *n.Label
	}
	if len(n.ID) > 12 {
		return n.ID[:12]
	}
	return n.ID
}

type CanvasContext struct {
	ID            string `json:"id"`
	ArrangementID string `json:"arrangementId"`
	UserID        string `json:"userId"`
}

type UpdateNodeRequest struct {
	ExpectedVersion int      `json:"expectedVersion"`
	Content         *string  `json:"content,omitempty"`
	Label           *string  `json:"label,omitempty"`
	X               *float64 `json:"x,omitempty"`
	Y               *float64 `json:"y,omitempty"`
}

type CreateNodeRequest struct {
	Content  string  `json:"content"`
	Label    string  `json:"label,omitempty"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	ParentID string  `json:"parentId,omitempty"`
}

// NewCanvas builds a Client whose http.Client transparently stamps every
// request with `Authorization: Bearer <token>`. This means the standard
// `do[T]` / `doSuccess[T]` helpers below work unchanged — no parallel
// request path. The endpoint is BACKEND, not the local daemon, because
// the gateway runs in the backend process.
func NewCanvas(endpoint string, token string) *Client {
	if endpoint == "" {
		endpoint = BackendURL
	}
	return &Client{
		endpoint: endpoint,
		http:     &http.Client{Transport: addHeader{rt: http.DefaultTransport, key: "Authorization", value: "Bearer " + token}},
	}
}

// addHeader is the world's smallest http.RoundTripper: it injects one
// fixed header and delegates everything else.
type addHeader struct {
	rt    http.RoundTripper
	key   string
	value string
}

func (a addHeader) RoundTrip(req *http.Request) (*http.Response, error) {
	req.Header.Set(a.key, a.value)
	return a.rt.RoundTrip(req)
}

// NoteVersion mirrors the wire shape from GET /api/canvas/nodes/:id/versions.
type NoteVersion struct {
	ID        string  `json:"id"`
	NoteID    string  `json:"noteId"`
	Content   string  `json:"content"`
	Author    *string `json:"author"`
	CreatedAt string  `json:"createdAt"`
}

// ---- methods on Client, used in canvas mode ----

func (c *Client) CanvasMe() (CanvasContext, error) {
	return doSuccess[CanvasContext](c, "GET", "/api/canvas/me", nil)
}

func (c *Client) CanvasList() ([]CanvasNode, error) {
	return doSuccess[[]CanvasNode](c, "GET", "/api/canvas/nodes", nil)
}

// CanvasGet reads a node. With raw=false (the default for `cat`), the
// backend resolves `+<id>` references and returns the assembled text in
// ResolvedContent. With raw=true it skips resolution — used both by
// `cat --raw` and by `write` (which only needs the version, not the
// resolved body).
func (c *Client) CanvasGet(nodeID string, raw bool) (CanvasNode, error) {
	path := "/api/canvas/nodes/" + nodeID
	if raw {
		path += "?raw=1"
	}
	return doSuccess[CanvasNode](c, "GET", path, nil)
}

func (c *Client) CanvasUpdate(nodeID string, patch UpdateNodeRequest) (CanvasNode, error) {
	return doSuccess[CanvasNode](c, "PATCH", "/api/canvas/nodes/"+nodeID, patch)
}

func (c *Client) CanvasCreate(req CreateNodeRequest) (CanvasNode, error) {
	return doSuccess[CanvasNode](c, "POST", "/api/canvas/nodes", req)
}

func (c *Client) CanvasHistory(nodeID string) ([]NoteVersion, error) {
	return doSuccess[[]NoteVersion](c, "GET", "/api/canvas/nodes/"+nodeID+"/versions", nil)
}

type rollbackRequest struct {
	VersionID string `json:"versionId"`
}

func (c *Client) CanvasRollback(nodeID, versionID string) (CanvasNode, error) {
	return doSuccess[CanvasNode](c, "POST", "/api/canvas/nodes/"+nodeID+"/rollback", rollbackRequest{VersionID: versionID})
}

// ---- /api/canvas/machines/* — peer-machine surface ----

// PeerMachine is the Note-row projection returned by GET /api/canvas/machines.
// Fields the agent picks targets by — id, label, type, daemon. We don't
// surface position/style because the agent doesn't move peers.
type PeerMachine struct {
	ID                  string  `json:"id"`        // Note row id
	MachineID           *string `json:"machineId"` // daemon machine id (what exec/attach uses)
	Type                string  `json:"type"`
	Label               *string `json:"label"`
	Status              *string `json:"status"`
	ParentMachineNodeID *string `json:"parentMachineNodeId"`
	DaemonID            *string `json:"daemonId"`
	CreatedAt           string  `json:"createdAt"`
}

func (p PeerMachine) DisplayName() string {
	if p.Label != nil && *p.Label != "" {
		return *p.Label
	}
	if p.MachineID != nil && *p.MachineID != "" {
		m := *p.MachineID
		if len(m) > 12 {
			return m[:12]
		}
		return m
	}
	return p.ID
}

func (c *Client) CanvasMachinesList() ([]PeerMachine, error) {
	return doSuccess[[]PeerMachine](c, "GET", "/api/canvas/machines", nil)
}

func (c *Client) CanvasMachinesGet(peerID string) (PeerMachine, error) {
	return doSuccess[PeerMachine](c, "GET", "/api/canvas/machines/"+peerID, nil)
}

type peerOutputResponse struct {
	Output string `json:"output"`
}

func (c *Client) CanvasMachinesOutput(peerID string) (string, error) {
	resp, err := doSuccess[peerOutputResponse](c, "GET", "/api/canvas/machines/"+peerID+"/output", nil)
	return resp.Output, err
}

type execRequest struct {
	Cmd     []string `json:"cmd"`
	Workdir string   `json:"workdir,omitempty"`
}

// ExecResult mirrors `docker exec`: combined stdout+stderr in Output,
// process exit code in ExitCode. Non-zero ExitCode is a normal result.
type ExecResult struct {
	Output   string `json:"output"`
	ExitCode int    `json:"exitCode"`
}

func (c *Client) CanvasMachinesExec(peerID string, cmd []string, workdir string) (ExecResult, error) {
	return doSuccess[ExecResult](c, "POST", "/api/canvas/machines/"+peerID+"/exec",
		execRequest{Cmd: cmd, Workdir: workdir})
}

type spawnRequest struct {
	TemplateID string `json:"templateId,omitempty"`
	Label      string `json:"label,omitempty"`
}

type SpawnResult struct {
	MachineID string `json:"machineId"`
	NoteID    string `json:"noteId"`
}

func (c *Client) CanvasMachinesSpawn(templateID, label string) (SpawnResult, error) {
	return doSuccess[SpawnResult](c, "POST", "/api/canvas/machines",
		spawnRequest{TemplateID: templateID, Label: label})
}

func (c *Client) CanvasMachinesFreeze(peerID string) error {
	return doVoid(c, "POST", "/api/canvas/machines/"+peerID+"/freeze", nil)
}

func (c *Client) CanvasMachinesRemove(peerID string) error {
	return doVoid(c, "DELETE", "/api/canvas/machines/"+peerID, nil)
}

// AttachSession is what `POST /api/canvas/machines/:id/attach` returns —
// a sub-PTY session id and the WebSocket path to dial with the same
// Bearer token. The session lives until the WS closes.
type AttachSession struct {
	SessionID string `json:"sessionId"`
	WsPath    string `json:"wsPath"`
}

func (c *Client) CanvasMachinesAttachStart(peerID string) (AttachSession, error) {
	return doSuccess[AttachSession](c, "POST", "/api/canvas/machines/"+peerID+"/attach", nil)
}
