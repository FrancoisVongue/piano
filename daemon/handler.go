package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	// Only allow WebSocket upgrades from localhost origins.
	// Remote pages should never be able to open a WebSocket to the daemon.
	CheckOrigin: func(r *http.Request) bool {
		return isLocalhostOrigin(r.Header.Get("Origin"))
	},
}

// HandleWS upgrades to WebSocket and attaches to a machine (creating it if needed).
// The PTY survives WebSocket disconnects — the WS is just an attachable viewer.
func HandleWS(mgr *MachineManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		machineId := r.URL.Query().Get("machineId")
		if machineId == "" {
			http.Error(w, "missing machineId query parameter", http.StatusBadRequest)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("[%s] websocket upgrade failed: %v", machineId, err)
			return
		}

		machine, err := mgr.GetOrCreate(machineId)
		if err != nil {
			log.Printf("[%s] create failed: %v", machineId, err)
			conn.Close()
			return
		}

		machine.Attach(conn)
		machine.HandleInput(conn) // blocks until WS closes
		machine.Detach(conn)
	}
}

// HandleListMachines returns a JSON array of all active machines.
func HandleListMachines(mgr *MachineManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		infos := mgr.List()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(infos)
	}
}

// HandleDeleteMachine destroys a machine by id parsed from the URL path.
// Expects DELETE /machines/{id}
func HandleDeleteMachine(mgr *MachineManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		id := strings.TrimPrefix(r.URL.Path, "/machines/")
		if id == "" {
			http.Error(w, "missing machine id", http.StatusBadRequest)
			return
		}

		// Same policy as control.go: idempotent batch delete handles all
		// states (running / detached / frozen / stopped) and shared-child
		// cascade uniformly. Single-target Delete used to refuse Frozen
		// machines, which made the HTTP and control-plane paths diverge.
		mgr.DeleteBatch([]string{id})
		w.WriteHeader(http.StatusNoContent)
	}
}

// HandleFreezeMachine freezes a running machine, making it a branchable checkpoint.
// Expects POST /machines/{id}/freeze
func HandleFreezeMachine(mgr *MachineManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Path: /machines/{id}/freeze — strip suffix first, then prefix.
		path := strings.TrimSuffix(r.URL.Path, "/freeze")
		id := strings.TrimPrefix(path, "/machines/")
		if id == "" {
			http.Error(w, "missing machine id", http.StatusBadRequest)
			return
		}

		if err := mgr.Freeze(id); err != nil {
			if strings.Contains(err.Error(), "not found") {
				http.Error(w, err.Error(), http.StatusNotFound)
			} else {
				http.Error(w, err.Error(), http.StatusConflict)
			}
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// HandleBranchMachine creates a child machine from any parent (running or frozen).
// Expects POST /machines/{id}/branch with JSON body:
// {"childId": "...", "machineName": "optional hostname"}
func HandleBranchMachine(mgr *MachineManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		path := strings.TrimSuffix(r.URL.Path, "/branch")
		parentId := strings.TrimPrefix(path, "/machines/")
		if parentId == "" {
			http.Error(w, "missing machine id", http.StatusBadRequest)
			return
		}

		var body struct {
			ChildId     string `json:"childId"`
			MachineName string `json:"machineName"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ChildId == "" {
			http.Error(w, "missing childId in request body", http.StatusBadRequest)
			return
		}

		child, err := mgr.Branch(parentId, body.ChildId, body.MachineName)
		if err != nil {
			if strings.Contains(err.Error(), "not found") {
				http.Error(w, err.Error(), http.StatusNotFound)
			} else {
				http.Error(w, err.Error(), http.StatusConflict)
			}
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(MachineInfo{
			Id:       child.Id,
			State:    child.State.String(),
			ParentId: child.parentId,
			Hostname: child.hostname,
		})
	}
}
