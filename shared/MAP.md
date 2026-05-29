# `shared/` — The Domain Language of Piano

> A cartographer's map of `@piano/shared`. This is not API docs. It is the
> **vocabulary** the whole system speaks — the nouns, their states, and the
> verbs (morphisms) defined on them. Read this to understand *what Piano models*
> and *where the contracts live*, not how any one feature works.

---

## 1. System Context

`@piano/shared` is a tiny, dependency-light TypeScript package (`type: module`,
~4.7k LOC across 24 type files + 4 util files). It exports **one namespace per
domain noun**, each colocating its `Model`, its DTOs, its Zod schemas, and its
pure functions. There is **no runtime, no I/O, no classes** here — just types
and pure functions. It is the "functional core" half of the functional-core /
imperative-shell split; backend `services/` and frontend stores are the shell.

```
                         ┌───────────────────────────────┐
                         │        @piano/shared          │
                         │  (domain nouns + pure verbs)  │
                         │                               │
                         │  Note  Edge  Arrangement      │
                         │  Action Unifier Workflow      │
                         │  Daemon Machine* MachineTemplate│
                         │  LLM  Run  User  UserApiKey   │
                         │  Files Terminal Secret SSE …  │
                         └───────────────────────────────┘
                            ▲            ▲            ▲
            imports         │            │            │  imports
        (101 files)         │            │            │  (53 files)
                 ┌──────────┘            │            └──────────┐
                 │                       │                       │
          ┌──────┴──────┐         (Go — does NOT          ┌──────┴──────┐
          │  frontend   │          import shared;         │   backend   │
          │ [React,     │          re-implements          │ [Express,   │
          │  Zustand,   │          algorithms like        │  Prisma,    │
          │  React Flow]│          ancestor traversal     │  Temporal,  │
          └─────────────┘          in machine.go)         │  NATS]      │
                                        │                 └─────────────┘
                                  ┌─────┴─────┐
                                  │  daemon   │
                                  │   [Go,    │
                                  │  Podman]  │
                                  └───────────┘
```

The split is real and load-bearing: **frontend is the heaviest consumer (101
files), backend second (53), the Go daemon zero.** Where shared types describe
daemon concepts (`Machine.State`, `Files.*`, `Terminal.ClientFrame`) they are a
**wire contract** the Go side mirrors by hand — see the explicit "keep in sync
with `daemon/machine.go:17-33`" comment in `machine.ts`.

What the product *is* (from the doctrine): infrastructure to run a **fleet of AI
coding agents** as a **canvas of machines** (a "GPU", not a linear-chat "CPU").
The shared vocabulary is exactly the dictionary of that canvas: notes/edges form
the graph, actions/unifiers/workflows transform it, machines/daemons/templates
are the runtime substrate.

---

## 2. Domain Language — the nouns and their states

Seven nouns carry the system. The rest are supporting cast.

### `Note` — the universal canvas citizen *(879 LOC, the heart)*

A `Note` is **anything that lives on the canvas**. It is deliberately a single
type with a `Type` discriminator rather than a class hierarchy:

```
Note.Type = USER | ASSISTANT | SYSTEM | GROUP(legacy)   ← "content"   (AI citizens)
          | MACHINE | TERMINAL                           ← "infra"     (daemon-backed)
          | TEXT | ZONE | DRAWING                        ← "annotation"(visual only)
```

The type is collapsed into a **`Kind`** (`annotation | content | infra |
unknown`) and then into a single **decision table** — `Note.capabilities(note)`
returns `{ canRunAction, canBeUnifierSource, canBeAIContext, canOpenEditPanel,
syncable, kind }`. This is the one place every "what can this note do" question
is answered; call sites never branch on `type === 'X'` themselves. That is the
key invariant of the file.

States the note moves through (`Note.Status`): a persisted lifecycle
(`PROVISIONING → RUNNING | FROZEN` for daemon-backed nodes; `EXPECTING_AI_RESPONCE
→ FRESH_RESPONCE` for AI nodes) **plus** transient UI-only states (`idle`,
`running`, `saving`, `error`, …). The split matters: only the 5 persistable
statuses are allowed onto the wire (`Note.Patch.fromRfNode` strips the rest), so
UI churn never reaches the DB.

