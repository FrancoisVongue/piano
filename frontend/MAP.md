# Piano Frontend — Architecture Map

> A cartographic survey of `frontend/`. Read this before touching the canvas.
> The whole product lives in one Zustand store and one infinite canvas; everything
> else is plumbing into it. If you understand `domain/canvas/store.ts` and the
> two sync loops (HTTP PATCH + SSE), you understand the frontend.

---

## 1. System Context

The frontend is a **Next.js 15 (App Router, React 19, Turbopack) SPA** whose one
serious screen is an infinite **React Flow** canvas. Nodes are notes / AI agents /
machines / terminals; edges are context-dependencies. It does not talk to the
daemon, Temporal or NATS directly — everything funnels through a single **Caddy
edge** to the **backend**, which fans out to daemons.

```
                        ┌──────────────────────────────────────────────┐
   Browser              │              FRONTEND  (Next.js SPA)           │
 ┌─────────┐            │                                                │
 │ React   │            │  app/(app)/arrangements?id=X   ← the canvas    │
 │ Flow    │◀──────────▶│        │                                       │
 │ canvas  │  render    │        ▼                                       │
 └─────────┘            │  domain/canvas/store.ts  (Zustand, the brain)  │
      ▲                 │        │            ▲                          │
      │ xterm WS        │   HTTP │            │ SSE events                │
      │                 │ (PATCH/│            │ (run.update, node:*,      │
      │                 │  exec) │            │  machine:activity)        │
      └─────────────────┼────────┼────────────┼──────────────────────────┘
        terminal bytes  │        ▼            │
                        └────────┼────────────┼──────────────► [Caddy edge]
                                 │            │                     │
                                 ▼            ▼                     ▼
                         /api/*  (REST)   /events (SSE)     /api/terminal/:id (WS)
                                 └────────────┴─────────────────────┘
                                              │
                                        [BACKEND Express]
                                              │
                                       [daemons / Temporal / NATS]
```

Three wire surfaces, all over the **same `BASE_URL`** (config/index.ts — one edge
on purpose):

| Surface | Carrier | Where it lives | Carries |
|---|---|---|---|
| `/api/*` | `fetch` (Union-wrapped) | `services/api.ts` | CRUD, PATCH sync, action execution |
| `/events?clientId=` | `EventSource` (SSE) | `lib/sse.ts`, `canvas/hooks/useRunningNodePolling.ts` | live node/run/machine updates |
| `/api/terminal/:machineId` | raw `WebSocket` + xterm | `terminal/.../TerminalPanel.tsx` | PTY bytes both ways |

Auth is **better-auth** cookies (`credentials: 'include'`) plus a `Bearer <user.id>`
header pulled from a tiny persisted Zustand `authStore`.

---

## 2. Domain Language

Seven nouns carry the whole system. Learn these and the file tree reads itself.

- **Arrangement** — a project = one saved canvas (a graph of notes + edges). The
  unit you open, sync, and run. `domain/arrangement/`, shared type `Arrangement.Model`.
- **Note** — the persisted backend entity behind almost every canvas node. Has a
  `type`: `USER | ASSISTANT | SYSTEM | GROUP | MACHINE | TERMINAL | TEXT | ZONE | DRAWING`.
  The shared `Note` type is the wire contract; the frontend wraps it as `CanvasNode.UI`.
- **CanvasNode** — the React Flow view of a Note. A discriminated union
  (`canvas/types.ts`): note-roles (run AI), MACHINE (a container), TERMINAL (a shell),
  and pure-canvas shapes (TEXT/ZONE/DRAWING) that have no backend behaviour.
- **Edge** — a context dependency. Parent feeds context to child; the run engine
  walks edges to the root to assemble a prompt. Multiple paths → **Cartesian product**
  execution (`EdgeModel.findPathsWithOverrides`).
- **Machine** — an isolated Linux container (Podman). Canvas verbs: **freeze**
  (→ template), **branch** (fork into a child node), **activate/deactivate**.
  `domain/machine/services.ts`.
- **MachineWindow / Pane** — a MACHINE node can host a tiling tree of terminal
  **panes** (its own sub-store + use-cases). A canvas TERMINAL node can be
  **demoted** into a pane, or a pane **promoted** back out to the canvas.
- **Action** — a runnable prompt/template (`domain/action/`) invoked on a note via
  `runNode(nodeId, actionId)`; the backend spawns a RUNNING child note + edge.

Supporting nouns: **Template** (frozen machine snapshot, machine-center), **Layer**
(named visibility group on nodes), **Dirty entity** (a node/edge pending sync).

---

## 3. The Pipeline

Everything interesting is one of three loops over the central store. Read them in
order.

### 3.0 The store is the only brain

