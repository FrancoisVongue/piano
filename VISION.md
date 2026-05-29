# Piano

**Infrastructure for AI coding agents.**

We don't build agents. We free them from the single machine and the 1D chat window.

---

## The question that defines the company

> **You're a solo developer. You have 12 tickets on your board. Claude Code can finish any one of them unattended. What's actually stopping you from shipping all 12 today, in parallel?**

Not the model. Not your skill. Not the tickets.

What's stopping you is **infrastructure**:

- You have **one machine**. Two agents editing the same repo trash each other's work.
- You have **one chat window**. You can only watch one agent at a time.
- You have **one context thread**. Agent B can't see what Agent A just decided.
- You have **no supervisor view**. 12 terminals is not "parallelism," it's chaos.
- You have **no durable state**. Kill a tab, lose an hour.

Every one of those is an infrastructure problem. None of them is an agent-quality problem. **Better models do not fix any of them.**

That's our wedge.

## What Piano actually is

Piano is the **runtime and control plane** that turns any AI coding agent — Claude Code, Codex, Cursor's agent, whatever ships next month — into a fleet you can direct from one screen.

Three primitives, nothing else:

1. **Machines.** Isolated, persistent Linux environments. One per agent. Fork, freeze, resume. Podman + overlayfs under the hood; full SSH and editor access on top.
2. **Graph.** A canvas where nodes are agents-in-machines and edges are dependencies. Parents feed context to children. Siblings run in parallel. Temporal schedules it; you see it.
3. **Supervisor.** One view of every agent: streaming output, attachable terminals, approve/reject.

**That's the whole product.** We don't train models. We don't write prompts. We make every model you already pay for worth more.

## The insight

> **A linear chat is a CPU. A canvas of machines is a GPU.**

Agent vendors are optimizing single-threaded throughput: bigger context, better tools, sharper model. Piano optimizes **parallel throughput**: how many good agents can one human direct per hour.

Different S-curve. Different math.

## Who it's for

**Senior engineers and small teams already paying for multiple coding agents.** They already try to run them in parallel with git worktrees, tmux, and multiple editor windows. They already feel the pain daily. They don't need convincing that parallelism is valuable — they need it to not be miserable.

## What we have

- ✅ **Per-agent machines.** Podman + overlayfs, fork/freeze/resume, sub-second cold starts.
- ✅ **Single-port SSH gateway.** Any editor (VS Code, Windsurf, Cursor) attaches to any machine.
- ✅ **Visual canvas with tree context.** React Flow, Zustand, undo/redo.
- ✅ **Terminal nodes** — live container shells as first-class canvas citizens.
- ✅ **Temporal + NATS** for durable scheduling and events.
- ✅ **Streaming execution per node**, auth, arrangements, persistence.

The hard half — the runtime — already works.

## What's left to ship the "12 tickets in one day" promise

1. **Supervisor inbox.** "These 4 agents are waiting for you." Keyboard-driven approve / reject. Without this, 12 agents = 12 tabs = worse than 1.
2. **Agent adapters.** First-class support for Claude Code, Codex, Cursor agent, custom scripts. We don't pick winners; we run them all.
3. **Templates.** Save a canvas layout as a reusable workload. "Ship a feature," "fix a bug," "write a migration." Turns a one-off into a callable function.
4. **Tighter git integration (later).** Piano machines already have git; first-class branch/worktree/PR flows come once the core loop is proven.

Everything else is deferred.

## The promise, in one sentence

> **End the day with your board empty — not because you worked harder, but because your agents finally had somewhere to work.**

That's the product. That's the bet.
