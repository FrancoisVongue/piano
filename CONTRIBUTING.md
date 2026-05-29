# Contributing to Piano

Thanks for your interest in improving Piano. This guide covers how to get a dev
environment running and the architectural conventions the codebase follows.

## Getting started

See the [README](./README.md) for the full setup. In short:

```bash
just check      # verify tooling (bun, pnpm, tilt, just, docker, direnv, go)
just setup      # install dependencies
cp .env.secrets.example .env.secrets   # fill in secrets (see comments in the file)
direnv allow .
just dev        # start the full stack via Tilt
```

Do **not** start long-running services yourself when making changes for review —
`pnpm -r typecheck` is the fast feedback loop.

## Repository layout

| Package | Stack | Map |
|---|---|---|
| `frontend/` | Next.js, React, Zustand, React Flow | `frontend/MAP.md` |
| `backend/`  | Express, Prisma, Temporal, NATS | `backend/MAP.md` |
| `daemon/`   | Go, Podman (machine runtime) | `daemon/MAP.md` |
| `shared/`   | TypeScript domain types (`@piano/shared`) | `shared/MAP.md` |
| `piano-cli/`| Go CLI | — |

Read the relevant `MAP.md` before making non-trivial changes — each is a compact
architectural overview of that package.

## Architectural conventions

Piano follows a **functional core, imperative shell** style. The essentials:

- **Domain-centric organization.** Code is grouped by business domain, not by
  technical type. All shapes + pure functions for a domain live in one namespace
  in `@piano/shared`.
- **Errors are values, not exceptions.** Business code returns discriminated
  unions (backend uses [`venum`](https://www.npmjs.com/package/venum); frontend
  uses a `Union` helper). `throw` is reserved for crash boundaries only.
- **Thin composition layers.** Controllers / store actions / hooks read like prose:
  they compose services (adapters to the outside world) and pure type functions.
  No ad-hoc inline transformations or validation — extract those into the type's
  namespace.
- **Parse, don't validate.** Validators return a richer type, not a boolean.

## Submitting changes

1. Branch off `main`.
2. Keep changes focused; follow the conventions above.
3. Ensure `pnpm -r typecheck` passes (the pre-commit hook runs it automatically).
4. Open a pull request describing the intent and the change.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE).
