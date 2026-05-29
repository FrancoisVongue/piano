#!/bin/bash
# Concatenate all daemon Go source + module files. Containerfile/env live in
# concat-devops.sh.

source "$(dirname "$0")/_concat-lib.sh"

print_header "Daemon Go Files"

find daemon -type f \
    \( -name "*.go" -o -name "go.mod" -o -name "go.sum" \) \
    -not -path "*/vendor/*" \
    -not -path "*/build/*" \
    -print0 2>/dev/null | print_files_sorted

print_footer "Daemon Go Files"
