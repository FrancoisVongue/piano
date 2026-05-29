#!/bin/bash
# Concatenate all DevOps / infra files: task runner, orchestration, containers,
# CI, env management, setup scripts, reverse proxy.

source "$(dirname "$0")/_concat-lib.sh"

print_header "DevOps / Infra Files"

# Root-level orchestration & env.
for f in \
    Justfile \
    Tiltfile \
    .mise.toml \
    .envrc \
    .dockerignore \
    setup.sh \
; do
    print_file "$f"
done

# All docker-compose variants + Caddyfiles at repo root.
find . -maxdepth 1 -type f \
    \( -name "docker-compose*.yml" -o -name "docker-compose*.yaml" -o -name "Caddyfile*" \) \
    -print0 2>/dev/null | print_files_sorted

# Dockerfiles / Containerfiles anywhere in the repo (excluding node_modules etc).
find . \
    -type f \
    \( -name "Dockerfile*" -o -name "Containerfile*" \) \
    "${COMMON_EXCLUDES[@]}" \
    -not -path "./.git/*" \
    -not -path "./.yoyo/*" \
    -not -path "./terminal-poc/*" \
    -not -path "./react_example/*" \
    -print0 2>/dev/null | print_files_sorted

# CI workflows.
find .github -type f \( -name "*.yml" -o -name "*.yaml" \) -print0 2>/dev/null | print_files_sorted

# Git hooks we manage.
find .husky -type f -not -path "*/\_/*" -print0 2>/dev/null | print_files_sorted

# Daemon env (machine image inputs).
find daemon/env -type f -print0 2>/dev/null | print_files_sorted

# Scripts directory (excluding the concat scripts themselves).
find scripts -type f -name "*.sh" \
    -not -name "concat-*.sh" \
    -not -name "concat.config.sh" \
    -not -name "_concat-lib.sh" \
    -print0 2>/dev/null | print_files_sorted

# Terraform / infrastructure-as-code.
find infrastructure -type f \( -name "*.tf" -o -name "*.tfvars*" -o -name "*.hcl" \) \
    -not -path "*/.terraform/*" \
    -print0 2>/dev/null | print_files_sorted

print_footer "DevOps / Infra Files"
