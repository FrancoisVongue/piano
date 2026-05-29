# Backend — Architecture Map

> Express 5 + TypeScript + Prisma(Postgres) + Temporal + NATS. Functional, domain-centric,
> typed end-to-end via `@piano/shared`. Two processes share one `services` object: the **API**
> (`index.ts`) and the **Temporal worker** (`temporal-worker.ts`).

---

## 1. System Context

The backend is the **control plane** of Piano. It owns the canvas (a graph of "notes"),
authorizes everyone, queues AI work, and brokers every conversation with user-owned **daemons**
(which actually run Podman machines). It never runs models itself and never runs containers
itself — it orchestrates both.

```
                          ┌──────────────────────── BACKEND (this) ─────────────────────────┐
  Browser (frontend) ───► │  API process [Express]   ──pub──►  NATS JetStream  ──consume──►  │
   - HTTPS REST           │   - REST routers                       │              Temporal     │
   - SSE  (GET /events) ◄─┤   - SSE fan-out  ◄──sub── NATS ◄──pub──┘              worker proc  │
   - WS /api/terminal/:id │   - WS terminal proxy                  │             [Temporal SDK]│
        │                 │   - WS daemon control plane            ▼                  │        │
        │                 │            │                    Temporal Server           │        │
        │                 └────────────┼───────────────────────────────────│─────────┼────────┘
        │ (multiplexed)                │ Bearer-auth WS                     │ activities│
        ▼                              ▼ /api/daemon/ws                     ▼          ▼
   ───────────────────────────►  DAEMON (user host)              Postgres        AI providers
                                  - Podman machines             [Prisma/pg]    [Anthropic/OpenAI/
                                  - PTY sessions                                 Google]
```

- **Inbound:** browser REST + SSE + terminal WS; daemons connect *out* to the backend over a
  single Bearer-authed control-plane WS (`/api/daemon/ws`). Daemons never expose a listener.
- **Outbound:** Postgres (Prisma + pg adapter), NATS (queue + pub/sub), Temporal server, three
  LLM provider APIs. Auth via `better-auth` (sessions in Postgres). OTEL → Cloud Trace.

---

## 2. Domain Language

The whole product is "a graph of agents-in-machines you direct from one screen". The nouns:

- **Arrangement** — a canvas / workspace. Owns Notes + Edges, an optional `systemPrompt`, tags,
  and a JSONB `config` (action/model visibility & ordering). The unit of "a board".
- **Note** — a node on the canvas. Polymorphic via `NoteType`: content nodes (`USER`,
  `ASSISTANT`, `SYSTEM`), annotations (`TEXT`, `ZONE`, `DRAWING`), grouping (`GROUP`), and the
  two **daemon-backed** types `MACHINE` / `TERMINAL`. `Note.capabilities(type)` is the central
  oracle: `canRunAction`, `canBeAIContext`, `isDaemonRoutable`. This predicate gates almost
  every branch in the system.
- **Edge** — a parent→child link. Notes form a tree by default; `isMergePoint` allows multiple
  parents (DAG). Ancestry up the edges *is* the LLM conversation context.
- **Action** — a reusable prompt template (`prompt`, `useAncestors`, `outputStyle`
  SINGLE/MULTIPLE_CHILDREN). Running an action on a note spawns a child holding the AI reply.
- **Workflow** — declarative table-automation: ordered `Level[]` (each = an Action × a set of
  context strings) stored as one JSON doc. Runs the canvas level-by-level, fanning out.
- **Daemon** — a user-paired host process (auth = sha256 of a long-lived bearer token). Holds
  the actual Podman machines. Identified by `(userId, name)`; allocated a unique `sshPort` on a
  shared sish tunnel host.
- **Machine / Template** — a `MACHINE` Note is a live container; **MachineTemplate** is a frozen,
  reusable snapshot **pinned to the daemon whose disk holds its overlay files**.
- **Run** — a persisted record of one AI call's token usage, hung off the produced note.

---

## 3. The Pipeline

There are two stories worth tracing end-to-end: **running an action on a node** (the AI path)
and **a machine on the canvas** (the daemon path). They share the same skeleton — REST in,
optimistic DB write, async side-effect, SSE out — but diverge at the side-effect.

### 3a. Running an action (the AI path)

A route is thin by doctrine: `sessionAuth → validate (Zod in @piano/shared) → controller →
match(venum)`. `POST /api/actions/.../execute` lands in `action/execution.ts:executeWithOptimisticUpdate`,
which reads as six prose steps:

1. Apply any in-flight client canvas edits first (`ArrangementController.patch`) — never run
   against a stale world.
2. Re-validate the source note's `canRunAction` (the API never trusts the client).
3. Resolve the Action (ownership-scoped — `notFound` deliberately conflates "missing" and
   "not yours" to avoid an ID-probe oracle).
