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
release() { "$here/x" laptop "curl -fsS -X POST 'fakeapi:8080/_control/release?key=$1'" >/dev/null; }

termctrl start $s --host opentui --cols "$COLS" --rows "$ROWS" --record "$rec" -- "$here/faplex.sh"
see "Document the backup script"; see "Bump the terraform provider"; see "Tidy the landing page copy"
see "Working 3"; see "Needs input 3"; see "Finished 3"
sleep 0.5

# 1. The seeded list; move down it.
mark list
sleep 1.8
mark down
key down; sleep 0.6; key down; sleep 1.2

# 2. One held model stream is released, so one Working session finishes while we watch.
mark finish
release flaky
see "Finished 4"
see "flaky test fixed"
sleep 2.2

# 3. A session that needs input: open it, approve in the harness's own UI, come back.
mark toneeds
key down; sleep 1.4
mark open
key right
see "Do you want to proceed?"
sleep 2.4          # also lets the dialog settle; a key sent the instant a prompt renders can be dropped
mark approve
key text:1
see "The stale files are gone"
sleep 2
mark back1
back
see "Needs input 2"
sleep 2.2

# 4. A new OpenCode session on devbox; once prompted it is a Working row.
mark new
key text:n
see "New session"
sleep 1
mark pick
key down; sleep 0.6; key right; sleep 1
mark create
key enter
see "Ask anything"
sleep 1
mark prompt
key --pace-ms 55 "text:add a /healthz endpoint with a test"
sleep 0.5
key enter
see "Planning the change"
sleep 1.6
mark back2
back
see "Working 3"
see "add a /healthz endpoint"
sleep 2.6
mark end

key text:q
sleep 1
termctrl stop $s >/dev/null 2>&1 || true

# One clip per step; the caption names the keys pressed in it (or says that none were).
cat > "$edit" <<'EOF'
{"clips":[
  {"from":"list","to":"down","caption":"faplex · 3 machines over ssh · Claude Code, Codex, OpenCode"},
  {"from":"down","to":"finish","caption":"↓ ↓"},
  {"from":"finish","to":"toneeds","caption":"(no key) a session finishes on its own"},
  {"from":"toneeds","to":"open","caption":"↓"},
  {"from":"open","to":"approve","caption":"→ open · claude attach on pi"},
  {"from":"approve","to":"back1","caption":"1 · approve in Claude Code's own prompt"},
  {"from":"back1","to":"new","caption":"ctrl+] back"},
  {"from":"new","to":"pick","caption":"n new session"},
  {"from":"pick","to":"create","caption":"↓ → · devbox, opencode"},
  {"from":"create","to":"prompt","caption":"⏎ open"},
  {"from":"prompt","to":"back2","caption":"type a prompt · ⏎"},
  {"from":"back2","to":"end","caption":"ctrl+] back"}
]}
EOF
termctrl video "$rec" --edit "$edit" --pixel-ratio 1 --fps "$FPS" --font-family "${FONT:-DejaVu Sans Mono}" --tail-ms 1500 --out "$mp4"
ffmpeg -v error -y -i "$mp4" -filter_complex \
  "fps=$FPS,scale=$WIDTH:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${COLORS:-128}:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  -loop 0 "$gif"
ls -l "$gif"
ffprobe -v error -show_entries format=duration:stream=width,height,nb_frames -of default=nw=1 "$gif"
