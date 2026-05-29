# Piano Daemon — Architecture Map

> Scope: `daemon/` only. This is the **machine runtime** of Piano — the layer
> that turns a single host into a fleet of isolated, persistent, fork-able
> Linux environments for AI coding agents. Written in **Go** (not Node — the
> rest of Piano is TS, this is the systems floor). One flat `package main`,
> ~30 files, no internal package tree. Talks to the world almost entirely by
> shelling out to `podman`, `btrfs`, `mount`, and `socat`.

---

## 1. System Context

The daemon is a long-lived **root process** (`sudo`) that owns one host's
container fleet. It is driven by the Piano backend over a persistent WebSocket
and exposes machines to humans/editors via an SSH gateway + reverse tunnel.

```
                          ┌──────────────────────────────────────────────┐
   [Piano Backend (TS)]   │                PIANO DAEMON (Go, root)         │
   control plane          │                                                │
        │                 │  ┌────────────┐   commands   ┌──────────────┐ │
        │  WS  /api/daemon │  │ControlClient│ ───────────▶│MachineManager│ │
        ├─────────────────┼─▶│ (control.go)│◀─ pushes ────│(machine_mgr) │ │
        │  Bearer token    │  └────────────┘  output/      └──────┬───────┘ │
        │                 │       ▲ metrics/activity              │ shells out
        │                 │       │                                ▼         │
   [Browser / xterm.js]   │  ┌────────────┐                 ┌───────────┐   │
        │  WS /ws ────────┼─▶│ HandleWS    │── PTY viewer ──│  podman   │──▶ [containers]
        │                 │  │ (handler.go)│                │  btrfs    │   (one per machine,
        │                 │  └────────────┘                 │  mount    │    --rootfs overlay)
        │                 │                                  │  socat    │   │
   [Editor: VSCode/Cursor]│  ┌────────────┐  splice         └───────────┘   │
        │  SSH ───────────┼─▶│ Tunnel ─────┼─▶ SSHGateway :2200 ─▶ podman exec │
        └── via [sish VPS]│  │ (tunnel.go) │   (ssh_gateway.go)              │
                          │  └────────────┘                                 │
                          └──────────────────────────────────────────────┘
```

**Who calls it:** the backend (commands + terminal multiplexing over one WS),
browsers (raw `/ws` PTY attach), and editors (SSH, tunneled through a `sish`
VPS so a daemon behind NAT is still reachable on a public port).

**What it calls:** `podman` (container lifecycle, exec, inspect), `btrfs`
(O(1) snapshots), `mount`/`umount` (kernel overlayfs), `socat` (loopback port
bridging), the kernel `cgroup` freezer (fast pause), and the backend's HTTP
`/api/daemons/pair` once at provisioning time.

---

## 2. Domain Language

Seven nouns carry the whole system:

- **Machine** — the central object. An isolated Linux environment = one Podman
  container over a private rootfs overlay + a private `$HOME` overlay, plus a
  PTY (a `zsh` running via `podman exec`), an output log, and an activity
  tracker. Has a 4-state lifecycle (below). `machine.go`.
