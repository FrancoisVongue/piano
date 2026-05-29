package api

// Machine mirrors daemon's MachineInfo (see daemon/machine_mgr.go:14).
// Lowercase fields like `hostname` may be empty — the daemon omits them.
type Machine struct {
	ID         string `json:"id"`
	State      string `json:"state"`
	Attached   bool   `json:"attached"`
	ParentID   string `json:"parentId,omitempty"`
	SharedWith string `json:"sharedWith,omitempty"`
	Hostname   string `json:"hostname,omitempty"`
	MachineIP  string `json:"machineIP,omitempty"`
}

// DisplayName picks the most human-friendly identifier we have:
// hostname when the daemon set one (e.g. via fork), otherwise the first
// 12 chars of the id. The CLI uses this for the NAME column and as one
// of the resolve targets.
func (m Machine) DisplayName() string {
	if m.Hostname != "" {
		return m.Hostname
	}
	if len(m.ID) > 12 {
		return m.ID[:12]
	}
	return m.ID
}

func (c *Client) MachineList() ([]Machine, error) {
	return do[[]Machine](c, "GET", "/machines", nil)
}

// MachineDelete: daemon responds 204 on success.
func (c *Client) MachineDelete(id string) error {
	return doVoid(c, "DELETE", "/machines/"+id, nil)
}

// MachineFreeze: daemon responds 204 on success.
func (c *Client) MachineFreeze(id string) error {
	return doVoid(c, "POST", "/machines/"+id+"/freeze", nil)
}

// MachineIssueCanvasTokenResponse is the body of POST /api/machines/:id/canvas-token —
// returned by the backend exactly once, the only time the plaintext crosses
// the wire. Caller must persist `Token` immediately or it's gone for good.
type MachineIssueCanvasTokenResponse struct {
	Token     string `json:"token"`
	MachineID string `json:"machineId"`
}

// MachineIssueCanvasToken hits the backend (not the daemon). Requires a
// host-side user session — call only from a Client built with NewUser.
func (c *Client) MachineIssueCanvasToken(machineID string) (MachineIssueCanvasTokenResponse, error) {
	return doSuccess[MachineIssueCanvasTokenResponse](c, "POST", "/api/machines/"+machineID+"/canvas-token", nil)
}

type branchRequest struct {
	ChildID     string `json:"childId"`
	MachineName string `json:"machineName,omitempty"`
}

// MachineBranch: daemon responds 201 with the child's MachineInfo.
func (c *Client) MachineBranch(parentID, childID, name string) (Machine, error) {
	return do[Machine](c, "POST", "/machines/"+parentID+"/branch",
		branchRequest{ChildID: childID, MachineName: name})
}
