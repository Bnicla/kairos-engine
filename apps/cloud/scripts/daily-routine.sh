#!/bin/zsh
# Kairos daily routine (launchd: com.kairos.daily):
#   1. prune-closed  — move draft apps with dead listings to the Closed column
#   2. sourcing-run  — fresh sweep + triage into the Sourced column
# Logs to ~/Kairos/sourcing/daily.log (kept small: last run only).
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
export CLAUDE_CLI_PATH="${CLAUDE_CLI_PATH:-$HOME/.local/bin/claude}"
REPO="$HOME/Documents/Kairos"
LOG="$HOME/Kairos/sourcing/daily.log"

{
  echo "=== Kairos daily routine: $(date '+%Y-%m-%d %H:%M:%S') ==="
  cd "$REPO" || exit 1
  echo "--- prune-closed ---"
  npm -w kairos-cloud run prune-closed
  echo "--- sourcing-run ---"
  npm -w kairos-cloud run sourcing-run
  echo "=== done: $(date '+%H:%M:%S') ==="
} > "$LOG" 2>&1
