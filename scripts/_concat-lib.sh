#!/bin/bash
# Shared helpers for concat-*.sh scripts.
# Source via: source "$(dirname "$0")/_concat-lib.sh"

set -euo pipefail

# Always run from the repo root so relative paths inside scripts are stable.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Common exclusion patterns for `find -not -path ...`.
# Used across frontend/backend/shared scripts.
COMMON_EXCLUDES=(
    -not -path "*/node_modules/*"
    -not -path "*/.next/*"
    -not -path "*/out/*"
    -not -path "*/dist/*"
    -not -path "*/build/*"
    -not -path "*/coverage/*"
    -not -path "*/.vercel/*"
    -not -path "*/.turbo/*"
    -not -name "next-env.d.ts"
    -not -name "*.tsbuildinfo"
    -not -name ".env*"
)

print_header() {
    echo "=== $1 ==="
    echo ""
}

print_footer() {
    echo "=== End of $1 ==="
}

# Print a single file with a separator header. Silently skips if missing.
print_file() {
    local file_path="$1"
    if [ -f "$file_path" ]; then
        echo "========================================"
        echo "File: $file_path"
        echo "========================================"
        cat "$file_path"
        echo ""
        echo ""
    fi
}

# Read NUL-delimited paths from stdin, sort, print each.
# Usage: find ... -print0 | print_files_sorted
print_files_sorted() {
    # shellcheck disable=SC2016
    sort -z | tr '\0' '\n' | while IFS= read -r file; do
        [ -n "$file" ] && print_file "$file"
    done
}
