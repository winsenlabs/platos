#!/bin/bash
# Run each gate INDIVIDUALLY and report pass/fail. No `timeout` wrapper (macOS
# has no such binary and wrapping reports a false red on every one).
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
cd /tmp/pl-t5p-work || exit 1
mkdir -p /tmp/pl-t5p-logs
for gate in "$@"; do
  slug=$(echo "$gate" | tr ' /:*"' '-----')
  log="/tmp/pl-t5p-logs/${slug}.log"
  if ( set -eo pipefail; eval "$gate" ) >"$log" 2>&1; then
    echo "PASS  $gate"
  else
    echo "FAIL  $gate   (log: $log)"
  fi
done
