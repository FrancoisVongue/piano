package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// MachineInfo is a JSON-serializable summary for the list endpoint.
type MachineInfo struct {
	Id         string `json:"id"`
	State      string `json:"state"`
	Attached   bool   `json:"attached"`
	ParentId   string `json:"parentId,omitempty"`
	SharedWith string `json:"sharedWith,omitempty"`
	Hostname   string `json:"hostname,omitempty"`
	MachineIP  string `json:"machineIP,omitempty"`
}

// MachineManager tracks active machines and coordinates lifecycle.
type MachineManager struct {
	mu       sync.Mutex
	machines map[string]*Machine
	devMode  bool
	closed   bool
	control  *ControlClient
	portFwd  *PortForwarder
}

func NewMachineManager(devMode bool) *MachineManager {
	return &MachineManager{
		machines: make(map[string]*Machine),
		devMode:  devMode,
		portFwd:  NewPortForwarder(),
	}
}

// RecoverFromDisk restores machines from metadata + overlay/Podman state.
func (mgr *MachineManager) RecoverFromDisk() {
	if mgr.devMode {
		log.Println("dev mode: skipping disk recovery")
		return
	}

	metas := LoadAllMetadata()
	if len(metas) == 0 {
		log.Println("no machines to recover")
		return
	}

	for _, meta := range metas {
		// Frozen machines: check if upper dir exists.
		if meta.State == "frozen" {
			upperDir := filepath.Join(layersDir, meta.Id, "upper")
			if _, err := os.Stat(upperDir); err == nil {
				m := NewFrozenMachine(meta.Id, meta.CreatedAt, meta.ParentId, upperDir, meta.Hostname)
				mgr.machines[meta.Id] = m
				log.Printf("recovered frozen machine: %s", meta.Id)
			} else {
				log.Printf("skip frozen %s: upper dir not found", meta.Id)
			}
			continue
		}

		// Shared machines: need parent container running.
		if meta.SharedWith != "" {
			parent, ok := mgr.machines[meta.SharedWith]
			if !ok || !ContainerExists(meta.SharedWith) {
				log.Printf("skip shared %s: parent %s not available", meta.Id, meta.SharedWith)
				continue
			}
			workdir := parent.initialWorkdir
			if workdir == "" {
				_, _, _, workdir = hostUser()
			}
			ptmx, cmd, err := StartPTY(meta.SharedWith, workdir)
			if err != nil {
				log.Printf("skip shared %s: pty start failed: %v", meta.Id, err)
				continue
			}
			m := NewMachine(meta.Id, ptmx, cmd)
			m.sharedWith = meta.SharedWith
			m.hostname = meta.Hostname
			m.machineIP = parent.machineIP
			m.createdAt = meta.CreatedAt
			m.initialWorkdir = workdir
			mgr.machines[meta.Id] = m
			log.Printf("recovered shared machine: %s (parent %s)", meta.Id, meta.SharedWith)
			continue
		}

		// Running standalone machines: re-mount flat overlay and create fresh container.
		if ContainerExists(meta.Id) {
			_ = RemoveContainer(meta.Id)
		}

		upper, work, merged := PrepareMachineDirs(layersDir, meta.Id)

		if err := MountOverlay(flatLowerDirs(), upper, work, merged); err != nil {
			log.Printf("skip %s: overlay mount failed: %v", meta.Id, err)
			continue
		}

		if err := mountHomeOverlay(layersDir, meta.Id); err != nil {
			UnmountOverlay(merged)
			log.Printf("skip %s: home overlay mount failed: %v", meta.Id, err)
			continue
		}

		opts := ContainerOpts(layersDir, meta.Id)
		opts.Hostname = meta.Hostname
		workdir := opts.Workdir
		if workdir == "" {
			_, _, _, workdir = hostUser()
		}

		containerID, err := CreateContainer(meta.Id, merged, opts)
		if err != nil {
			unmountHomeOverlay(layersDir, meta.Id)
			UnmountOverlay(merged)
			log.Printf("skip %s: create container failed: %v", meta.Id, err)
			continue
		}

		ptmx, cmd, err := StartPTY(meta.Id, workdir)
		if err != nil {
			RemoveContainer(meta.Id)
			unmountHomeOverlay(layersDir, meta.Id)
			UnmountOverlay(merged)
			log.Printf("skip %s: pty start failed: %v", meta.Id, err)
			continue
		}

		ip, _ := ContainerIP(meta.Id)

		m := NewMachine(meta.Id, ptmx, cmd)
		m.createdAt = meta.CreatedAt
		m.parentId = meta.ParentId
		m.hostname = meta.Hostname
		m.initialWorkdir = workdir
		m.machineIP = ip
		m.containerID = containerID
		m.overlayMergedDir = merged
		m.overlayUpperDir = upper
		m.overlayWorkDir = work
		m.overlayMounted = true
		m.homeOverlayMounted = true
		mgr.machines[meta.Id] = m

		log.Printf("recovered machine: %s (pid %d)", meta.Id, cmd.Process.Pid)
	}

	log.Printf("recovered %d machine(s)", len(mgr.machines))
}

