#!/bin/bash
# Concatenate all frontend source (ts/tsx + app globals.css).

source "$(dirname "$0")/_concat-lib.sh"

print_header "Frontend Source Files"

find frontend/src -type f \
    \( -name "*.ts" -o -name "*.tsx" -o -name "globals.css" \) \
    "${COMMON_EXCLUDES[@]}" \
    -print0 2>/dev/null | print_files_sorted

print_footer "Frontend Source Files"
