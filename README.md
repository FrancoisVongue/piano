# Piano

**Infrastructure for AI coding agents.** Run a fleet of AI coding agents,
each in its own isolated Linux machine, wired together on a canvas, with
one supervisor view over all of them.

Three primitives:

1. **Machines** — isolated, persistent Linux environments (Podman + overlayfs).
   One per agent. Fork, freeze, resume. Full SSH and editor access.
2. **Graph** — a canvas of nodes (agents-in-machines) and edges (dependencies).
   Parents feed context to children; siblings run in parallel.
3. **Supervisor** — one view of every agent: streaming output, attachable
   terminals, approve/reject.

Licensed under the [Apache License 2.0](./LICENSE).

---

## How it fits together

```
                Your host  (Mac via OrbStack VM, or native Linux)

  ┌──────────────────────────────────────────────────────────────────┐
  │                                                                  │
  │   Docker Compose stack — orchestrated by Tilt                    │
  │   ┌────────────────────────────────────────────────────────┐    │
  │   │  caddy   frontend   backend   worker                   │    │
  │   │  postgres   nats   temporal   sish                     │    │
  │   └─────────────────────┬──────────────────────────────────┘    │
  │                         │ control-plane WebSocket               │
  │   ┌─────────────────────▼──────────────────────────────────┐    │
  │   │  piano-daemon  (native process, root, drives Podman)   │    │
  │   │                                                        │    │
  │   │      ╔══════╗  ╔══════╗  ╔══════╗   ← agent machines  │    │
  │   │      ║  M1  ║  ║  M2  ║  ║  M3  ║     (containers,    │    │
  │   │      ╚══════╝  ╚══════╝  ╚══════╝      fork / freeze) │    │
  │   └────────────────────────────────────────────────────────┘    │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
                                 ▲
                        http://localhost:3009
                          (your browser)
```

The daemon lives on the host (not in Docker) because it spawns other
containers and needs the Linux kernel directly — overlayfs, BTRFS, cgroup
freezer. Docker-in-Docker for that role is a footgun.

---

## Setup

Pick the column for your OS. Read top-to-bottom. The steps are numbered the
same on both sides so you can follow without scrolling back.

| **macOS** | **Linux (Debian / Ubuntu)** |
| --- | --- |
| **1.** Install OrbStack. It runs a real Ubuntu VM for you. <br><br> `brew install orbstack` | *You're already on Linux — start at step 4.* |
| **2.** Create a Linux VM called `piano`. <br><br> `orb create ubuntu piano` | |
| **3.** Open a shell into the VM. **Stay in this shell for every step below.** <br><br> `orb shell piano` | |
| **4.** Clone the repo. <br><br> `git clone https://github.com/FrancoisVongue/piano.git` <br> `cd piano` | **4.** Clone the repo. <br><br> `git clone https://github.com/FrancoisVongue/piano.git` <br> `cd piano` |
| **5.** Run the installer. It installs Docker, Tilt, Go, Podman and friends, then generates a `.env` with random secrets. <br><br> `./scripts/install.sh` | **5.** Run the installer. It installs Docker, Tilt, Go, Podman and friends, then generates a `.env` with random secrets. <br><br> `./scripts/install.sh` |
| **6.** Refresh your shell so the new `docker` group membership takes effect. <br><br> `sudo su - $USER` <br> `cd piano` | **6.** Refresh your shell so the new `docker` group membership takes effect. <br><br> `sudo su - $USER` <br> `cd piano` |
| **7.** Start everything. <br><br> `tilt up` | **7.** Start everything. <br><br> `tilt up` |
| **8.** Open in your browser: <br><br> **<http://localhost:3009>** — Piano <br> **<http://localhost:10350>** — Tilt UI (live logs per service) | **8.** Open in your browser: <br><br> **<http://localhost:3009>** — Piano <br> **<http://localhost:10350>** — Tilt UI (live logs per service) |

Stop everything with `tilt down`.

When a service goes red in the Tilt UI, click it — its log opens and the
real explanation is in there.