// GetOrCreate returns an existing machine or creates a new one.
func (mgr *MachineManager) GetOrCreate(id string) (*Machine, error) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()

	if mgr.closed {
		return nil, fmt.Errorf("manager is shutting down")
	}

	if m, ok := mgr.machines[id]; ok {
		// If PTY is dead, reconnect.
		if m.ptmx == nil || (m.cmd != nil && m.cmd.ProcessState != nil) {
			targetId := id
			if m.sharedWith != "" {
				targetId = m.sharedWith
			}

			workdir := m.initialWorkdir
			if m.sharedWith != "" {
				if parent, ok := mgr.machines[m.sharedWith]; ok {
					workdir = parent.initialWorkdir
				}
			}
			if workdir == "" {
				_, _, _, workdir = hostUser()
			}

			// Ensure container is running (may need to re-create after crash).
			if !ContainerExists(targetId) && m.overlayMounted && m.overlayMergedDir != "" {
				if !m.homeOverlayMounted {
					if homeErr := mountHomeOverlay(layersDir, targetId); homeErr != nil {
						log.Printf("[machine/%s] home overlay remount failed: %v", id, homeErr)
					} else {
						m.homeOverlayMounted = true
					}
				}
				opts := ContainerOpts(layersDir, targetId)
				opts.Hostname = m.hostname
				containerID, err := CreateContainer(targetId, m.overlayMergedDir, opts)
				if err == nil {
					m.containerID = containerID
				}
			}

			if ContainerExists(targetId) {
				ptmx, cmd, err := StartPTY(targetId, workdir)
				if err == nil {
					ol, _ := OpenOutputLog(id)
					m.ptmx = ptmx
					m.cmd = cmd
					m.outputLog = ol
					m.State = MachineDetached
					m.once = sync.Once{}
					m.wg.Add(1)
					go m.readPTY()
					log.Printf("[machine/%s] reconnected PTY (pid %d)", id, cmd.Process.Pid)
				} else {
					log.Printf("[machine/%s] reconnect PTY failed: %v", id, err)
				}
			}
		}
		return m, nil
	}

	return mgr.createMachine(id, false, "")
}