- **Overlay** — two stacked kernel-overlayfs mounts per machine: the **rootfs
  overlay** (lower = shared base rootfs, upper = the machine's writable layer)
  and the **`$HOME` overlay** (lower = host `$HOME`, upper = `home-upper`). The
  upper dir *is* the machine's identity; everything else is shared/derived.
- **Base Layer** — a single read-only Ubuntu rootfs (`piano-base`) extracted
  once to BTRFS, used as the lowerdir for **every** machine's rootfs overlay.
- **Template** — a frozen machine's upper dir, saved as a reusable seed. New
  machines BTRFS-snapshot the template to inherit its installed state.
- **Branch** — a fork: BTRFS-snapshot a (paused) parent's machine dir into a
  child. O(1), copy-on-write. The parent never notices (paused for ms).
- **Shared terminal** — a *second PTY into an existing container* (a pane, not
  a machine). `sharedWith` points at the parent; it owns no overlay/container.
- **ControlClient / Tunnel / SSHGateway** — the three external edges:
  command/telemetry plane, NAT-traversal reverse tunnel, and editor SSH entry.

Machine states (`MachineState`, `machine.go`):
`running` (PTY + viewer) → `detached` (PTY, no viewer) → `frozen` (overlay
unmounted, upper dir = the saved snapshot) → `stopped` (container gone).

---

## 3. The Pipeline

### Boot & provisioning
`main.go` insists on **root** (it manages mounts, device nodes, cgroups — no
userns games). Two subcommands short-circuit before the server: `pair <code>`
(exchanges a one-time code at the backend for a long-lived bearer token) and
`set-token` (token-rotation, no roundtrip). Both write `/etc/piano/daemon.json`
**atomically** (tmp + rename — a truncated config file bricks startup) and exit.
`pair.go`.

Normal start resolves credentials in priority order (`--token` flag → paired
`daemon.json` → standalone dev), then runs `Preflight()` (Linux? root? podman,
crun, mkfs.btrfs present? inotify limits sane for webpack?). Then the storage
floor is laid down:

1. `EnsureBtrfsStorage` (`storage.go`) — creates a **50G sparse BTRFS image**
   at `/var/tmp/piano_<uid>.btrfs.img`, `mkfs.btrfs`, manually `mknod`s 64 loop
   devices (containers may not have them), and loop-mounts it at `layersDir`
   (`/var/tmp/piano/<uid>`) with `compress=zstd`. BTRFS is the whole reason
   branching is instant.
2. `PrepareBaseLayer` (`overlay.go`) — builds the `piano-base` image from
   `Containerfile.machine`, creates a throwaway container, and **`podman export
   | tar -x`** its rootfs into a flat dir on the SAME BTRFS volume. (Why export
   instead of `podman mount`? A mounted image is itself an overlayfs path;
   stacking machine overlays on top yields cross-device `EXDEV` errors. A flat
   same-fs dir avoids that.) Extraction is **atomic**: extract into `.incoming`,
   then `rename` — so a SIGKILL mid-export can't leave a half-tree that poisons
   every future machine overlay.

Then `MachineManager.RecoverFromDisk()` walks `layersDir/*/meta.json` and
rebuilds in-memory state: frozen machines come back as metadata-only, shared
terminals re-exec into their (still-running) parent, running machines get their
overlays re-mounted and a **fresh container** created (the old one is killed —
containers are disposable, the upper dir is the truth).

### Creating a machine (the hot path — `createMachine`, `machine_mgr.go`)
A backend `command:create-from-template` (or a raw `/ws?machineId=` attach for a
blank one) lands in `MachineManager`. The sequence, instrumented to the ms:

1. `PrepareMachineDirs` — make a **BTRFS subvolume** at `layersDir/<id>` (so it
   can be snapshotted later) with `upper/`, `work/`, `merged/` inside it.
2. `MountOverlay(flatLowerDirs(), …)` — kernel overlay: `lowerdir=base-rootfs`,
   upper/work = the machine's. "Flat" = exactly one lowerdir, always the base.
   All inherited state lives in upper, never in a lower stack.
3. `mountHomeOverlay` — a *second* kernel overlay for `$HOME`: lower = the host
   user's real `$HOME`, upper = `home-upper` (chowned to the host user so exec
   writes like `.zsh_history` land). Also shadows host `docker`/`docker-compose`
   in `$HOME/bin` with symlinks to the in-container podman wrapper.
4. `addUserToRootfs` — appends the host user to the upper's
   `/etc/passwd|shadow|group` (copy-base-then-append, or overlay hides the base
   file). Skipped for prepopulated (branch/template) machines.
5. `CreateContainer` (`podman.go`) — `podman run -d --init --privileged
   --rootfs <merged> …` with the merged `$HOME` bind-mounted in. Entrypoint
   starts a nested podman API socket (so docker-compose/Tilt work *inside* the
   machine) then `sleep infinity`. The container runs as **root**; exec sessions
   downgrade to the host user via `--user uid:gid`.
6. `StartPTY` (`pty.go`) — `podman exec -it --user … zsh` wrapped in a PTY at
   200x50. The returned master fd is the machine's terminal.
7. `SaveMetadata`, async IP resolution. Container IP is resolved lazily off the
   hot path (a `podman inspect` fork costs ~30ms).

