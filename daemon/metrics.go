package main

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MachineMetrics is a point-in-time snapshot pushed to the backend.
// Memory is in bytes, uptime in seconds, disk in bytes, CPU as a percentage
// (0..100+). Frozen/stopped machines only fill UptimeSeconds + DiskUsageBytes.
type MachineMetrics struct {
	MemUsageBytes  int64    `json:"memUsageBytes"`
	MemLimitBytes  int64    `json:"memLimitBytes"`
	CPUPercent     float64  `json:"cpuPercent"`
	UptimeSeconds  int64    `json:"uptimeSeconds"`
	DiskUsageBytes int64    `json:"diskUsageBytes"`
	ListeningPorts []int    `json:"listeningPorts,omitempty"`
	State          string   `json:"state"` // mirror of m.State so the UI can detect frozen rows
	Activity       Activity `json:"activity"`
	// Group is the container-level activity rollup. Set only on the primary
	// machine (sharedWith == ""), attached in control.pushAllMetrics — that's
	// where the manager (and thus the sharedWith topology) is in scope.
	Group     *ActivityGroup `json:"activityGroup,omitempty"`
	Timestamp time.Time      `json:"timestamp"`
}

// diskSample is a single memoized `du` result. Refreshed every diskTTL.
type diskSample struct {
	bytes int64
	taken time.Time
}

// `du` is slow (filesystem walk). We cache the result per machine for 60s so
// metrics pushes every 30s don't block on it every tick.
var (
	diskCache sync.Map // map[string]diskSample
	diskTTL   = 60 * time.Second
)

// CollectMetrics gathers all metrics for a single machine.
// This is the only public entry point; callers pass in *Machine directly
// to avoid double-locking the manager.
func CollectMetrics(m *Machine) MachineMetrics {
	now := time.Now()
	uptime := int64(now.Sub(m.createdAt).Seconds())
	disk := cachedDiskUsage(m.Id, m.overlayUpperDir)
	state := m.State.String()

	var activity Activity
	if m.activity != nil {
		activity = m.activity.Snapshot()
	}

	// Frozen/stopped: no container, no stats, no ports — just size on disk.
	// Last-known activity still rides along so the UI can show how the machine
	// was last left (e.g. "exit 0" before it was frozen).
	if m.State == MachineFrozen || m.State == MachineStopped {
		return MachineMetrics{
			UptimeSeconds:  uptime,
			DiskUsageBytes: disk,
			State:          state,
			Activity:       activity,
			Timestamp:      now,
		}
	}

	mem, limit, cpu := collectPodmanStats(m.Id)
	ports := DetectPortsInContainer(m.Id)

	return MachineMetrics{
		MemUsageBytes:  mem,
		MemLimitBytes:  limit,
		CPUPercent:     cpu,
		UptimeSeconds:  uptime,
		DiskUsageBytes: disk,
		ListeningPorts: ports,
		State:          state,
		Activity:       activity,
		Timestamp:      now,
	}
}

// ForgetMetricsCache clears cached disk usage for a machine (called on delete).
func ForgetMetricsCache(machineId string) {
	diskCache.Delete(machineId)
}

// collectPodmanStats runs `podman stats --no-stream` with a tabular format and
// parses MemUsage ("12MiB / 2GiB") and CPUPerc ("0.12%").
// Returns zeroes on any error — metrics are best-effort.
func collectPodmanStats(machineId string) (memBytes, limitBytes int64, cpuPercent float64) {
	out, err := exec.Command("podman", "stats",
		"--no-stream",
		"--format", "{{.MemUsage}}|{{.CPUPerc}}",
		containerName(machineId),
	).CombinedOutput()
	if err != nil {
		return 0, 0, 0
	}
	line := strings.TrimSpace(string(out))
	parts := strings.SplitN(line, "|", 2)
	if len(parts) != 2 {
		return 0, 0, 0
	}
	memBytes, limitBytes = parseMemUsage(parts[0])
	cpuPercent = parseCPUPercent(parts[1])
	return
}

// memUsageRegex captures "12.3MiB / 2GiB" → [12.3 MiB 2 GiB].
var memUsageRegex = regexp.MustCompile(`(?i)([\d.]+)\s*([kmgt]i?b|b)?\s*/\s*([\d.]+)\s*([kmgt]i?b|b)?`)

func parseMemUsage(s string) (int64, int64) {
	m := memUsageRegex.FindStringSubmatch(s)
	if m == nil {
		return 0, 0
	}
	return parseSizeToBytes(m[1], m[2]), parseSizeToBytes(m[3], m[4])
}

func parseSizeToBytes(num, unit string) int64 {
	f, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0
	}
	switch strings.ToLower(unit) {
	case "", "b":
		return int64(f)
	case "kb":
		return int64(f * 1e3)
	case "kib":
		return int64(f * 1024)
	case "mb":
		return int64(f * 1e6)
	case "mib":
		return int64(f * 1024 * 1024)
	case "gb":
		return int64(f * 1e9)
	case "gib":
		return int64(f * 1024 * 1024 * 1024)
	case "tb":
		return int64(f * 1e12)
	case "tib":
		return int64(f * 1024 * 1024 * 1024 * 1024)
	}
	return 0
}

func parseCPUPercent(s string) float64 {
	s = strings.TrimSuffix(strings.TrimSpace(s), "%")
	f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return f
}

func cachedDiskUsage(machineId, upperDir string) int64 {
	if upperDir == "" {
		return 0
	}
	if v, ok := diskCache.Load(machineId); ok {
		s := v.(diskSample)
		if time.Since(s.taken) < diskTTL {
			return s.bytes
		}
	}
	b := measureDiskUsage(upperDir)
	diskCache.Store(machineId, diskSample{bytes: b, taken: time.Now()})
	return b
}

func measureDiskUsage(path string) int64 {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "du", "-sb", path).Output()
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return 0
	}
	n, _ := strconv.ParseInt(fields[0], 10, 64)
	return n
}