// createMachine mounts a flat overlay and creates a Podman container with --rootfs.
// Flat architecture: lowerdir is always just the base rootfs.
// All inherited state lives in upperdir (populated by reflink copy for branches/templates).
// If prepopulated is true, skips addUserToRootfs (upper already has user entries from reflink copy).
// Must be called with mgr.mu held.
func (mgr *MachineManager) createMachine(id string, prepopulated bool, hostname string) (*Machine, error) {
	createStart := time.Now()
	upper, work, merged := PrepareMachineDirs(layersDir, id)

	// Clean work dirs — may have stale state from parent snapshot.
	os.RemoveAll(work)
	os.MkdirAll(work, 0755)

	// Branched/template-spawned machines inherit the parent's output.log via the
	// BTRFS snapshot. That history belongs to the parent — feeding it through
	// vt10x on OpenOutputLog costs ~800ms on a 10MB log. Child starts fresh.
	if prepopulated {
		logPath := filepath.Join(layersDir, id, "output.log")
		if err := os.Truncate(logPath, 0); err != nil && !os.IsNotExist(err) {
			log.Printf("[create/%s] truncate inherited output.log: %v", id, err)
		}
	}

	t := time.Now()
	if err := MountOverlay(flatLowerDirs(), upper, work, merged); err != nil {
		return nil, fmt.Errorf("overlay mount: %w", err)
	}
	log.Printf("[create/%s] mount rootfs overlay: %v", id, time.Since(t))

	t = time.Now()
	if err := mountHomeOverlay(layersDir, id); err != nil {
		UnmountOverlay(merged)
		return nil, fmt.Errorf("home overlay mount: %w", err)
	}
	log.Printf("[create/%s] mount home overlay: %v", id, time.Since(t))

	if !prepopulated {
		addUserToRootfs(upper)
	}

	opts := ContainerOpts(layersDir, id)
	opts.Hostname = hostname

	t = time.Now()
	containerID, err := CreateContainer(id, merged, opts)
	if err != nil {
		unmountHomeOverlay(layersDir, id)
		UnmountOverlay(merged)
		return nil, fmt.Errorf("create container: %w", err)
	}
	log.Printf("[create/%s] podman create: %v", id, time.Since(t))

	t = time.Now()
	ptmx, cmd, err := StartPTY(id, opts.Workdir)
	if err != nil {
		RemoveContainer(id)
		unmountHomeOverlay(layersDir, id)
		UnmountOverlay(merged)
		return nil, fmt.Errorf("pty start: %w", err)
	}
	log.Printf("[create/%s] start PTY: %v", id, time.Since(t))

	log.Printf("[create/%s] TOTAL: %v (pid %d)", id, time.Since(createStart), cmd.Process.Pid)

	t = time.Now()
	m := NewMachine(id, ptmx, cmd)
	log.Printf("[create/%s] NewMachine+OpenOutputLog: %v", id, time.Since(t))
	m.containerID = containerID
	m.hostname = hostnameOrFallback(hostname, id)
	m.initialWorkdir = opts.Workdir
	m.overlayMergedDir = merged
	m.overlayUpperDir = upper
	m.overlayWorkDir = work
	m.overlayMounted = true
	m.homeOverlayMounted = true
	mgr.machines[id] = m

	t = time.Now()
	if err := SaveMetadata(m); err != nil {
		log.Printf("[machine/%s] save metadata failed: %v", id, err)
	}
	log.Printf("[create/%s] SaveMetadata: %v", id, time.Since(t))

	// Resolve container IP asynchronously — saves ~30ms on the hot path.
	// Activate/Share block via Machine.IP() if they need it before async completes.
	go m.IP()

	return m, nil
}

// Share creates a new terminal (PTY) inside an existing machine's container.
func (mgr *MachineManager) Share(parentId string, childId string) (*Machine, error) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()

	if mgr.closed {
		return nil, fmt.Errorf("manager is shutting down")
	}

	parent, ok := mgr.machines[parentId]
	if !ok {
		return nil, fmt.Errorf("parent machine not found: %s", parentId)
	}
	if parent.State != MachineRunning && parent.State != MachineDetached {
		return nil, fmt.Errorf("can only share from running machines (parent %s is %s)", parentId, parent.State)
	}
	if parent.sharedWith != "" {
		return nil, fmt.Errorf("cannot share from a shared terminal")
	}
	if _, exists := mgr.machines[childId]; exists {
		return nil, fmt.Errorf("machine already exists: %s", childId)
	}

	os.MkdirAll(filepath.Join(layersDir, childId), 0755)

	workdir := parent.initialWorkdir
	if workdir == "" {
		workdir = os.Getenv("HOME")
	}

	ptmx, cmd, err := StartPTY(parentId, workdir)
	if err != nil {
		return nil, fmt.Errorf("pty start: %w", err)
	}
	log.Printf("[machine/%s] shared shell started (pid %d, parent %s)", childId, cmd.Process.Pid, parentId)

	m := NewMachine(childId, ptmx, cmd)
	m.sharedWith = parentId
	m.machineIP = parent.IP()
	m.initialWorkdir = workdir
	mgr.machines[childId] = m

	if err := SaveMetadata(m); err != nil {
		log.Printf("[machine/%s] save metadata failed: %v", childId, err)
	}

	return m, nil
}

// Get returns a machine by id, or nil if not found.
func (mgr *MachineManager) Get(id string) *Machine {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	return mgr.machines[id]
}

// getSharedChildren returns all shared terminals of the given parent.
func (mgr *MachineManager) getSharedChildren(parentId string) []*Machine {
	var children []*Machine
	for _, m := range mgr.machines {
		if m.sharedWith == parentId {
			children = append(children, m)
		}
	}
	return children
}

