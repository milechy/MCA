#!/usr/bin/env bash
set -euo pipefail

main() {
  local input
  if ! input=$(cat); then
    exit 1
  fi

  # Filter out blank lines and lines starting with #, deduplicate, sort
  printf '%s\n' "$input" \
    | grep -v '^\s*$' \
    | grep -v '^#' \
    | sort -u \
    | LC_ALL=C sort
}

main
