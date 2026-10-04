#!/bin/sh
# Records e2e/out/demo.gif: the real faplex on `laptop`, driven with keys, against the rig's real
# harnesses and fake model API. Brings the rig up fresh and tears it down afterwards (KEEP_RIG=1
# leaves it up). Needs docker, termctrl and ffmpeg. Run from anywhere.
#
# State changes are waited for, never slept for; the sleeps below only give the viewer time to
# read a screen. The keys pressed are shown as captions, one per clip of the edit plan.
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

termctrl start $s --host opentui --cols "$COLS" --rows "$ROWS" --record "$rec" -- "$here/faplex.sh"
see "Migrate cron jobs to systemd timers"; see "Clean up stale build artifacts"; see "Bump lodash to 4.17.21"
see "Working 1"; see "Needs input 1"; see "Finished 1"
sleep 0.5

# The starting list: one session per machine.
mark list
sleep 0.9

# 1. A new Codex session on laptop; once prompted it is a Working row.
mark n1
key text:n; see "New session"
sleep 0.35; key right; sleep 0.25; key right; sleep 0.4
key enter
see "Ask Codex"
sleep 0.3
mark type1
key --pace-ms "$PACE" "text:make a cool demo of this project"
sleep 0.25
key enter
see "narrated video"
sleep 0.7
mark back1
back
see "Working 2"; see "Make a cool demo of this project"
sleep 0.6

# 2. A new OpenCode session on devbox, on the (mocked) DeepSeek 4.1 model.
mark n2
key text:n; see "New session"
sleep 0.35; key down; sleep 0.25; key right; sleep 0.4
key enter
see "Ask anything"; see "DeepSeek 4.1"
sleep 0.5
mark type2
key --pace-ms "$PACE" "text:write release notes for v0.2"
sleep 0.25
key enter
see "Collecting the commits"
sleep 0.7
mark back2
back
see "Working 3"; see "Write release notes for v0.2"
sleep 0.6

# 3. The Claude session that needs input: open it, answer in Claude Code's own prompt, come back.
mark open3
key down; sleep 0.5
key right
see "Do you want to proceed?"
sleep 1.2          # reading time, and lets the dialog settle: a key sent the instant a prompt renders can be dropped
mark approve
key text:1
see "build/ deleted and recreated"
sleep 0.9
mark back3
back
see "Finished 2"
see "build/ cleared and recreated"
sleep 0.9

# 4. Steer the Codex session while it is still working. Codex holds a message typed mid-turn
#    until the next tool call; esc interrupts the model and sends it at once.
mark open4
key up; sleep 0.25; key up; sleep 0.4
key right
see "narrated video"
sleep 0.6
mark steer
key --pace-ms "$PACE" "text:keep it under 20 seconds and make it a GIF"
sleep 0.25
key enter
see "Messages to be submitted"
sleep 0.9
mark esc
key escape
see "Got it: a GIF"
sleep 1.1
mark back4
back
see "Working 3"
sleep 1.1
mark end

key text:q
sleep 1
termctrl stop $s >/dev/null 2>&1 || true

# One clip per step; the caption names the keys pressed in it. The one stretch with nothing to
# read (Claude's status line takes a moment to arrive after the turn) is sped up; harness startup
# and ssh connects are already under a second on the rig.
cat > "$edit" <<'EOF'
{"clips":[
  {"from":"list","to":"n1","caption":"faplex · agent sessions on 3 machines, over ssh"},
  {"from":"n1","to":"type1","caption":"n new session · → → codex on laptop · ⏎"},
  {"from":"type1","to":"back1","caption":"type a prompt · ⏎"},
  {"from":"back1","to":"n2","caption":"ctrl+] back"},
  {"from":"n2","to":"type2","caption":"n new session · ↓ → opencode on devbox · ⏎"},
  {"from":"type2","to":"back2","caption":"type a prompt · ⏎"},
  {"from":"back2","to":"open3","caption":"ctrl+] back"},
  {"from":"open3","to":"approve","caption":"↓ · → open the session that needs input"},
  {"from":"approve","to":"back3","caption":"1 · approve in Claude Code's own prompt"},
  {"from":"back3","to":"open4","caption":"ctrl+] back","speed":1.6},
  {"from":"open4","to":"steer","caption":"↑ ↑ · → open the working Codex session"},
  {"from":"steer","to":"esc","caption":"type a follow-up · ⏎"},
  {"from":"esc","to":"back4","caption":"esc · interrupt and send it now"},
  {"from":"back4","to":"end","caption":"ctrl+] back"}
]}
EOF
termctrl video "$rec" --edit "$edit" --pixel-ratio 1 --fps "$FPS" --font-family "${FONT:-DejaVu Sans Mono}" --tail-ms 1000 --out "$mp4"
ffmpeg -v error -y -i "$mp4" -filter_complex \
  "fps=$FPS,scale=$WIDTH:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${COLORS:-128}:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  -loop 0 "$gif"
ls -l "$gif"
ffprobe -v error -show_entries format=duration:stream=width,height,nb_frames -of default=nw=1 "$gif"