// DeleteBatch forcefully deletes a list of machines.
func (mgr *MachineManager) DeleteBatch(ids []string) {
	mgr.mu.Lock()
	targets := make([]*Machine, 0, len(ids))
	idSet := make(map[string]bool, len(ids))
	for _, id := range ids {
		idSet[id] = true
	}
	for _, id := range ids {
		if m, ok := mgr.machines[id]; ok {
			delete(mgr.machines, id)
			targets = append(targets, m)
		}
	}
	for id, m := range mgr.machines {
		if m.sharedWith != "" && idSet[m.sharedWith] {
			delete(mgr.machines, id)
			targets = append(targets, m)
		}
	}
	mgr.mu.Unlock()

	for _, m := range targets {
		if m.sharedWith != "" {
			m.Destroy()
			DeleteMetadata(m.Id)
		}
	}
	for _, m := range targets {
		if m.sharedWith != "" {
			continue
		}
		if m.State == MachineFrozen {
			DeleteMetadata(m.Id)
		} else {
			m.Destroy()
			DeleteMetadata(m.Id)
		}
	}
	for _, m := range targets {
		ForgetMetricsCache(m.Id)
	}
	log.Printf("deleted %d machine(s) in batch", len(targets))
}

// ConsumeFrozen removes a frozen machine without the safety guard.
func (mgr *MachineManager) ConsumeFrozen(id string) error {
	mgr.mu.Lock()
	m, ok := mgr.machines[id]
	if !ok {
		mgr.mu.Unlock()
		return fmt.Errorf("machine not found: %s", id)
	}
	delete(mgr.machines, id)
	mgr.mu.Unlock()

	m.Destroy()
	DeleteMetadata(id)
	ForgetMetricsCache(id)
	log.Printf("frozen machine consumed: %s", id)
	return nil
}

// Single-target Delete was removed in favor of DeleteBatch, which handles
// frozen / shared / stopped machines uniformly without state-specific guards.
// Both the HTTP handler and the control-plane command:delete go through
// DeleteBatch so there's one cleanup policy rather than two.

// Freeze unmounts the overlay and marks the machine as frozen.
func (mgr *MachineManager) Freeze(id string) error {
	mgr.mu.Lock()
	m, ok := mgr.machines[id]
	if !ok {
		mgr.mu.Unlock()
		return fmt.Errorf("machine not found: %s", id)
	}
	if m.State == MachineFrozen {
		mgr.mu.Unlock()
		return fmt.Errorf("machine already frozen: %s", id)
	}
	if m.sharedWith != "" {
		mgr.mu.Unlock()
		return fmt.Errorf("cannot freeze a shared terminal: %s", id)
	}

	children := mgr.getSharedChildren(id)
	for _, child := range children {
		delete(mgr.machines, child.Id)
	}
	mgr.mu.Unlock()

	for _, child := range children {
		child.Destroy()
		DeleteMetadata(child.Id)
		log.Printf("auto-closed shared terminal %s (parent %s freezing)", child.Id, id)
	}

	m.Freeze()

	if err := SaveMetadata(m); err != nil {
		log.Printf("[machine/%s] save metadata after freeze failed: %v", id, err)
	}
	return nil
}

