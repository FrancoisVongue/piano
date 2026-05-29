#!/bin/bash
# Concatenate all project configuration files (package.json, tsconfig, lint,
# build/framework configs, prisma schema). No infra/devops here — see
# concat-devops.sh for Dockerfiles/compose/Tilt/CI.

source "$(dirname "$0")/_concat-lib.sh"

print_header "Project Configuration Files"

# Explicit root-level configs.
for f in \
    package.json \
    pnpm-workspace.yaml \
    .prettierrc \
    .eslintrc.json \
    tsconfig.json \
    tsconfig.base.json \
; do
    print_file "$f"
done

# Per-package configs: every package.json + tsconfig*.json + framework/lint
# configs under backend/frontend/shared/daemon, excluding node_modules.
find backend frontend shared daemon \
    -type f \
    \( \
        -name "package.json" \
        -o -name "tsconfig*.json" \
        -o -name ".eslintrc*" \
        -o -name "eslint.config.*" \
        -o -name ".prettierrc*" \
        -o -name "next.config.*" \
        -o -name "tailwind.config.ts" \
        -o -name "tailwind.config.js" \
        -o -name "tailwind.config.mjs" \
        -o -name "postcss.config.ts" \
        -o -name "postcss.config.js" \
        -o -name "postcss.config.mjs" \
        -o -name "components.json" \
    \) \
    "${COMMON_EXCLUDES[@]}" \
    -print0 2>/dev/null | print_files_sorted

print_footer "Project Configuration Files"
