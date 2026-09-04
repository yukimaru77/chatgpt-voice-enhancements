#!/usr/bin/env bash
# Installs the complete Voice enhancement suite into a running ChatGPT Desktop
# main process: project routing, Voice launch on existing tasks, per-task worker
# selection and picker retention, inactivity tuning, and Voice-only microphone
# processing.
# The inspector is opened only for installation and is closed by the injector.
set -euo pipefail

APP_PATH="${CHATGPT_APP_PATH:-/Applications/ChatGPT.app}"
MAIN_INSPECT_PORT="${CHATGPT_MAIN_INSPECT_PORT:-9229}"
VOICE_WORKER_MODEL="${CHATGPT_VOICE_WORKER_MODEL:-selected}"
VOICE_WORKER_MODE="$(printf '%s' "$VOICE_WORKER_MODEL" | tr '[:upper:]' '[:lower:]')"
case "$VOICE_WORKER_MODE" in
  selected|inherit|composer)
    VOICE_WORKER_EFFORT="${CHATGPT_VOICE_WORKER_EFFORT:-selected}"
    ;;
  *)
    VOICE_WORKER_EFFORT="${CHATGPT_VOICE_WORKER_EFFORT:-high}"
    ;;
esac
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INJECTOR="$SCRIPT_DIR/inject-chatgpt-voice-enhancements.mjs"

export CHATGPT_VOICE_WORKER_MODEL="$VOICE_WORKER_MODEL"
export CHATGPT_VOICE_WORKER_EFFORT="$VOICE_WORKER_EFFORT"

if [[ ! -d "$APP_PATH" ]]; then
  echo "ChatGPT app not found at: $APP_PATH" >&2
  exit 1
fi

if [[ ! -f "$INJECTOR" ]]; then
  echo "Injector not found at: $INJECTOR" >&2
  exit 1
fi

node "$INJECTOR" "$MAIN_INSPECT_PORT" 30000 --validate-only

EXECUTABLE="$APP_PATH/Contents/MacOS/ChatGPT"
launched_with_inspector=0
main_pid="$(
  ps -axo pid=,command= |
    awk -v executable="$EXECUTABLE" '!found && $2 == executable { print $1; found = 1 }'
)"

if [[ -z "$main_pid" ]]; then
  echo "ChatGPT is not running; launching it with a temporary main-process inspector..."
  open -na "$APP_PATH" --args "--inspect=$MAIN_INSPECT_PORT"
  launched_with_inspector=1
  for _ in {1..200}; do
    main_pid="$(
      ps -axo pid=,command= |
        awk -v executable="$EXECUTABLE" '!found && $2 == executable { print $1; found = 1 }'
    )"
    [[ -n "$main_pid" ]] && break
    sleep 0.1
  done
  if [[ -z "$main_pid" ]]; then
    echo "ChatGPT did not start within 20 seconds." >&2
    exit 1
  fi
else
  echo "Using the running ChatGPT process ($main_pid); it will not be quit or restarted."
fi

if ! kill -0 "$main_pid" 2>/dev/null; then
  echo "ChatGPT process $main_pid exited before the override could be installed." >&2
  exit 1
fi

inspector_owner="$(
  lsof -nP -t -iTCP:"$MAIN_INSPECT_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
)"
if [[ -n "$inspector_owner" && "$inspector_owner" != "$main_pid" ]]; then
  echo "Inspector port $MAIN_INSPECT_PORT is already owned by PID $inspector_owner." >&2
  exit 1
fi

if [[ "$launched_with_inspector" -eq 1 ]]; then
  echo "Waiting for the temporary main-process inspector on port $MAIN_INSPECT_PORT..."
elif [[ "$inspector_owner" != "$main_pid" ]]; then
  echo "Opening a temporary main-process inspector on port $MAIN_INSPECT_PORT..."
  kill -USR1 "$main_pid"
fi

for _ in {1..100}; do
  if lsof -nP -a -p "$main_pid" -iTCP:"$MAIN_INSPECT_PORT" -sTCP:LISTEN \
    >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$main_pid" 2>/dev/null; then
    echo "ChatGPT exited while its temporary inspector was opening." >&2
    exit 1
  fi
  sleep 0.1
done

if ! lsof -nP -a -p "$main_pid" -iTCP:"$MAIN_INSPECT_PORT" -sTCP:LISTEN \
  >/dev/null 2>&1; then
  echo "ChatGPT did not open its temporary inspector on port $MAIN_INSPECT_PORT." >&2
  exit 1
fi

case "$VOICE_WORKER_MODE" in
  selected|inherit|composer)
    echo "Installing per-chat Voice worker selection from the new-chat composer..."
    ;;
  *)
    echo "Installing pinned Voice worker $VOICE_WORKER_MODEL ($VOICE_WORKER_EFFORT reasoning)..."
    ;;
esac
set +e
node "$INJECTOR" "$MAIN_INSPECT_PORT" 30000
injector_status=$?
set -e

# The injector normally closes the inspector itself. If compatibility checks
# fail before that cleanup is registered, close the temporary endpoint here.
if [[ "$injector_status" -ne 0 ]]; then
  node --input-type=module -e '
    const port = process.argv[1];
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find((item) => item.webSocketDebuggerUrl);
      if (target) {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve) => {
          socket.addEventListener("open", () => socket.send(JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression: "process._debugEnd(); true", returnByValue: true },
          })));
          socket.addEventListener("message", resolve);
          socket.addEventListener("close", resolve);
          socket.addEventListener("error", resolve);
          setTimeout(resolve, 2000);
        });
      }
    } catch {}
  ' "$MAIN_INSPECT_PORT"
  exit "$injector_status"
fi

for _ in {1..50}; do
  if ! lsof -nP -a -p "$main_pid" -iTCP:"$MAIN_INSPECT_PORT" -sTCP:LISTEN \
    >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if lsof -nP -a -p "$main_pid" -iTCP:"$MAIN_INSPECT_PORT" -sTCP:LISTEN \
  >/dev/null 2>&1; then
  echo "Voice override installed, but temporary inspector port $MAIN_INSPECT_PORT did not close." >&2
  exit 1
fi

echo "ChatGPT Voice enhancements are active in PID $main_pid; temporary inspector closed."