### Living: the terminal stream (`machine.go`)
`readPTY` is the heartbeat: it reads the PTY master forever and fans each chunk
to four sinks — (a) **answers terminal capability queries locally**
(`terminal_queries.go`) so short-lived TUIs don't leave stray replies mangling
the next shell prompt; (b) the **output log** (ring buffer for replay-on-
reconnect); (c) the **activity tracker** (`activity.go`); (d) the live WS viewer
if attached. The PTY *outlives the WebSocket* — a browser can detach and
reattach (replaying buffered output) without disturbing the running shell. Input
flows the other way: `HandleInput` decodes JSON frames (`input`/`resize`/`file`)
and writes to the PTY master.

**Activity** is derived passively from the stream via OSC 133 shell-integration
escapes injected into `/etc/zsh/zshrc` in the base image: `preexec`→running,
`precmd`→exit code + idle. Caveat baked into the code: this only works for PTYs
that flow through `readPTY` (Piano panes) — **SSH/editor sessions bypass it**
(`ssh_gateway.go` execs podman directly), so editor activity is invisible.

### Forking: branch & freeze (the headline feature — `machine_mgr.go`)
`Branch`: if the parent is running, **pause** it (preferentially via the raw
cgroup-freezer file, `cgroup_freezer.go`, ~µs; falls back to `podman pause`
CLI, ~30-50ms), `btrfs subvolume snapshot` the entire machine dir (O(1) — one
metadata op regardless of file count), **unpause** — parent was frozen for
milliseconds and is oblivious. Then `createMachine(child, prepopulated=true)`
mounts a fresh overlay over the snapshotted upper. If the runtime has no cgroup
(`cgroups=disabled`), it degrades to snapshot-without-pause (torn writes
acceptable for terminal workloads).

`Freeze`: kill the PTY, remove the container, unmount both overlays. The upper
dir survives untouched — *that's* the frozen state. Cheap to resume (re-mount +
new container). `CreateTemplate` is freeze-then-copy-upper-into-`templates/`.

### Telemetry (`control.go` push loops)
ControlClient runs four goroutines: a reconnecting command read-loop, plus
output-sync (5s), metrics (30s — cpu/mem/disk/ports, frozen machines included),
and activity (750ms fingerprint-diff for snappy UI). All outbound messages
carry a W3C **traceparent** so daemon log lines stitch onto the backend's trace.
A `recover()` wraps every command so one bad message can't kill the daemon.

### Reaching a machine from an editor (`tunnel.go` + `ssh_gateway.go`)
The **SSHGateway** is a single-port SSH server where **the SSH username *is* the
machineId**, authenticated against the host user's `~/.ssh/authorized_keys`.
`session` channels exec/shell/sftp into the container; `direct-tcpip` channels
proxy TCP via in-container `socat` to `127.0.0.1:port` (services bound to
loopback are unreachable by container IP). The **Tunnel** keeps a reverse-SSH
connection to a `sish` VPS, requesting a public TCP forward; inbound connections
are spliced (half-close-aware) to the local gateway — so a NAT'd daemon is
reachable, and sish only ever sees encrypted bytes (auth is end-to-end at the
gateway). Port forwarding for the *browser preview* is separate
(`portforward.go`): a host listener bridges each connection through
`podman exec … socat` into the container loopback.

---

## 4. Architecture Hotspots

| Concern | Where |
|---|---|
| Entry point, flag/credential resolution, signal shutdown | `main.go` |
| Machine lifecycle orchestration (create/branch/freeze/share/recover) | `machine_mgr.go` |
| Per-machine state, PTY pump, attach/detach, destroy | `machine.go` |
| Overlay mounts, base-layer build/extract, BTRFS helpers | `overlay.go` |
| All `podman` CLI shellouts (run/exec/pause/inspect/ports) | `podman.go` |
| Backend command dispatch + telemetry push loops | `control.go` |
| BTRFS sparse-image storage floor + loop devices | `storage.go` |
| Fast cgroup-freezer pause (bypasses podman CLI) | `cgroup_freezer.go` |
| Single-port SSH multiplexer (username = machineId) | `ssh_gateway.go` |
| Reverse-SSH NAT traversal via sish | `tunnel.go` |
| Browser preview port bridging via socat | `portforward.go` |
| Provisioning / token rotation, `daemon.json` | `pair.go` |
| Disk metadata + recovery format | `persist.go` |
| Base image definition (the substrate every machine inherits) | `Containerfile.machine` |
| Activity derivation from OSC 133 | `activity.go`, base image zshrc |