Raw-vs-Validated discipline shows up as **parse boundaries** on two `unknown`
fields rather than separate types: `cacheConfig` and `windowLayout` are typed
`unknown` on `Model` *on purpose* (Prisma's `JsonValue` is wider than the schema)
and are narrowed exactly once through `Note.CacheConfig.asConfig(...)` /
`MachineWindow.validate.layout(...)`. The comment is explicit: "never read this
field directly — go through the morphisms."

Sub-namespaces inside `Note`:
- **`Note.CacheConfig`** — per-note, per-model LLM cache anchor (user intent
  `{ttl, enabled}` + backend-managed `runtime` handle, nested so UI ignores it).
- **`Note.Layers`** — layer membership (`[]` = global; non-empty = visible only
  when an active layer matches).
- **`Note.Patch`** — the optimistic-sync wire shape (create/update categorization,
  RfNode ↔ wire mapping).

### `Edge` — the graph structure *(437 LOC)*

A directed connection between notes. The Model is thin; the **value is in the
pure graph algorithms** that live on the namespace and are the *single source of
truth shared by frontend and backend* (the daemon re-implements them in Go):
`findParent(s)`, `findChildren`, `getAncestorIds`, `getAllPathsToRoots`,
`findPathsWithOverrides` (respects `Note.ancestorOverride` short-circuits),
`getDescendantIds`, `hasMultiplePaths`. These power AI context assembly — an AI
note's prompt = the text of its ancestor chain. DAGs are supported via
**merge points** (`Note.isMergePoint` allows multiple parents); every traversal
carries a path-scoped cycle guard "defence in depth."

### `Arrangement` (aliased `Project`) — the canvas / workspace *(556 LOC)*

A named container of notes + edges owned by a user. Carries per-arrangement
`Config` (visible/ordered action & model ids, with a canonical `null` = "no
overrides" sentinel) and a `systemPrompt`. Notable sub-namespaces:
- **`Arrangement.ExportDoc`** — a versioned, portable JSON document
  (`create`/`validate`/`remapIds`). Deliberately **excludes MACHINE/TERMINAL
  notes** — machines are tied to a daemon and can't round-trip.
- **`Arrangement.Patch`** — the response-accumulator + per-item/bulk outcome
  recorders for the optimistic-sync endpoint.
- **`DEFAULT_WORKFLOW`** — the research canvas seeded into every new account.

### `Action` & `Unifier` — the transformations *(321 / 201 LOC)*

Two flavours of "run AI over notes":
- **`Action`**: 1 source note → child node(s). `outputStyle = SINGLE_CHILD |
  MULTIPLE_CHILDREN`. Ships 3 defaults (Split / Play / Summarize). Pure
  prompt-builders (`buildPromptWithAncestors`, `wrapForMultipleChildren`,
  `parseMultipleChildrenResponse`) and Temporal/NATS job shapes
  (`Action.Job.Fill | Create` — a tagged union replacing an old nullable dance).
- **`Unifier`**: many notes → one (or many) unified node(s). `outputStyle =
  SINGLE_NODE | MULTIPLE_NODES`. Same prompt-builder pattern + centroid
  positioning helpers.

### `Workflow` — declarative multi-level automation *(137 LOC)*

An ordered list of `Level`s (a dependency graph): each level plants `contexts[]`
USER notes under a parent frontier and runs one `Action` over each. Has a pure
`topoSort` (degrades cycles to no-ops) and a `Job.Run` payload. Reuses Action's
pipeline wholesale — "workflow has no AI logic of its own."

### `Daemon` + `Machine` + `MachineTemplate` — the runtime substrate

- **`Daemon`** *(194 LOC)*: a user-paired daemon process. Carries the
  pairing-code lifecycle (generate, 10-min TTL, one-time token shown once then
  sha256-hashed), reverse-SSH tunnel coords, and the `toSshInfo` morphism that
  builds Cursor/VSCode `ssh-remote+` deeplinks (URL-encoded against injection).
  `status` lowercased from the Postgres enum via `toModel`.
- **`Machine`** *(19 LOC)*: just `State = running | detached | stopped | frozen`
  + `Info`. A pure wire contract mirrored from the Go daemon.
- **`MachineTemplate`** *(65 LOC)*: a saved rootfs overlay; `daemonId`-scoped
  because overlays are local to one daemon's filesystem (`isAvailableOn`).
- **`MachineWindow`** *(333 LOC)*: the in-window tab/split/pane layout for a
  MACHINE node. A recursive `PaneLayout` tree (`pane | split`) with a full set
  of immutable tree morphisms (split/close/detach/move/setRatio) and a lazy Zod
  schema. This is the richest pure-function module after Note/Edge.

### `LLM` — the model catalog *(342 LOC)*

The single source of truth for available models across 4 providers
(`ANTHROPIC | OPENAI | GOOGLE | OPENROUTER`), each with a `CacheCapability`
(controllable TTL or not), `nativeId` (what the SDK wants), pricing table, and
pure cost/cache-ratio estimators (`costFor`, `cacheHitRatio`). Cost is **derived
on read**, never stored, so re-pricing is a table edit.

### Supporting nouns

`User` (+ auth DTOs, `defaultSystemPrompt`), `UserApiKey` (BYOK keys, enabled
model-id sets, `activeModelIds` flattener), `Run` (a persisted AI execution
record), `Secret` (UPPER_SNAKE env vars, masked on read), `Files` (daemon
file-browser wire shape — discriminated `ReadResult: text|image|binary`, with a
deliberate SVG-as-text security note), `Terminal` (PTY client frames),
`Clipboard` (copy/paste node+edge bundle), `Mention` (`@agent-`/`+node-` token
expansion), `Canvas`/`Layout` (dimension constants + child-positioning math),
`SSE`/`API` (event/response envelopes).

---

## 3. Morphisms & Contracts

The codebase follows a **base-morphism convention** per namespace. Practically
every noun exposes some subset of:

| Morphism            | Meaning                                  | Examples                                                        |
|---------------------|------------------------------------------|-----------------------------------------------------------------|
| `create(...)`       | factory → DB-insert shape                | `Note.create`, `Edge.create`, `Arrangement.create`, `User.create` |
| `fromX / toX`       | shape conversion (the ad-hoc-map killer) | `Note.Transform.toRfNode/fromRfNode`, `Daemon.toModel`, `Secret.toModel`, `UserApiKey.toModel`, `Daemon.toSshInfo`, `ExportDoc.toDocument` |
| `validate(...)`     | parse at the boundary (Zod)              | nearly every namespace has a `validate` object/namespace        |
| `update(...)`       | immutable update                         | `Config.withSection`, `CacheConfig.withModel`, all `MachineWindow.*` |

**Validation = parse, not boolean.** The pervasive pattern is
`Type.validate.x(data: unknown): DTO.X` backed by a Zod `.parse()` — it returns
the *narrowed type or throws at the crash boundary*, exactly the "parse, don't
validate" rule. Discriminated unions are used where it counts:
`Note.DTO.ProvisioningIntentSchema` (`template|branch|share`), `Files.ReadResult`
(`text|image|binary`), `LLM.CacheCapability` (controllable vs not),
`Action.Job` (`fill|create`).

**Union for errors / outcomes.** Although the doctrine names `fp-way-core`'s
`Union`, shared itself models result/outcome shapes as **inline tagged unions**
rather than importing that lib: `Edge.Patch.ValidationResult`
(`{valid:true} | {valid:false; reason}`), `Arrangement.Patch.Outcome`
(`{ok:true} | {ok:false; reason}`), and `API.Response<T>`
(`SuccessResponse | ErrorResponse`). The convention "errors are values" holds;
the specific `Union.match` helper is not used in this package.

**How a type flows between layers** (the canonical Note path):

```
 frontend (React Flow node, RfNode)
        │  Note.Patch.fromRfNode(node)        ← strips UI-only status, gates
        ▼                                        daemon fields by type
 wire DTO (Note.DTO.PatchEntity, Zod-validated)
        │  Note.validate.patchPayload(body)   ← backend crash boundary
        ▼
 backend: Note.Patch.categorize → toCreateData / toUpdateData (strips transient
        │                            'provisioning'/'expectedVersion' fields)
        ▼
 Prisma row  ──(Note.Transform.toRfNode)──►  SSE push ──► frontend re-renders
```

The same `Edge.getAllPathsToRoots` / `findPathsWithOverrides` runs on **both**
ends so the frontend's optimistic ancestor preview and the backend's actual
prompt assembly can never disagree.

---

## 4. Architecture Hotspots

- **Where the heavy logic lives:** `note.ts` (879), `arrangement.ts` (556),
  `edge.ts` (437), `models.ts` (342), `machine-window.ts` (333), `action.ts`
  (321). These six are ~65% of the package and are where any structural change
  to the canvas lands first.
- **Churn (git):** `note.ts` (36 touches) and `arrangement.ts` (23) dominate
  history, with `index.ts` (17) and `models.ts` (15) following — confirming Note
  + Arrangement as the volatile center of gravity.
- **Re-export surface:** everything funnels through `src/index.ts` (`export {
  Note }`, `export { Arrangement as Project }`, etc.). Consumers import from the
  package root, so the namespace name *is* the public API.
- **Consumers:** frontend 101 files, backend 53, daemon 0. The most-imported
  files mirror the churn list (note, arrangement, models, edge).

---

## 5. Trade-offs & Known Issues

**1. React Flow is a dependency of `shared` — a doctrine violation.**
`package.json` lists `@xyflow/react`, and `note.ts` / `edge.ts` import
`Node as RfNode` / `Edge as RfEdge` to type `Transform.toRfNode` /
`toRfEdge` / `Note.Patch.fromRfNode`. The doctrine explicitly says frontend-
specific types (React Flow) must **not** live in shared. This is the single
biggest smell in the workspace: a frontend rendering library has leaked into the
common vocabulary. Mitigation present today: `Arrangement.Response.FlowNode/
FlowEdge` define *structural* (React-Flow-compatible) shapes with no import, and
many places type RF data as `any` — but the two `toRfNode/Edge` transforms still
pull the real package in. A clean fix would move those transforms to the
frontend or invert them to the structural `FlowNode` interface.

**2. Prisma stays out — but its widening leaks as `unknown`.**
Good: no `@prisma/client` import anywhere in shared. The cost of that discipline
is the `cacheConfig: unknown` / `windowLayout: unknown` fields on `Note.Model`
and the `Style = … | any` escape hatch — Prisma's `JsonValue` is wider than the
schema, so these are typed loose and narrowed through morphisms. This is a
*deliberate, documented* parse-boundary, not an accident, but it does mean the
type system can't catch a raw-read of those fields.

**3. `any` in the SSE/API event payloads.** `SSE.Message`, `NodeCreated`,
`MachineActivity`, and `API.SSE.*` all type their `data`/`node`/`edge` as `any`
"because the concrete RF shapes live in the services layer." Pragmatic, but it
means the event contract is untyped at exactly the integration seam.

**4. Two overlapping SSE definitions.** `sse.ts` (`SSE` namespace, the live one
with `machine:activity`) and `api.ts` (`API.SSE`, an older/narrower event enum)
both model server→client events. The `API.SSE` copy looks vestigial.

**5. Status string sprawl on `Note.Status`.** Eleven values mixing persisted
states, transient UI states, and legacy lowercase aliases (`idle`/`running`/
`completed`/`error`/`saving`/`creating`). It works because `fromRfNode` filters
to the 5 persistable ones, but the type itself doesn't make the invalid (UI-only)
states unrepresentable at the persistence boundary — that rule is enforced by a
runtime filter rather than the type system.

**6. The Go daemon mirrors algorithms by hand.** `Machine.State`, the Edge
traversal logic, the `Files` size constants, and the image-extension/SVG rules
all have a Go twin that shared cannot enforce. Every such spot carries a
"keep in sync" comment — a known, accepted coupling with no compile-time guard.