`domain/canvas/store.ts` is **3,870 lines** and ~80 actions — by far the most-churned
file in the whole repo (git: 86 touches). Its own header says "Canvas UI state only —
no server data, no business logic," and it mostly keeps that promise by delegating
domain math to `@piano/shared` (`topologicalSort`, `findPathsWithOverrides`,
`Note.Transform`, `Note.Patch`) and side effects to the per-domain `services/`. What
it *does* own is the hard part: React Flow change application, undo/redo history,
and the **two-phase dirty-tracking** state machine that the sync loop drains.

State worth knowing (see the `CanvasStore` interface, ~line 256):
- `nodes` / `edges` — the React Flow arrays (source of truth while editing).
- `history[]` + `currentHistoryIndex` — undo/redo, with `normalizeNodesForHistory`
  stripping ephemeral `status`/run state and `mergeRuntimeState` re-overlaying live
  AI content on restore so undo never wipes a streaming answer.
- `dirtyEntityIds` / `dirtyInFlightIds` — the **two-phase buffer** (see 3.1).
- `demotedNodeIds` — deletes that are really pane-demotions, routed specially.
- `arrangementSnapshots: Map` — per-arrangement local snapshot (nodes+edges+history)
  so switching tabs and back restores your exact in-progress state instead of a stale
  React Query cache.
- `runningNodes` / `runStartedAt` / `branchingNodes` — ephemeral run/branch UI state.
- Layer context (`activeLayer`, `visibleLayers`, `knownLayers`, `globalVisible`),
  viewport zoom helpers, and React-Flow imperative handles.

A custom equality fn `areNodesStructurallyEqual` lets non-positional subscribers
(dropdowns, nav) skip re-render on every drag tick — the canvas itself opts out so
React Flow repaints the moved node.

### 3.1 The edit → sync loop (optimistic, LWW, two-phase)

This is the spine. A user edit mutates the store optimistically, marks the entity
dirty, and a debounced hook batches a PATCH to the backend.

```
  user edits node ──▶ store action (immer produce)
                        │  set nodes/edges
                        │  setDirty(id, true, 'node'|'edge')
                        │  lastChangeTimestamp = Date.now()   ← updates on EVERY edit
                        ▼
  useCanvasSync subscribes to lastChangeTimestamp
                        │  useDebouncedCallback(2000ms)  ← timer resets each keystroke
                        ▼
  runPatch(id):
     pushHistory()                       // keep undo coordinated with server
     beginSync(): dirty ──MOVE──▶ dirtyInFlight   (dirty now ∅, ready for new edits)
     build PatchPayload via Note.Patch.fromRfNode   // wire-shape owned by shared
        (MACHINE nodes overlay windowLayout from MachineWindow store)
        (deletes split into deletedNodeIds | deletedEdgeIds | demotedNodeIds)
     ArrangementService.patch(id, payload)  ──HTTP──▶ backend
                        ▼
     Union.match:
        success({processed, failed}): endSyncSuccess clears ONLY processed in-flight;
                                       unacked merge back into dirty for retry
        error: endSyncFailure → in-flight folds back to dirty → next debounce retries
```

Why two-phase? Edits that happen **while a PATCH is in flight** (e.g. a Ctrl+Z
mid-sync) land in the freshly-emptied `dirty` set and survive the success handler,
so nothing is silently dropped. Cmd+S → `forceSync()` cancels the debounce and
flushes immediately. On tab switch the cleanup effect fires a patch for the
*previous* arrangement id (captured in closure) so leaving-tab edits aren't written
to the wrong project. Conflict policy is **last-write-wins** for structural changes.

### 3.2 The run → stream loop (AI execution)

```
  runNode(nodeId, actionId):
     guard: Note.capabilities(data).canRunAction   // only content notes originate
     EdgeModel.findPathsWithOverrides(...)          // 1 path = single, >1 = Cartesian
     piggyback any dirty edits as patchPayload (no separate sync round-trip)
     ArrangementService.executeAction(...)  ──HTTP──▶ backend spawns RUNNING child
                        ▼
     success(RunResult): push responseNode + responseEdge into store (dedup by id),
                         runStartedAt.set(id, now)   // grace window vs hot-finger delete
                        ▼
  ── meanwhile, over SSE ──
  lib/sse.ts                         canvas/hooks/useRunningNodePolling.ts
   'run.update'  ─▶ updateNodeContent(noteId, content) + setNodeRunning(true)
   'run.complete'─▶ updateNodeContent(...) + setNodeRunning(false)
   'node:created' / 'node:updated' / 'node:deleted' ─▶ reconcile store (dedup by id)
   'machine:activity' ─▶ machine-center store (live MachineNode headers / pane chrome)
```

Two **separate `EventSource` connections** to the same `/events?clientId=<userId>`
endpoint exist (`lib/sse.ts` for run.* content streaming; `useRunningNodePolling.ts`
for node/machine lifecycle) — both with reconnect/backoff. SSE is treated as
best-effort liveness; the HTTP response from `executeAction` is the authoritative
spawn, and SSE replays are defensively deduped by id everywhere.

