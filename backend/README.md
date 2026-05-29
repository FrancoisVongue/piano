# `@piano/backend`

The Piano control plane: Express + Prisma (Postgres) + Temporal + NATS.
Hosts the REST/SSE API, the auth layer, the AI orchestration, and the
control-plane WebSocket the daemon dials into.

See [`MAP.md`](./MAP.md) for the architectural overview (system context,
domain language, request pipelines, hotspots, trade-offs).

For local setup, the dev workflow, and how this package fits into the
full stack, start at the [root README](../README.md) and
[CONTRIBUTING.md](../CONTRIBUTING.md).
