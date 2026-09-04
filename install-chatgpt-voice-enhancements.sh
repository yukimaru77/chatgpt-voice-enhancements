#!/usr/bin/env bash
# Installs the complete Voice enhancement suite into ChatGPT Desktop: project
# routing, Voice launch on existing tasks, per-task worker selection and picker
# retention, inactivity tuning, and Voice-only microphone processing.
set -euo pipefail

APP_PATH="${CHATGPT_APP_PATH:-/Applications/ChatGPT.app}"
MAIN_INSPECT_PORT="${CHATGPT_MAIN_INSPECT_PORT:-9229}"
STARTUP_TIMEOUT_MS="${CHATGPT_STARTUP_TIMEOUT_MS:-90000}"
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
restart_for_install=0

if [[ "${1:-}" == "--restart" ]]; then
  restart_for_install=1
  shift
fi
if [[ "$#" -ne 0 ]]; then
  echo "Usage: $0 [--restart]" >&2
  exit 2
fi
if [[ ! "$STARTUP_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]]; then
  echo "CHATGPT_STARTUP_TIMEOUT_MS must be a positive integer." >&2
  exit 2
fi

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

EXECUTABLE="$APP_PATH/Contents/MacOS/ChatGPT"
APP_BUILD="$(
  /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' \
    "$APP_PATH/Contents/Info.plist" 2>/dev/null || true
)"
debug_transport="renderer-cdp"
if [[ "$APP_BUILD" =~ ^[0-9]+$ ]] && (( APP_BUILD < 7746 )); then
  debug_transport="main-inspector"
fi
if [[ "$debug_transport" == "renderer-cdp" ]]; then
  case "$VOICE_WORKER_MODE" in
    selected|inherit|composer) ;;
    *)
      echo "Fixed-model mode is unavailable on this protected ChatGPT build; use the default composer-selected mode." >&2
      exit 2
      ;;
  esac
  if [[ "${CHATGPT_PROJECT_VOICE_ROUTING:-1}" == "0" ]]; then
    echo "CHATGPT_PROJECT_VOICE_ROUTING=0 is unavailable on this protected ChatGPT build." >&2
    exit 2
  fi
fi

node "$INJECTOR" "$MAIN_INSPECT_PORT" "$STARTUP_TIMEOUT_MS" --validate-only

launched_with_debug_endpoint=0
find_main_pid() {
  ps -axo pid=,command= |
    awk -v executable="$EXECUTABLE" '!found && $2 == executable { print $1; found = 1 }'
}
main_pid="$(find_main_pid)"

inspector_owner="$(
  lsof -nP -t -iTCP:"$MAIN_INSPECT_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
)"
main_owns_inspector=0
if [[ -n "$main_pid" ]] &&
  lsof -nP -a -p "$main_pid" -iTCP:"$MAIN_INSPECT_PORT" -sTCP:LISTEN \
    >/dev/null 2>&1; then
  main_owns_inspector=1
fi
if [[ -n "$inspector_owner" && "$main_owns_inspector" -ne 1 ]]; then
  echo "Inspector port $MAIN_INSPECT_PORT is already owned by PID $inspector_owner." >&2
  exit 1
fi

if [[ -n "$main_pid" && "$main_owns_inspector" -ne 1 ]]; then
  if [[ "$restart_for_install" -ne 1 ]]; then
    echo "ChatGPT is running without its local debugger." >&2
    echo "This app build cannot safely open the inspector while running." >&2
    echo "Quit ChatGPT and rerun this command, or explicitly allow a graceful restart:" >&2
    echo "  $0 --restart" >&2
    exit 2
  fi

  echo "Gracefully restarting ChatGPT so the Voice enhancements can be installed..."
  osascript -e 'tell application id "com.openai.codex" to quit'
  for _ in {1..200}; do
    [[ -z "$(find_main_pid)" ]] && break
    sleep 0.1
  done
  main_pid="$(find_main_pid)"
  if [[ -n "$main_pid" ]]; then
    echo "ChatGPT did not quit within 20 seconds; it was not force-terminated." >&2
    exit 1
  fi
  inspector_owner=""
  main_owns_inspector=0
fi

if [[ -z "$main_pid" ]]; then
  if [[ "$debug_transport" == "renderer-cdp" ]]; then
    echo "ChatGPT is not running; launching it with the local renderer debugger..."
    open -na "$APP_PATH" --args \
      "--remote-debugging-address=127.0.0.1" \
      "--remote-debugging-port=$MAIN_INSPECT_PORT"
  else
    echo "ChatGPT is not running; launching it with a temporary main-process inspector..."
    open -na "$APP_PATH" --args "--inspect=$MAIN_INSPECT_PORT"
  fi
  launched_with_debug_endpoint=1
  for _ in {1..200}; do
    main_pid="$(find_main_pid)"
    [[ -n "$main_pid" ]] && break
    sleep 0.1
  done
  if [[ -z "$main_pid" ]]; then
    echo "ChatGPT did not start within 20 seconds." >&2
    exit 1
  fi
else
  echo "Using ChatGPT process $main_pid, which already has its local debugger open."
fi

if ! kill -0 "$main_pid" 2>/dev/null; then
  echo "ChatGPT process $main_pid exited before the override could be installed." >&2
  exit 1
fi

if [[ "$launched_with_debug_endpoint" -eq 1 ]]; then
  echo "Waiting for the local debugger on port $MAIN_INSPECT_PORT..."
fi

for _ in {1..100}; do
  if lsof -nP -a -p "$main_pid" -iTCP:"$MAIN_INSPECT_PORT" -sTCP:LISTEN \
    >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$main_pid" 2>/dev/null; then
    echo "ChatGPT exited while its local debugger was opening." >&2
    exit 1
  fi
  sleep 0.1
done

if ! lsof -nP -a -p "$main_pid" -iTCP:"$MAIN_INSPECT_PORT" -sTCP:LISTEN \
  >/dev/null 2>&1; then
  echo "ChatGPT did not open its local debugger on port $MAIN_INSPECT_PORT." >&2
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
node "$INJECTOR" "$MAIN_INSPECT_PORT" "$STARTUP_TIMEOUT_MS"
injector_status=$?
set -e

if [[ "$injector_status" -ne 0 ]]; then
  if [[ "$debug_transport" == "main-inspector" ]]; then
    # shellcheck disable=SC2016
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
  fi
  exit "$injector_status"
fi

if [[ "$debug_transport" == "renderer-cdp" ]]; then
  if ! lsof -nP -a -p "$main_pid" -iTCP:"$MAIN_INSPECT_PORT" -sTCP:LISTEN \
    >/dev/null 2>&1; then
    echo "Voice enhancements installed, but the renderer debugger did not remain open." >&2
    exit 1
  fi
  echo "ChatGPT Voice enhancements are active in PID $main_pid; the loopback renderer debugger remains open until ChatGPT exits."
else
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
fi