### 3.3 The terminal loop (raw bytes)

Terminals bypass the store entirely. `TerminalPanel.tsx` opens a `WebSocket` to
`/api/terminal/:machineId` (backend proxies to the owning daemon — daemons have no
public port), wires it to **xterm.js** + FitAddon, and pumps a small framed
`TerminalProtocol` (`{type:'input'|'resize'|'file'}`). On connect it even pushes
`context.md` down the wire as a `file` frame. A canvas TERMINAL node and an
in-window pane are the same substrate; the difference is whether a Note row exists
(canvas node) or it's pure layout state in the MachineWindow store (pane).

### 3.4 Load / boot

`arrangements/page.tsx` reads `?id=` → `useCanvas(id)` → React Query
`useArrangement` fetches the arrangement → `loadCanvasState(notes.map(toRfNode),
edges.map(toRfEdge))`. `useMachineActivityFeed` seeds machine metrics and lets SSE
keep them live (60s interval is only a dropped-connection safety net).

---

## 4. Architecture Hotspots

Where the load-bearing code physically lives:

- **`domain/canvas/store.ts`** (137 KB, ~3.9k lines) — the brain. Every canvas verb,
  undo/redo, dirty tracking, run orchestration. Start here, always.
- **`domain/canvas/types.ts`** (754 lines) — `CanvasNode.UI` discriminated union +
  factories/guards, `MachineLabel` branch-naming, `CanvasState`, `BulkOperations`.
  The type that explains the canvas.
- **`domain/canvas/hooks/useCanvasSync.ts`** — the two-phase optimistic PATCH loop.
  The single most subtle piece of logic in the app.
- **`lib/sse.ts`** + **`canvas/hooks/useRunningNodePolling.ts`** — the two SSE
  streaming surfaces feeding live state into the store.
- **`domain/canvas/components/MachineWindow/`** — the tiling pane subsystem: its own
  `store.ts` (layouts + focus primitives, no logic) and `use-cases/` (spawn/split/
  demote/drop, composing `MachineService` + store morphisms). A clean miniature of
  the project's "store = state, use-cases = composition" doctrine.
- **`domain/terminal/components/TerminalPanel.tsx`** — the xterm/WebSocket bridge.
- **`services/api.ts`** — the one `fetch` adapter; converts HTTP into `Union.Variant`,
  injects auth + W3C `traceparent`. Per-domain `services/*.ts` are thin wrappers over it.
- **`domain/<x>/store.ts`** — secondary global Zustand stores: `auth` (persisted user),
  `machine-center` (machines/metrics/activity), `action`, `workflow`, `unifier`.

Sidebar list screens (`app/(app)/{machines,actions,workflows,unifiers,settings}`)
are conventional CRUD over their domain services — minor relative to the canvas.

---

## 5. Trade-offs & Known Issues

- **One mega-store.** `store.ts` at ~3.9k lines is the central risk: it concentrates
  the entire canvas contract, so churn and merge conflicts land here (it's the
  most-edited file in the repo). It stays sane only because domain math is pushed to
  `@piano/shared` and side effects to `services/`. Watch for logic creeping back in.
- **Optimistic LWW.** The two-phase buffer prevents *dropping* concurrent edits, but
  the conflict policy is still last-write-wins — no merge of competing structural
  edits across clients. Acceptable for the single-developer-many-agents use case;
  not multi-human collaborative.
- **SSE as best-effort, HTTP as truth.** Two `EventSource` connections + the
  `executeAction` HTTP response can describe the same node, so the codebase is
  littered with defensive dedup-by-id and the 60s metrics re-seed. Liveness is
  eventual, not guaranteed; a missed SSE event is healed by the next poll/refetch.
- **`useSse.ts` vs `lib/sse.ts` duplication.** `hooks/useSse.ts` (a generic message
  collector) appears legacy/unused next to the purpose-built `lib/sse.ts`. Likewise
  `store-valtio.ts` and `src/domains/canvas/` (empty, dated 2025) are dead/legacy
  alongside the live `src/domain/`. Scissors candidates.
- **Sync payload drift.** `useCanvasSync` builds the patch via `Note.Patch.fromRfNode`
  (shared, authoritative), but `runNode`'s inline `patchPayload` hand-rolls a *subset*
  of fields. Two builders for the same wire shape — a latent inconsistency.
- **Terminal `DIRECT_DAEMON_URL` hatch** bypasses the backend proxy for local daemon
  debugging — a dev-only seam that shouldn't ship enabled.

---

### Crash-boundary / Union discipline note
Per the project doctrine, services return `Union.Variant<{success,error}>` rather
than throwing; the store/use-cases `Union.match` on them. `services/api.ts` is the
adapter that converts `fetch` rejections + non-2xx into the `error` variant, so
business code never sees a raw throw. This is consistently followed across the
domain `services/`.
