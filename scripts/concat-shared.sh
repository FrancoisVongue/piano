#!/bin/bash
# Concatenate all shared package TypeScript source.

source "$(dirname "$0")/_concat-lib.sh"

print_header "Shared TypeScript Files"

find shared/src -type f \( -name "*.ts" -o -name "*.tsx" \) \
    "${COMMON_EXCLUDES[@]}" \
    -print0 2>/dev/null | print_files_sorted

print_footer "Shared TypeScript Files"