4. **Optimistic write:** create a `RUNNING` child Note + Edge *now* so the UI shows a spinner.
5. **Queue:** publish an `Action.Job` to NATS JetStream subject `ai.action`. Multi-parent
   ("Cartesian") nodes fan out one extra child per ancestor path here — the fan-out math lives
   inside `spawnWorkers`, keeping the outer story prose.
6. Return the canvas-facing shape (202-ish).

The job now crosses the **process boundary** into `temporal-worker.ts`. That process consumes
the JetStream durable `temporal-worker`, pulls the publisher's OTEL trace context out of the NATS
headers (so the whole thing is one distributed trace), looks the subject up in `temporal/dispatch.ts`
(a one-row-per-subject table: subject → workflow name + how to derive workflowId), and starts a
Temporal workflow. **Temporal is the durability layer** — kill the worker mid-run and the
workflow resumes.

`executeActionWorkflow` is three activities (`action/worker.ts`):
- **buildPrompt** — fetch action + arrangement + source notes + API key in parallel; resolve
  ancestry (filtered by `canBeAIContext`); split the prompt into `system / prefix / fresh` around
  a **cache anchor** (`note-cache/runtime.ts`); pre-convert Zod→JSON-Schema *here* because Zod
  closures can't survive Temporal's JSON serialization.
- **callAI** — one call through `services.ai`, a pure `model.provider → adapter` dispatcher
  (Anthropic / OpenAI / Google). Each adapter maps the `system/prefix/fresh` split onto its own
  prompt-caching mechanism and returns a `venum` (`ok | invalidApiKey | rateLimited | …`). The
  worker re-classifies those into **retryable vs non-retryable** Temporal failures.
- **processResults** — discriminate on `job.kind` (`fill` an existing optimistic node vs `create`
  a fresh Cartesian child) then on `outputStyle` (MULTIPLE_CHILDREN fans siblings). Uses
  `updateManyAndReturn` so a user deleting the target mid-flight yields `[]` (quiet drop, no
  retry) instead of a P2025 throw. Persists token usage as a `Run`.

The result reaches the browser via the **NATS→SSE bridge**: the worker `emitNodeUpdated` →
publishes `sse.node.updated`; the API process subscribes (`index.ts`) and pushes it to the owning
user's SSE stream (`GET /events`). The worker can't talk to SSE clients directly — they live in
the *other* process — so NATS is the only bridge.

**Workflows** (`execute-workflow.workflow.ts`) are this same action-run used as a sub-routine:
topo-sort the levels, keep a frontier map, and for each level plant USER notes + RUNNING
placeholders then run `executeActionWorkflow` as a *child workflow* per cell. All node/edge ids
are pre-minted with Temporal's deterministic `uuid4()` so retries are idempotent.

### 3b. A machine on the canvas (the daemon path)

When the user drops a `MACHINE`/`TERMINAL` node, the frontend doesn't call a bespoke endpoint —
it sends a **canvas patch** (`ArrangementController.patch`). Patch ordering is load-bearing
(demotions → deletions → upserts) and it is the place where DB state and daemon state are kept in
sync:
- A new node with `status='PROVISIONING'` triggers `MachineTemplateController.provisionFromPatch`
  fire-and-forget; RUNNING/FROZEN flips arrive later over SSE.
- A **deleted** daemon-backed node calls the daemon `command:delete` *first* and only commits the
  DB delete on ack — "daemon zombies are more expensive than stale DB rows".
- A **demoted** TERMINAL (canvas node → embedded window pane) is a pure DB delete with *no*
  daemon RPC, so the PTY the window is about to reuse isn't killed.

All daemon RPCs go through `services/daemon.adapter.ts:daemonCommand(target, cmd, successEvent)`,
which guards (`daemonPaused` ≠ `daemonDisconnected`), then does request/response over the
control-plane WS in `services/daemon.ts`. That WS service is the messiest, most stateful object in
the codebase (§5). Machine lifecycle verbs — `freeze` (→ template), `branch`, `share`, `activate`,
`spawnPane` — all live in `machine/controller.ts` as thin `daemonCommand` wrappers.

**Terminals** are doubly clever: the browser opens a WS to `/api/terminal/:machineId`; the API
authorizes it (`authorizeTerminal`: note-backed machine *or* registered transient pane), then the
`TerminalProxyService` multiplexes the PTY frames over the *daemon's existing control-plane WS*
(`terminal:open/in/out/close`). Daemons therefore never need a public terminal listener.

---

## 4. Architecture Hotspots

Where to go when you need to change X:

- **Add a REST domain** → `src/domains/<x>/{routes,controller}.ts`, register in
  `src/index.ts`. Keep routes thin, put orchestration in controllers, and define
  public shapes in `@piano/shared`.
