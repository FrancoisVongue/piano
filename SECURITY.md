# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report privately via [GitHub Security Advisories](https://github.com/FrancoisVongue/piano/security/advisories/new)
(the "Report a vulnerability" button on the Security tab).

We aim to acknowledge reports within a few business days and will keep you
updated on remediation progress. Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept if possible).
- Affected component(s): `frontend`, `backend`, `daemon`, `shared`, or `piano-cli`.

## Scope notes

Piano runs untrusted code inside **isolated, `--privileged` Podman containers**
on a user-owned host (the daemon). This is intentional for the agent-sandbox use
case but has real implications you should understand before deploying:

- **The daemon binds its HTTP API, SSH gateway, and port-forward listeners to
  `127.0.0.1` only.** It is *not* designed to be reachable from the network —
  only the backend's bearer-authenticated outgoing WebSocket is the supported
  ingress. Exposing the daemon to a LAN or the public internet is out of scope.
- **Machines see your host `$HOME` via a copy-on-write overlay** (changes stay
  in the sandbox, the host stays untouched). That means an agent running in a
  machine *can read your SSH keys, cloud credentials, shell history, and
  dotfiles*. This is the point — agents inherit your dev environment — but it
  also means **you should not run untrusted models or prompts on a host whose
  `$HOME` you would not hand to a coworker**. Run Piano on a dev host, not on
  a host that holds production secrets.
- **Containers are `--privileged` and use passwordless sudo internally.** The
  isolation boundary is the Podman container + kernel-overlayfs upper dir —
  not a hardened sandbox. Treat it as a fast-resettable environment, not as
  an adversarial-input firewall.

See `daemon/MAP.md` §5 ("Trade-offs & Known Issues") for the full trust-model
discussion.

## Supported versions

Piano is pre-1.0; security fixes land on `main`. Pin a commit and update
regularly.
