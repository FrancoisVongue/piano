#!/bin/bash
# Concatenate all backend TypeScript source. Configs/Dockerfiles live in
# concat-config.sh / concat-devops.sh.

source "$(dirname "$0")/_concat-lib.sh"

print_header "Backend TypeScript Files"

find backend -type f \
    \( -name "*.ts" -o -name "schema.prisma" \) \
    "${COMMON_EXCLUDES[@]}" \
    -print0 2>/dev/null | print_files_sorted

print_footer "Backend TypeScript Files"
