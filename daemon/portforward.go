package main

import (
	"fmt"
	"io"
	"log"
	"net"
	"os/exec"
	"sync"
)

// PortForwarder manages TCP proxies for the active machine.
// Only one machine's ports are forwarded at a time.
//
// Bridging strategy: instead of dialing machineIP:port (fails for services
// bound to 127.0.0.1 inside the container), we spawn `podman exec -i
// <container> socat - TCP:127.0.0.1:<port>` per accepted connection and
// bridge the host conn to the subprocess stdio. Works regardless of
// bind address, at the cost of one fork per new TCP connection.
type PortForwarder struct {
	mu          sync.Mutex
	activeId    string
	containerId string // targetId passed to Activate; used for podman exec
	listeners   map[int]net.Listener
	conns       []net.Conn  // active proxy connections, closed on switch
	procs       []*exec.Cmd // active podman-exec children, killed on switch
}

func NewPortForwarder() *PortForwarder {
	return &PortForwarder{
		listeners: make(map[int]net.Listener),
	}
}

// Activate starts forwarding ports for the given machine, stopping any previous forwards.
// containerId is the machine id whose container we exec into; for shared
// machines this differs from machineId (see MachineManager.Activate).
func (pf *PortForwarder) Activate(machineId string, containerId string, ports []int) error {
	pf.mu.Lock()
	defer pf.mu.Unlock()

	if pf.activeId == machineId && pf.containerId == containerId && samePortSet(pf.listeners, ports) {
		return nil
	}

	pf.stopAll()
	pf.activeId = machineId
	pf.containerId = containerId

	for _, port := range ports {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			log.Printf("[portfwd] cannot listen on :%d: %v (skipping)", port, err)
			continue
		}

		pf.listeners[port] = ln

		go pf.proxy(ln, containerId, port)
		log.Printf("[portfwd] :%d → %s (container loopback)", port, containerId)
	}

	return nil
}

func samePortSet(listeners map[int]net.Listener, ports []int) bool {
	if len(listeners) != len(ports) {
		return false
	}
	for _, port := range ports {
		if _, ok := listeners[port]; !ok {
			return false
		}
	}
	return true
}

// Deactivate stops all port forwards.
func (pf *PortForwarder) Deactivate() {
	pf.mu.Lock()
	defer pf.mu.Unlock()
	pf.stopAll()
}

// ActiveMachine returns the currently forwarded machine ID.
func (pf *PortForwarder) ActiveMachine() string {
	pf.mu.Lock()
	defer pf.mu.Unlock()
	return pf.activeId
}

func (pf *PortForwarder) stopAll() {
	// Close listeners (no new connections).
	for port, ln := range pf.listeners {
		ln.Close()
		log.Printf("[portfwd] stopped :%d", port)
	}
	pf.listeners = make(map[int]net.Listener)
	pf.activeId = ""
	pf.containerId = ""

	// Close all active proxy connections (kills keep-alive).
	for _, c := range pf.conns {
		c.Close()
	}
	pf.conns = nil

	// Kill all active podman-exec children.
	for _, p := range pf.procs {
		if p.Process != nil {
			_ = p.Process.Kill()
		}
	}
	pf.procs = nil
}

func (pf *PortForwarder) trackConn(c net.Conn) {
	pf.mu.Lock()
	pf.conns = append(pf.conns, c)
	pf.mu.Unlock()
}

func (pf *PortForwarder) trackProc(p *exec.Cmd) {
	pf.mu.Lock()
	pf.procs = append(pf.procs, p)
	pf.mu.Unlock()
}

func (pf *PortForwarder) proxy(ln net.Listener, containerId string, port int) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return // listener closed
		}
		go pf.handleConn(conn, containerId, port)
	}
}

// handleConn bridges an accepted host conn to the container's loopback
// via `podman exec -i <container> socat - TCP:127.0.0.1:<port>`.
// Works for services bound to 127.0.0.1 inside the container, which
// plain net.Dial(machineIP:port) cannot reach.
func (pf *PortForwarder) handleConn(src net.Conn, containerId string, port int) {
	pf.trackConn(src)
	defer src.Close()

	cmd := exec.Command("podman", "exec", "-i",
		containerName(containerId),
		"socat", "-", fmt.Sprintf("TCP:127.0.0.1:%d", port),
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	if err := cmd.Start(); err != nil {
		log.Printf("[portfwd] podman exec :%d failed: %v", port, err)
		return
	}
	pf.trackProc(cmd)

	done := make(chan struct{}, 2)
	go func() { io.Copy(stdin, src); stdin.Close(); done <- struct{}{} }()
	go func() { io.Copy(src, stdout); done <- struct{}{} }()
	<-done

	// Either direction closed — tear down the other side and reap.
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	_ = cmd.Wait()
}
