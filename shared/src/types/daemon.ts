import { z } from 'zod'

// A user-paired daemon process. The bearer token is only ever returned ONCE
// (during pair) — afterwards it's stored as a sha256 hash and the user has to
// re-pair to get a new one. `status` is a runtime view: ONLINE means the
// backend currently holds an open WS for this daemon, OFFLINE means it
// doesn't.

export namespace Daemon {
  export type Status = 'online' | 'offline'

  export type Model = {
    id: string
    name: string
    status: Status
    isPaused: boolean
    // Backend-allocated reverse-SSH tunnel port on the shared sish VPS.
    // Null until pairing completes. The matching host is a global env var
    // on the backend (PIANO_SISH_HOST) and surfaces via /api/machines/:id/ssh-info.
    sshPort: number | null
    // Daemon-reported workdir inside its machines (typically the daemon
    // host's $HOME). Used by the "Open in IDE" URL so Cursor/VSCode opens
    // a directory the in-container user can actually read.
    defaultWorkdir: string | null
    lastSeenAt: Date | null
    userId: string
    createdAt: Date
    updatedAt: Date
  }

  export namespace DTO {
    // POST /api/daemons/pair-codes — start pairing. UI proposes a name.
    export const CreatePairingCodeSchema = z.object({
      name: z.string().min(1).max(64).trim(),
    })
    export type CreatePairingCode = z.infer<typeof CreatePairingCodeSchema>

    // POST /api/daemons/pair — claimed by the daemon CLI, no session auth.
    // `defaultWorkdir` is the daemon host's $HOME (or root for sandboxed
    // daemons) — it's the dir the in-container user can read, surfaced as
    // the IDE's open-folder path. Strict regex: must be absolute, no
    // control chars / CR / LF (those would inject into the IDE URL).
    export const PairSchema = z.object({
      code: z.string().min(4).max(64),
      defaultWorkdir: z.string().min(1).max(512).regex(/^\/[^\x00-\x1f\r\n]*$/, 'must be an absolute POSIX path with no control characters').optional(),
    })
    export type Pair = z.infer<typeof PairSchema>

    // PATCH /api/daemons/:id — rename only for now.
    export const UpdateSchema = z.object({
      name: z.string().min(1).max(64).trim(),
    })
    export type Update = z.infer<typeof UpdateSchema>
  }

  export const validate = {
    createPairingCode: (data: unknown) => DTO.CreatePairingCodeSchema.parse(data),
    pair:              (data: unknown) => DTO.PairSchema.parse(data),
    update:            (data: unknown) => DTO.UpdateSchema.parse(data),
  }

  // The pairing code surface returned to the UI. The code itself is the secret
  // the user pastes into the daemon CLI.
  export type PairingCodeModel = {
    code: string
    name: string
    expiresAt: Date
  }

  // What the daemon CLI receives after a successful pair. The token is shown
  // exactly once and saved to the daemon's config file. sshHost+sshPort are
  // included so the daemon process can immediately bring up its reverse SSH
  // tunnel without an extra round-trip.
  export type PairResult = {
    daemonId: string
    name: string
    token: string
    sshHost: string | null   // global PIANO_SISH_HOST; null in installations w/o IDE access configured
    sshPort: number | null   // backend-allocated, unique per daemon; null when sshHost is null
  }

  // Pure DB-row → Model transformation. The status enum on disk is uppercase
  // (Postgres enum); we lowercase it here so the public API is consistent
  // with the rest of our types.
  export type DbRow = {
    id: string
    name: string
    status: 'ONLINE' | 'OFFLINE'
    isPaused: boolean
    sshPort: number | null
    defaultWorkdir: string | null
    lastSeenAt: Date | null
    userId: string
    createdAt: Date
    updatedAt: Date
  }

  export const toModel = (row: DbRow): Model => ({
    id:             row.id,
    name:           row.name,
    status:         row.status === 'ONLINE' ? 'online' : 'offline',
    isPaused:       row.isPaused,
    sshPort:        row.sshPort,
    defaultWorkdir: row.defaultWorkdir,
    lastSeenAt:     row.lastSeenAt,
    userId:         row.userId,
    createdAt:      row.createdAt,
    updatedAt:      row.updatedAt,
  })

  // Human-friendly pairing code: PIANO-XXXX-XXXX where X is uppercase
  // alphanumeric (excluding ambiguous 0/O, 1/I).
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  export const generatePairingCode = (): string => {
    const seg = (n: number) => Array.from(
      { length: n },
      () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
    ).join('')
    return `PIANO-${seg(4)}-${seg(4)}`
  }

  // 32-byte (256-bit) random token, hex-encoded. Same shape as a Better-auth
  // session token so we can reuse the same handling primitives if needed.
  export const generateToken = (): string => {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  }

  // Pairing codes live for 10 minutes — long enough to copy/paste into a
  // terminal, short enough that a leaked code is uninteresting by morning.
  export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000

  // SSH info returned by GET /api/machines/:id/ssh-info. Username = machineId
  // because the daemon-side SSH gateway routes by username.
  export type SshInfo = {
    host: string
    port: number
    username: string
    command: string
    sshConfig: string
    cursorUrl: string
    vscodeUrl: string
  }

  // Build the wire-shape SshInfo. Pure morphism — colocated with the type
  // per the "type and its morphisms travel together" principle. Only one
  // caller today (backend's sshInfoForMachine) but moving here means tests
  // need no backend harness, and the URL-encoding rules live next to the
  // contract they protect.
  //
  // Path segments are URI-component-encoded so any characters the
  // PairSchema regex still permits (non-ASCII / spaces) produce a
  // well-formed RFC 3986 URL. For typical Linux $HOME paths this is a
  // no-op (only encodes if there's something to encode).
  export const toSshInfo = (input: {
    host: string
    port: number
    machineId: string
    daemonName: string
    workdir: string | null
  }): SshInfo => {
    const alias = `piano-${input.daemonName.replace(/[^a-zA-Z0-9_-]/g, '-')}-${input.machineId.slice(0, 8)}`
    const command = `ssh -p ${input.port} ${input.machineId}@${input.host}`
    const sshConfig = [
      `Host ${alias}`,
      `  HostName ${input.host}`,
      `  Port ${input.port}`,
      `  User ${input.machineId}`,
      `  StrictHostKeyChecking no`,
      `  UserKnownHostsFile /dev/null`,
    ].join('\n')
    const remoteAuthority = `ssh-remote+${input.machineId}@${input.host}:${input.port}`
    const rawPath = input.workdir && input.workdir.startsWith('/') ? input.workdir : '/'
    const path = rawPath.split('/').map(encodeURIComponent).join('/')
    const cursorUrl = `cursor://vscode-remote/${remoteAuthority}${path}`
    const vscodeUrl = `vscode://vscode-remote/${remoteAuthority}${path}`
    return { host: input.host, port: input.port, username: input.machineId, command, sshConfig, cursorUrl, vscodeUrl }
  }

  // Pair-time response shape — token shown once, plus the tunnel coords
  // the daemon needs to immediately bring up its reverse SSH connection.
  export const toPairResult = (input: {
    daemon: Pick<DbRow, 'id' | 'name' | 'sshPort'>
    token: string
    sishHost: string | null
  }): PairResult => ({
    daemonId: input.daemon.id,
    name:     input.daemon.name,
    token:    input.token,
    sshHost:  input.sishHost,
    sshPort:  input.daemon.sshPort,
  })
}