- **Change the canvas / node sync logic** → `src/domains/arrangement/controller.ts` (the
  `patch` method + its `applyX` helpers) and `src/domains/arrangement/adapters/db.ts`. This is
  the #1 git hotspot (45 touches) — the real heart.
- **Change how an action runs / prompts are built** → `src/domains/action/` (`execution.ts` =
  HTTP+queue, `worker.ts` = the three Temporal activities, `ancestors.ts` = context resolution).
- **Add an AI provider** → drop an adapter in `src/services/ai/` satisfying the
  `CompletionAdapter` interface and add the `provider` string to the dispatcher map
  (`ai/index.ts`). Prompt-caching contract is the `system/prefix/fresh` split (`ai/types.ts`).
- **Touch the AI queue / dispatch** → `src/services/nats.ts` (Subjects enum, JetStream stream
  `AI_REQUESTS`), `src/temporal/dispatch.ts` (subject→workflow table), `src/temporal-worker.ts`.
- **Daemon protocol / connection state** → `src/services/daemon.ts` (control-plane WS, terminal
  multiplexing, metrics/activity push) and `src/services/daemon.adapter.ts` (routing +
  `venum` wrapping). Daemon pairing/auth → `src/domains/daemon/controller.ts`.
- **Machine lifecycle (freeze/branch/share/provision)** → `src/domains/machine/controller.ts`
  and `src/domains/machine-template/controller.ts`.
- **Realtime push to browser** → `src/services/sse.ts` + the NATS→SSE bridge at the top of
  `src/index.ts` (subjects `sse.node.*`, `sse.machine.activity`).
- **Auth** → `src/services/auth.ts` (better-auth) + `src/shared/lib/sessionAuth.ts`. Note the
  ordering quirk in `index.ts`: better-auth handler is mounted **before** `express.json()`.
- **Prompt caching** → `src/domains/note-cache/` (`runtime.ts` = anchor split + handle persist).
- **Schema / domain shapes** → `prisma/schema.prisma` (#2 hotspot) + the namespaces in
  `@piano/shared`.

---

## 5. Trade-offs & Known Issues

- **Two processes, one `services` object, NATS as the only bridge.** The API and Temporal worker
  both `ServicesFactory.init()` independently. The worker can't reach SSE clients (they're sockets
  on the *other* process), so *every* realtime update round-trips through NATS pub/sub. Simple and
  uniform, but it means a NATS outage silently kills realtime UX even while REST works.

- **`DaemonService` is a big stateful island** (`daemon.ts`, ~430 lines, 6 in-memory Maps:
  connections, owner map, paused set, terminal sessions, pending requests, metrics cache).
  This is the deliberate anomaly — it encapsulates all the WS/PTY volatility so controllers stay
  prose. The cost: all this state is **per-process and in-memory**. Restart the API and every
  daemon must reconnect; `init.ts` resets stale `ONLINE` rows to `OFFLINE` on boot to compensate,
  plus two `setInterval` sweepers (stale-online, pairing-code reap). Horizontal scaling of the API
  process is *not* free — daemon WS connections are sticky to one instance.

- **Single-tenant assumptions, flagged for the multi-user migration.** Many lookups hardcode
  `where: { userId }` and equate "owner == requester". The code is honest about it — there are
  explicit `TODO(multi-user)` markers in `arrangement/controller.ts:applyDirtyNodes`,
  `daemon.ts:getOnlineDaemonIds`, and `daemon.adapter.ts:routeForMachine` documenting exactly
  where to flip ownership checks to membership checks. `notFound` deliberately conflates
  missing/unowned to avoid an ID-probe oracle.

- **`venum` discipline, throws only at boundaries.** Business code returns discriminated unions;
  the only sanctioned `throw` is at a crash boundary (HTTP `asyncHandler` → 500, or
  `ApplicationFailure` inside a Temporal activity for retry classification). Adapters convert
  library throws (Prisma/fetch) into variants. This is enforced by convention, not the compiler.

- **Templates are pinned to a daemon's disk.** A `MachineTemplate.daemonId` exists because the
  overlay upper-dir physically lives on that one host; spawning it elsewhere would 404. The
  machine-create picker filters on this. A real cross-host template story would need shared
  storage.

- **Zod can't cross the Temporal boundary.** Schemas are pre-converted to JSON Schema in
  `buildPrompt` and structured output is re-validated in `callAI`, because zod v4 closures/`_def`
  reshaping don't survive JSON serialization. A subtle footgun documented inline.

- **Optimistic-then-fill races are handled by idempotent writes**, not locks:
  `updateManyAndReturn` / `createMany skipDuplicates` / pre-check-then-tx. A user deleting a node
  mid-run is treated as normal (quiet drop), not an error.
