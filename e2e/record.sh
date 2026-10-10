#!/bin/sh
# Records e2e/out/demo.gif: the real faplex on `laptop`, driven with keys, against the rig's real
# harnesses and fake model API. Brings the rig up fresh and tears it down afterwards (KEEP_RIG=1
# leaves it up). Needs docker, termctrl and ffmpeg. Run from anywhere.
#
# A scene is a `step "caption"` followed by keys, `see` (wait for text) and `rest` (reading time for
# the viewer). State changes are always waited for, never slept for, so the timing that can be
# tuned is only the rests (all at once with PACING=1.5) and the typing speed (PACE).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/out"; rec="$out/demo.termctrl"; mp4="$out/demo.mp4"; gif="$out/demo.gif"; edit="$out/edit.json"
COLS=${COLS:-120}; ROWS=${ROWS:-30}; FPS=${FPS:-10}; WIDTH=${WIDTH:-1116}
PACE=${PACE:-22}   # ms per typed character
export TERMCTRL_RUNTIME_DIR=/tmp/tc-faplex-e2e-rec
mkdir -p "$out"; mkdir -p -m 700 "$TERMCTRL_RUNTIME_DIR"
rm -f "$rec" "$mp4" "$gif"
s=faplex-e2e-rec
compose() { docker compose -f "$here/compose.yaml" "$@"; }
cleanup() {
  termctrl stop $s >/dev/null 2>&1 || true
  [ "${KEEP_RIG:-0}" = 1 ] || compose down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

compose down -v >/dev/null 2>&1 || true
compose up -d --build --wait >/dev/null 2>&1 || { "$here/logs.sh"; exit 1; }

key() { termctrl send $s "$@"; }
back() { printf '\035' | termctrl send $s --stdin; }   # ctrl+]
see() { termctrl wait $s "$1" --timeout "${2:-30000}"; }
mark() { termctrl mark $s "$1"; }
# step "caption" [speed]: starts a clip of the video, which runs until the next step (or `mark end`).
# The caption names the keys pressed in it; speed > 1 fast-forwards a stretch with nothing to read.
steps=0; : > "$out/steps.tsv"
step() { steps=$((steps + 1)); mark "s$steps"; printf '%s\t%s\n' "$1" "${2:-}" >> "$out/steps.tsv"; }
# A pause for the viewer to read the screen, in seconds; PACING scales all of them (2 = half as long).
rest() { sleep "$(awk "BEGIN { print $1 / ${PACING:-1} }")"; }

termctrl start $s --host opentui --cols "$COLS" --rows "$ROWS" --record "$rec" -- "$here/faplex.sh"
see "Migrate cron jobs to systemd timers"; see "Clean up stale build artifacts"; see "Bump lodash to 4.17.21"
see "Working 1"; see "Needs input 1"; see "Finished 1"
rest 0.5

# The starting list: one session per machine.
step "faplex · agent sessions on 3 machines, over ssh"
rest 0.9

# 1. A new Codex session on laptop; once prompted it is a Working row.
step "n new session · → → codex on laptop · ⏎"
key text:n; see "New session"
rest 0.35; key right; rest 0.25; key right; rest 0.4
key enter
see "Ask Codex"
rest 0.3
step "type a prompt · ⏎"
key --pace-ms "$PACE" "text:make a cool demo of this project"
rest 0.25
key enter
see "narrated video"
rest 0.7
step "ctrl+] back"
back
see "Working 2"; see "Make a cool demo of this project"
rest 0.6

# 2. A new OpenCode session on devbox, on the (mocked) DeepSeek 4.1 model.
step "n new session · ↓ → opencode on devbox · ⏎"
key text:n; see "New session"
rest 0.35; key down; rest 0.25; key right; rest 0.4
key enter
see "Ask anything"; see "DeepSeek 4.1"
rest 0.5
step "type a prompt · ⏎"
key --pace-ms "$PACE" "text:write release notes for v0.2"
rest 0.25
key enter
see "Collecting the commits"
rest 0.7
step "ctrl+] back"
back
see "Working 3"; see "Write release notes for v0.2"
rest 0.6

# 3. The Claude session that needs input: open it, answer in Claude Code's own prompt, come back.
step "↓ · → open the session that needs input"
key down; rest 0.5
key right
see "Do you want to proceed?"
rest 1.2          # reading time, and lets the dialog settle: a key sent the instant a prompt renders can be dropped
step "1 · approve in Claude Code's own prompt"
key text:1
see "build/ deleted and recreated"
rest 0.9
step "ctrl+] back" 1.6
back
see "Finished 2"
see "build/ cleared and recreated"
rest 0.9

# 4. A follow-up for the Codex session while it is still working. Codex queues a message typed
#    mid-turn until the next tool call and shows it above the prompt; the recording leaves it queued.
step "↑ ↑ · → open the working Codex session"
key up; rest 0.25; key up; rest 0.4
key right
see "narrated video"
rest 0.6
step "type a follow-up · ⏎ · Codex queues it"
key --pace-ms "$PACE" "text:keep it under 20 seconds and make it a GIF"
rest 0.25
key enter
see "Messages to be submitted"
rest 1.6
step "ctrl+] back"
back
see "Working 3"
rest 1.1
mark end

key text:q
sleep 1
termctrl stop $s >/dev/null 2>&1 || true

# One clip per step, from the captions given above.
awk -F'\t' -v n="$steps" 'BEGIN { printf "{\"clips\":[" }
  { gsub(/\\/, "\\\\", $1); gsub(/"/, "\\\"", $1)
    printf "%s{\"from\":\"s%d\",\"to\":\"%s\",\"caption\":\"%s\"%s}", (NR > 1 ? "," : ""), NR, (NR < n ? "s" NR + 1 : "end"), $1, ($2 != "" ? ",\"speed\":" $2 : "") }
  END { print "]}" }' "$out/steps.tsv" > "$edit"
termctrl video "$rec" --edit "$edit" --pixel-ratio 1 --fps "$FPS" --font-family "${FONT:-DejaVu Sans Mono}" --tail-ms 1000 --out "$mp4"
ffmpeg -v error -y -i "$mp4" -filter_complex \
  "fps=$FPS,scale=$WIDTH:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${COLORS:-128}:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  -loop 0 "$gif"
ls -l "$gif"
ffprobe -v error -show_entries format=duration:stream=width,height,nb_frames -of default=nw=1 "$gif"
