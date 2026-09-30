#!/usr/bin/env bash
# coredoc-statusline.sh — fast, non-blocking Claude Code status line.
#
# Reads the status JSON from stdin (https://code.claude.com/docs/en/statusline.md)
# and prints one line:
#   model · ctx% · 5h limit · 7d limit · branch · dir · time
#
# Every segment degrades gracefully and the script always exits 0 — it can never
# block or slow a session. The context-window and rate-limit bars surface how much
# headroom is left before a limit or a compaction.
#
# Enable by pointing statusLine.command at this file in ~/.claude/settings.json:
#   "statusLine": {
#     "type": "command",
#     "command": "/absolute/path/to/plugins/coredoc/scripts/coredoc-statusline.sh"
#   }
# Requires `jq` (brew install jq).

set -u

ESC=$'\033'
RESET="${ESC}[0m"
DIM="${ESC}[2m"
CYAN="${ESC}[36m"
YELLOW="${ESC}[33m"
GREEN="${ESC}[32m"
RED="${ESC}[31m"

JSON="$(cat 2>/dev/null || true)"

if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' "${DIM}coredoc-statusline: requires \`jq\` (brew install jq)${RESET}"
  exit 0
fi

jget() { printf '%s' "$JSON" | jq -r "$1 // empty" 2>/dev/null; }
jnum() { printf '%s' "$JSON" | jq -r "$1 // \"\"" 2>/dev/null; }

# --- cwd ---
cwd="$(jget '.workspace.current_dir')"
[ -z "$cwd" ] && cwd="$(jget '.cwd')"
[ -z "$cwd" ] && cwd="$PWD"

# --- model ---
model="$(jget '.model.display_name')"
[ -z "$model" ] && model="$(jget '.model.id')"
[ -z "$model" ] && model="?"

# --- usage bars (context window + rate limits) ---
color_for() {
  local p=$1
  if [ "$p" -ge 90 ]; then printf '%s' "$RED"
  elif [ "$p" -ge 70 ]; then printf '%s' "$YELLOW"
  else printf '%s' "$GREEN"
  fi
}
bar_for() {
  local p=$1 width=8 filled i out=""
  filled=$(( p * width / 100 ))
  [ "$filled" -lt 0 ] && filled=0
  [ "$filled" -gt "$width" ] && filled=$width
  for ((i=0; i<filled; i++)); do out+="█"; done
  for ((i=filled; i<width; i++)); do out+="░"; done
  printf '%s' "$out"
}
seg_bar() {
  local label=$1 raw=$2 pct c
  if [ -z "$raw" ] || [ "$raw" = "null" ]; then
    printf '%s%s ?%s' "$DIM" "$label" "$RESET"
    return
  fi
  pct=$(printf '%.0f' "$raw" 2>/dev/null || echo "")
  if [ -z "$pct" ]; then
    printf '%s%s ?%s' "$DIM" "$label" "$RESET"
    return
  fi
  c=$(color_for "$pct")
  printf '%s%s%s %s%s %d%%%s' "$DIM" "$label" "$RESET" "$c" "$(bar_for "$pct")" "$pct" "$RESET"
}

ctx_seg="$(seg_bar 'ctx' "$(jnum '.context_window.used_percentage')")"
h5_seg="$(seg_bar '5h' "$(jnum '.rate_limits.five_hour.used_percentage')")"
d7_seg="$(seg_bar '7d' "$(jnum '.rate_limits.seven_day.used_percentage')")"

# --- branch (+ worktree hint) ---
branch_seg=""
branch="$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
  wt_hint=""
  [ -n "$(jget '.workspace.git_worktree')" ] && wt_hint=1
  case "$cwd" in
    */worktrees/*) wt_hint=1 ;;
  esac
  if [ -n "$wt_hint" ]; then
    branch_seg="${CYAN}${branch}${RESET}${DIM} wt${RESET}"
  else
    branch_seg="${CYAN}${branch}${RESET}"
  fi
fi

# --- dir basename + time ---
if [ "$cwd" = "$HOME" ]; then
  dir_disp="~"
else
  dir_disp="$(basename "$cwd")"
fi
dir_seg="${YELLOW}${dir_disp}${RESET}"
time_seg="${DIM}$(date +%H:%M)${RESET}"

# --- assemble ---
SEP="${DIM} │ ${RESET}"
line="${model}${SEP}${ctx_seg}${SEP}${h5_seg}${SEP}${d7_seg}"
[ -n "$branch_seg" ] && line+="${SEP}${branch_seg}"
line+="${SEP}${dir_seg}${SEP}${time_seg}"

printf '%s\n' "$line"
exit 0