The control flow center of gravity is **`machine_mgr.go`**; the systems-risk
center of gravity is **`overlay.go` + `storage.go` + the Containerfile**.

---

## 5. Trade-offs & Known Issues

This is the dirty floor. Read this section twice.

**The architecture has migrated and the old mental model is stale.** Prior
design notes describe *rootless* Podman with `--userns=keep-id`, **fuse-
overlayfs**, and two fuse stacks composed via Podman bind mount. The code in
front of us has **abandoned all of that**:
- The daemon runs **as root via sudo**, containers are **`--privileged` and
  rootful**, **no user namespace at all** (`podman.go` comment: "No user
  namespace — daemon runs as root"). The host user is reconstructed *inside* the
  container by appending to `/etc/passwd` and `--user uid:gid` on exec.
  This sidesteps the historical `keep-id`-incompatible-with-`--rootfs` crun
  crash by removing the userns entirely rather than working around it.
- Overlays are **kernel overlayfs**, not fuse (`MountOverlay` shells `mount -t
  overlay`; base image sets `storage.driver = "overlay"`). The "`:O` rejects
  `$HOME` as lowerdir" workaround is moot — the daemon mounts both overlays
  itself and hands Podman a plain bind mount of the merged `$HOME`.
- Branching is now **BTRFS subvolume snapshots**, not overlay layering. This
  is why `storage.go` exists at all.
  → **Risk:** anyone porting this against the old notes will fight a system that
  no longer exists. The notes are wrong; the code is right.

**`layersDir` must live outside `$HOME`** — kept as `/var/tmp/piano/<uid>`. An
in-`$HOME` layersDir creates sub-mounts that break the `$HOME` overlay. This
constraint *is* respected (the default is hardcoded in `main.go`).

**EXDEV avoidance is load-bearing and fragile.** The base rootfs is `podman
export`ed to a flat dir on the *same* BTRFS volume specifically so machine
overlays don't stack overlayfs-on-overlayfs. If the base ever lands on a
different filesystem, every machine mount silently breaks with cross-device
errors. The atomic `.incoming`→rename publish guards against a poisoned base.

**`cgroups = "disabled"` in the base image undermines pause.** The nested
podman config disables cgroups, and the host may too — in which case `Branch`
**cannot pause** and snapshots a live container (degraded path, logged as a
WARNING). Acceptable for terminal/editor work, *not* safe for a database mid-
write inside the machine. The fast-path freezer (`cgroup_freezer.go`) walks
`/sys/fs/cgroup` by string-matching `libpod-<id>.scope` — brittle to libpod
naming changes across podman versions.

**Containers are disposable; the upper dir is the only truth.** Recovery always
kills and recreates the container. Any in-container state NOT under the overlay
upper or `$HOME` (e.g. a process's in-memory state, the nested podman socket)
is lost on daemon restart. This is intentional (freeze/resume relies on it) but
means "resume" is really "re-create with the same disk".

**Activity tracking has a coverage hole.** OSC 133 signalling only reaches
PTYs that flow through `Machine.readPTY` (Piano panes). SSH/editor sessions
(`ssh_gateway.go`) `podman exec` directly and are invisible to activity/idle
detection — a machine busy under an editor can read as idle. Documented in code,
not yet fixed.

**`--privileged` everywhere is a big hammer.** Combined with passwordless sudo
in the base image and a `CheckOrigin: return true` WebSocket upgrader
(`handler.go`), the daemon trusts its network position heavily. The `/ws` and
`/machines` HTTP surface has **no auth** — it relies entirely on not being
exposed publicly (only the backend WS is token-authenticated). The SSH tunnel
to sish uses `InsecureIgnoreHostKey` (TODO acknowledged in `tunnel.go`).

**Single-active-port-forward.** `PortForwarder` forwards exactly one machine's
ports at a time (`Activate` stops the previous). Fine for "preview the focused
machine", a real limit for true parallel multi-machine previews — which is
notable given Piano's "12 agents in parallel" thesis.

**Per-connection fork cost.** Both the browser port-forward and the SSH
direct-tcpip path spawn a `podman exec … socat` *per TCP connection*. Cheap
per-fork, but a chatty service (HMR websockets, many short requests) multiplies
podman forks.