// Branch creates a new machine by BTRFS-snapshotting the parent's upper dirs.
// Flat architecture: child gets lowerdir=base + its own upper (COW snapshot of parent's upper).
// For running parents: podman pause -> btrfs snapshot -> podman unpause (milliseconds).
// For frozen parents: btrfs snapshot only (no pause needed).
func (mgr *MachineManager) Branch(parentId string, childId string, machineName string) (*Machine, error) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()

	if mgr.closed {
		return nil, fmt.Errorf("manager is shutting down")
	}

	parent, ok := mgr.machines[parentId]
	if !ok {
		return nil, fmt.Errorf("parent not found: %s", parentId)
	}
	if parent.State == MachineStopped {
		return nil, fmt.Errorf("cannot branch from stopped machine: %s", parentId)
	}
	if parent.sharedWith != "" {
		return nil, fmt.Errorf("cannot branch from a shared terminal: %s", parentId)
	}
	if _, exists := mgr.machines[childId]; exists {
		return nil, fmt.Errorf("machine already exists: %s", childId)
	}

	branchStart := time.Now()

	// For running/detached parents: pause to get consistent snapshot.
	// If the runtime has no cgroup (podman cgroups=disabled), degrade gracefully:
	// skip pause and rely on the atomicity of the BTRFS snapshot. In-flight writes
	// may appear torn in the snapshot, which is acceptable for terminal workloads.
	needPause := parent.State != MachineFrozen
	paused := false
	if needPause {
		t := time.Now()
		err := PauseContainerByID(parent.containerID, parentId)
		switch {
		case err == nil:
			paused = true
			log.Printf("[branch/%s] pause: %v", childId, time.Since(t))
		case errors.Is(err, ErrPauseUnsupported):
			log.Printf("[branch/%s] WARNING: pause unsupported (no cgroup), snapshotting without pause", childId)
		default:
			return nil, fmt.Errorf("pause parent: %w", err)
		}
	}

	// BTRFS snapshot entire machine dir (O(1) — single metadata operation regardless of file count).
	parentDir := filepath.Join(layersDir, parentId)
	childDir := filepath.Join(layersDir, childId)
	if err := btrfsSnapshot(parentDir, childDir); err != nil {
		if paused {
			UnpauseContainerByID(parent.containerID, parentId)
		}
		return nil, fmt.Errorf("snapshot machine dir: %w", err)
	}

	// Unpause parent — it continues running, completely unaware.
	if paused {
		t := time.Now()
		if err := UnpauseContainerByID(parent.containerID, parentId); err != nil {
			log.Printf("[branch] WARNING: unpause parent %s failed: %v", parentId, err)
		}
		log.Printf("[branch/%s] unpause: %v", childId, time.Since(t))
		log.Printf("[branch/%s] parent frozen for: %v", childId, time.Since(branchStart))
	}

	// Create child machine with flat overlay (lowerdir=base, upperdir=btrfs snapshot).
	t := time.Now()
	m, err := mgr.createMachine(childId, true, machineName)
	if err != nil {
		return nil, err
	}
	log.Printf("[branch/%s] createMachine: %v", childId, time.Since(t))
	m.parentId = parentId

	if err := SaveMetadata(m); err != nil {
		log.Printf("[machine/%s] save metadata failed: %v", childId, err)
	}

	log.Printf("[branch/%s] TOTAL: %v (from %s, btrfs snapshot)", childId, time.Since(branchStart), parentId)
	return m, nil
}

// CreateFromTemplate creates a new machine using a template's overlay layers.
// Empty templateId means "create a blank machine using only the base layer".
// With flat architecture, template upper is BTRFS-snapshotted to machine upper.
// machineName, when non-empty, becomes the container's hostname (visible in
// shell prompts). Empty falls back to a normalised form of machineId.
func (mgr *MachineManager) CreateFromTemplate(machineId string, templateId string, machineName string) (*Machine, error) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()

	if mgr.closed {
		return nil, fmt.Errorf("manager is shutting down")
	}
	if _, exists := mgr.machines[machineId]; exists {
		return nil, fmt.Errorf("machine already exists: %s", machineId)
	}

	prepopulated := false
	if templateId != "" && templateId != HostTemplateSentinel {
		srcDir := filepath.Join(layersDir, "templates", templateId)
		if _, err := os.Stat(filepath.Join(srcDir, "upper")); err != nil {
			return nil, fmt.Errorf("template %s upper dir not found: %w", templateId, err)
		}
		dstDir := filepath.Join(layersDir, machineId)
		if err := btrfsSnapshot(srcDir, dstDir); err != nil {
			return nil, fmt.Errorf("snapshot template: %w", err)
		}
		prepopulated = true
	}

	return mgr.createMachine(machineId, prepopulated, machineName)
}

// Activate starts port forwarding for a machine.
func (mgr *MachineManager) Activate(id string) ([]int, error) {
	mgr.mu.Lock()
	m, ok := mgr.machines[id]
	mgr.mu.Unlock()

	if !ok {
		return nil, fmt.Errorf("machine not found: %s", id)
	}
	targetId := id
	if m.sharedWith != "" {
		targetId = m.sharedWith
	}
	ports := DetectPortsInContainer(targetId)
	if len(ports) == 0 {
		return nil, fmt.Errorf("no listening ports detected in machine %s", id)
	}

	// PortForwarder bridges via `podman exec socat` into the container's
	// loopback, so the container IP is no longer needed.
	if err := mgr.portFwd.Activate(id, targetId, ports); err != nil {
		return nil, err
	}

	return ports, nil
}