---

## Open in Cursor / VSCode (optional)

To make the editor's "Open in Cursor" / "Open in VSCode" SSH button work,
the daemon's SSH gateway needs to authorise an SSH public key. The key
must come from the **machine you'll be clicking "Open in..." from** — the
one where Cursor / VSCode is actually running, because that's where its
matching private key lives.

| **macOS** (inside the OrbStack VM shell) | **Linux** |
| --- | --- |
| **1.** Create the SSH directory. <br><br> `mkdir -p ~/.ssh && chmod 700 ~/.ssh` | **1.** Create the SSH directory. <br><br> `mkdir -p ~/.ssh && chmod 700 ~/.ssh` |
| **2.** You'll connect from your Mac (where Cursor runs), so you need your **Mac's** public key. OrbStack mounts your Mac home at `/mac` inside the VM, so just read it from there. <br><br> `cat /mac/$USER/.ssh/id_*.pub >> ~/.ssh/authorized_keys` | **2.** You'll connect from wherever you run Cursor / VSCode. **Copy that machine's public key in.** If Piano and your editor are on the same machine, that's just your own `~/.ssh/id_*.pub`; if they're on different machines, `scp` the editor machine's `.pub` over and `cat` it in. (No SSH key on the editor side? Run `ssh-keygen` there first.) <br><br> `cat ~/.ssh/id_*.pub >> ~/.ssh/authorized_keys   # same machine` |
| **3.** Lock down the file's permissions. <br><br> `chmod 600 ~/.ssh/authorized_keys` | **3.** Lock down the file's permissions. <br><br> `chmod 600 ~/.ssh/authorized_keys` |
| **4.** Restart the daemon. <br><br> `tilt down && tilt up` | **4.** Restart the daemon. <br><br> `tilt down && tilt up` |

---

## What's running

| Service           | Where     | Purpose                                    |
| ----------------- | --------- | ------------------------------------------ |
| `caddy`           | container | Edge proxy — single origin for app + API   |
| `frontend`        | container | Next.js app                                |
| `backend`         | container | Express API + auth + AI orchestration      |
| `temporal-worker` | container | Temporal workflow worker                   |
| `postgres`        | container | Primary database                           |
| `nats`            | container | Message queue (JetStream)                  |
| `temporal`        | container | Workflow engine                            |
| `sish`            | container | SSH reverse-tunnel for IDE access          |
| `daemon`          | **host**  | Machine runtime (Podman + overlayfs, root) |

---

## The stack

| Layer    | Tech                                                                     |
| -------- | ------------------------------------------------------------------------ |
| Frontend | Next.js (App Router), React, Zustand, React Flow, TanStack Query         |
| Backend  | Express, Prisma, NATS, Temporal                                          |
| Daemon   | Go, Podman (machine runtime)                                             |
| Shared   | TypeScript types + pure functions (`@piano/shared`)                      |
| Infra    | Tilt, Docker Compose, Caddy                                              |

---

## Configuration

The installer generated a `.env` at the repo root with random secrets. Delete
it and re-run the installer to regenerate. Optional values to fill in:

```bash
# Sign in with Google (otherwise email + password only).
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# The public URL when deploying somewhere real (default: http://localhost:3009).
PIANO_URL=https://your-piano.example.com
```

For Google OAuth, authorise this redirect URI in your Google Cloud OAuth
client: `${PIANO_URL}/api/auth/callback/google`.

---

## Want more

- [VISION.md](./VISION.md) — what Piano is and why
- [CONTRIBUTING.md](./CONTRIBUTING.md) — coding conventions and PR flow
- [SECURITY.md](./SECURITY.md) — vulnerability reporting and threat model
- Per-package architecture maps:
  [`backend/MAP.md`](./backend/MAP.md),
  [`frontend/MAP.md`](./frontend/MAP.md),
  [`daemon/MAP.md`](./daemon/MAP.md),
  [`shared/MAP.md`](./shared/MAP.md)
