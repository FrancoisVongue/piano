#!/bin/bash
# Frontend concat with heavy/noisy subtrees trimmed to preserve AI context.
# Excluded vs concat-frontend.sh:
#   - components/ui/**       (shadcn primitives — rarely need to read)
#   - **/*.test.*, **/*.spec.*, **/__tests__/**
#   - **/*.stories.*
#   - app/globals.css        (styling noise)

source "$(dirname "$0")/_concat-lib.sh"

print_header "Frontend Source Files (short)"

find frontend/src -type f \
    \( -name "*.ts" -o -name "*.tsx" \) \
    "${COMMON_EXCLUDES[@]}" \
    -not -path "*/components/ui/*" \
    -not -path "*/__tests__/*" \
    -not -name "*.test.ts" \
    -not -name "*.test.tsx" \
    -not -name "*.spec.ts" \
    -not -name "*.spec.tsx" \
    -not -name "*.stories.ts" \
    -not -name "*.stories.tsx" \
    -print0 2>/dev/null | print_files_sorted

print_footer "Frontend Source Files (short)"