// Deactivate stops port forwarding.
func (mgr *MachineManager) Deactivate() {
	mgr.portFwd.Deactivate()
}

// GetActiveMachine returns the currently port-forwarded machine ID.
func (mgr *MachineManager) GetActiveMachine() string {
	return mgr.portFwd.ActiveMachine()
}

// List returns a snapshot of all machines.
func (mgr *MachineManager) List() []MachineInfo {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()

	infos := make([]MachineInfo, 0, len(mgr.machines))
	for _, m := range mgr.machines {
		infos = append(infos, MachineInfo{
			Id:         m.Id,
			State:      m.State.String(),
			Attached:   m.State == MachineRunning,
			ParentId:   m.parentId,
			SharedWith: m.sharedWith,
			Hostname:   m.hostname,
			MachineIP:  m.machineIP,
		})
	}
	return infos
}

// ActivityGroup rolls up the terminal activity of a container: the primary
// machine plus every shared terminal that execs into it (sharedWith == parentId).
// Returns nil if the parent isn't known. Used to summarize a container's
// activity on the primary machine's metrics push.
func (mgr *MachineManager) ActivityGroup(parentId string) *ActivityGroup {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	return mgr.activityGroupLocked(parentId)
}

// activityGroupLocked is ActivityGroup without taking the lock — caller must
// hold mgr.mu. Split out so CollectActivity can roll up many primaries under a
// single lock without re-entering (Go mutexes aren't reentrant).
func (mgr *MachineManager) activityGroupLocked(parentId string) *ActivityGroup {
	parent, ok := mgr.machines[parentId]
	if !ok {
		return nil
	}

	terminals := make([]TerminalActivity, 0, 4)
	collect := func(m *Machine) {
		if m.activity == nil {
			return
		}
		terminals = append(terminals, TerminalActivity{MachineId: m.Id, Activity: m.activity.Snapshot()})
	}
	collect(parent)
	for id, m := range mgr.machines {
		if id != parentId && m.sharedWith == parentId {
			collect(m)
		}
	}
	return RollupActivity(terminals)
}

// CollectActivity snapshots every machine's activity under a single lock.
// Primary machines (sharedWith == "") also carry their container rollup. The
// control client diffs this against the last push and only sends what changed.
func (mgr *MachineManager) CollectActivity() []ActivityPush {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()

	out := make([]ActivityPush, 0, len(mgr.machines))
	for id, m := range mgr.machines {
		if m.activity == nil {
			continue
		}
		p := ActivityPush{MachineId: id, Activity: m.activity.Snapshot()}
		if m.sharedWith == "" {
			p.Group = mgr.activityGroupLocked(id)
		}
		out = append(out, p)
	}
	return out
}

// Shutdown stops all machines, unmounts overlays, and saves metadata for recovery.
// Idempotent: repeated calls return immediately after the first one marks the
// manager closed.
func (mgr *MachineManager) Shutdown() {
	mgr.mu.Lock()
	if mgr.closed {
		mgr.mu.Unlock()
		return
	}
	mgr.closed = true
	snapshot := make([]*Machine, 0, len(mgr.machines))
	for _, m := range mgr.machines {
		snapshot = append(snapshot, m)
	}
	mgr.mu.Unlock()

	if len(snapshot) == 0 {
		return
	}

	log.Printf("shutting down %d machine(s)...", len(snapshot))

	// Destroy shared terminals first.
	for _, m := range snapshot {
		if m.sharedWith != "" && m.State != MachineFrozen {
			m.Destroy()
		}
	}

	for _, m := range snapshot {
		if m.State == MachineFrozen || m.sharedWith != "" {
			continue
		}

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

		_ = RemoveContainer(m.Id)
		if m.homeOverlayMounted {
			_ = unmountHomeOverlay(layersDir, m.Id)
			m.homeOverlayMounted = false
		}
		if m.overlayMounted {
			_ = UnmountOverlay(m.overlayMergedDir)
			m.overlayMounted = false
		}

		m.State = MachineStopped
		if err := SaveMetadata(m); err != nil {
			log.Printf("%s save metadata on shutdown failed: %v", m.tag(), err)
		}
	}
	log.Println("all machines stopped (overlay layers preserved for recovery)")
}
