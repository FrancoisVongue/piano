# Piano Frontend

Next.js application for the Piano web UI.

## Development

```bash
pnpm dev
```

The root `README.md` and `CONTRIBUTING.md` describe the full-stack setup. In
normal development, run the app through the root `just dev` command so frontend
and backend share the same Caddy edge origin.

## Package

- `src/app/` contains App Router routes.
- `src/domain/` contains feature domains.
- `src/components/ui/` contains shared UI primitives.
