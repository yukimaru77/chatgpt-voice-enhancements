# ChatGPT Desktop Voice enhancements

This package fixes project routing and unlocks the native controls and tools ChatGPT hides in Voice tasks. It also applies two Voice-only runtime tunings. It does not modify the signed app bundle.

| Capability | Change | Result |
| --- | --- | --- |
| Project-aware Voice launch | Fix | A Voice task started from a selected project keeps that project's ID, working directory, workspace roots, and assignment instead of moving to `Documents/Codex/.../realtime-voice-chat-*`. |
| Voice in any existing task | Unlock | An ordinary task that began with text can start and stop Voice later. ChatGPT attaches realtime Voice to the same thread ID instead of requiring a new Voice-first task. |
| Per-task worker inheritance | Unlock | A fresh Voice task uses the Codex worker model and reasoning effort currently selected in the project's new-chat composer. It is no longer globally pinned to Sol/high or forced to the Voice rollout's Terra/low default. |
| Model picker inside Voice | Unlock | ChatGPT's native model/reasoning picker stays mounted while Voice is active and after it stops. Changing it updates subsequent worker handoffs in that same Voice task. |
| Five-minute inactivity window | Tune | Voice inactivity always waits five minutes before auto-ending instead of following the rollout's age-dependent 5–60 second schedule. |
| Voice microphone processing | Tune | Realtime Voice capture requests Chromium `voiceIsolation`, `echoCancellation`, `noiseSuppression`, and `autoGainControl`. Native dictation is not changed. |
| Voice dynamic tools | Unlock | Fresh Voice tasks receive Appshots, `speak_to_user`, and `end_realtime_voice_call` through the native `realtimeVoiceDynamicTools` request field. |
| Voice over interrupted Resume | Fix | When an idle task is resumable and Voice is also available, the Voice control wins instead of being replaced by the triangular Resume button. |
| Live Voice transcript | Fix | The current Voice conversation appears above the composer as it happens: user speech as bubbles and ChatGPT speech as gray quoted text. |

This is not a Sol/high model injector. The default mode follows the model and reasoning effort selected for each task. Fixed-model pinning remains an optional compatibility mode.

## Compatibility status

- ChatGPT Desktop: `26.727.40816` build `6067`
- Locally verified compatibility: `26.831.21537` build `7579` (uses the app's native project routing, existing-thread Voice, model picker, and dynamic-tool paths; the local injector unlocks the existing-thread rollout gates and retains the request hook and Voice-specific runtime tunings)
- Bundled Codex: `0.146.0-alpha.9.2`
- Worker request hook: `chatgpt-voice-worker-request-v6`
- Project Voice context: `chatgpt-native-project-voice-context-v12`
- Native project/model breakpoints: `chatgpt-native-project-voice-breakpoints-v31`
- Runtime result: all six native-path breakpoints resolved in build `7579` on 2026-09-04. An existing text task completed a real Voice launch with live microphone and receive tracks, a connected WebRTC peer, and increasing inbound and outbound RTP packet counters.

An app update can change the minified exports or launch schema. Revalidate before assuming compatibility with a newer build.

## Requirements

- macOS with ChatGPT Desktop installed (default: `/Applications/ChatGPT.app`)
- Node.js 22 or newer (`fetch` and `WebSocket` must be available globally)
- `bash`, `lsof`, `ps`, `awk`, and `open`
- permission to signal the current user's ChatGPT process with `SIGUSR1`

No npm install is required. The patch does not edit or re-sign ChatGPT.

## Install and normal use

Download every file in this gist into the same directory, then make the installer executable:

```bash
chmod +x install-chatgpt-voice-enhancements.sh
```

Run once after ChatGPT starts:

```bash
./install-chatgpt-voice-enhancements.sh
```

The installer uses a running ChatGPT process when one exists; otherwise it launches ChatGPT with a temporary main-process inspector. It never quits or restarts an already-running app. It briefly uses port `9229`, installs the in-memory hooks, and closes the inspector.

After installation:

1. Open a new chat inside a project.
2. Select the model and reasoning effort in that composer.
3. Click Voice.
4. The new Voice task stays in the project and uses that selection.
5. Change the composer selection before starting another fresh Voice task; no script rerun is required.
6. While Voice is active, use the same model picker beside the speaker and microphone controls. A change updates the worker used by the next handoff; an already-running worker turn finishes on its original model.
7. An otherwise idle Voice task remains open for five minutes. Transcript and worker activity reset that timer.
8. New Voice microphone streams request `voiceIsolation`, `echoCancellation`, `noiseSuppression`, and `autoGainControl`; dictation streams are left unchanged.
9. While Voice is active, the recognized conversation remains visible above the composer and updates continuously. User speech uses a bubble; ChatGPT speech uses the same gray-quote treatment as finalized Voice history.

For a task that originally began with text, open the task and leave the composer empty while no response is running. The Voice button now appears. Starting Voice uses ChatGPT's native `composer_button_existing_thread` path and calls `thread/realtime/start` with that task's existing thread ID. Once the global Voice session accepts the handoff, the composer control changes from its loading ring to an enabled Stop button.

Run the installer again only after ChatGPT fully quits, restarts, crashes, or updates. The hooks are in memory and disappear with the ChatGPT process.

## Existing tasks

An ordinary text-first task can now enter Voice without being recreated or moved. An existing Voice task retains the model and reasoning effort it was created with. The retained native picker can update those thread settings without creating another task. The change applies to subsequent worker turns; it does not replace a worker response already in progress and does not change the GPT-Live audio model.

## Optional fixed-model mode

Providing a model explicitly restores the original pinning behavior:

```bash
CHATGPT_VOICE_WORKER_MODEL='gpt-5.6-sol' \
CHATGPT_VOICE_WORKER_EFFORT='xhigh' \
./install-chatgpt-voice-enhancements.sh
```

The model must exist in `${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json`, and the requested reasoning effort must be supported by that catalog entry. Override the catalog path with `CHATGPT_VOICE_MODEL_CATALOG`.

To return to per-chat selection, rerun the installer without those environment variables.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHATGPT_APP_PATH` | `/Applications/ChatGPT.app` | ChatGPT Desktop application bundle. |
| `CHATGPT_MAIN_INSPECT_PORT` | `9229` | Temporary Electron main-process inspector port. |
| `CHATGPT_PROJECT_VOICE_ROUTING` | enabled | Set to `0` to disable project routing, renderer audio/timer changes, and the retained Voice picker. |
| `CHATGPT_VOICE_WORKER_MODEL` | `selected` | `selected`, `inherit`, or `composer` follows the native composer. Any other value enables fixed-model mode. |
| `CHATGPT_VOICE_WORKER_EFFORT` | `selected` | Composer mode must use `selected`, `inherit`, or `composer`. Fixed-model mode defaults to `high`. |
| `CHATGPT_VOICE_MODEL_CATALOG` | `${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json` | Catalog used to validate a fixed model and effort. |
| `CHATGPT_VOICE_APPSHOTS` | enabled | Set to `0` to stop requesting Appshots for fresh Voice tasks. Availability still depends on the native Appshots capability check. |
| `CHATGPT_VOICE_END_CALL_TOOL` | enabled | Set to `0` to omit `end_realtime_voice_call` from fresh Voice tasks. |
| `CHATGPT_VOICE_SPEAK_TO_USER` | enabled | Set to `0` to omit `speak_to_user` from fresh Voice tasks. |
| `CODEX_HOME` | `$HOME/.codex` | Codex home used when deriving the default catalog path. |

## Runtime flow

### 1. Capture the selected project and worker

`chatgpt-voice-renderer-enhancements.js` reads the live React state when Voice is clicked:

- the selected project ID from the composer;
- the project's `cwd`, workspace roots, and project assignment from the sidebar row;
- the model and reasoning effort from the model-picker component carrying `data-selected-reasoning-effort`.

The model-picker match requires the same component to expose `model`, `reasoningEffort`, `onSelectModel`, and `onSelectReasoningEffort`. This avoids mistaking unrelated model-shaped props for the active composer picker.

### 2. Carry that context through the native Voice launch

The injector discovers the current minified functions by behavior and attaches conditional function-call/source breakpoints to:

- the Voice start request function, which captures project/composer state for `composer_button_new_thread`;
- the intent mapper, which carries that state into the avatar overlay;
- the request bridge, which adjusts `read-config-for-host` and Voice `start-conversation` before task creation.

It also installs one source-location breakpoint at the Voice-thread footer gate. ChatGPT normally suppresses all expanding footer controls whenever `realtimeSession.isVoiceThread` is true, including after the orb closes. The breakpoint keeps those native controls mounted only for Voice threads, which restores ChatGPT's existing picker and its existing `thread/settings/update` path. Ordinary threads are unchanged.

For `start-conversation`, the patch supplies:

- `cwd`
- `workspaceRoots`
- `workspaceKind: "project"`
- `projectAssignment`
- `skipFallbackConfigReadForProjectlessCwd: false`
- the selected worker settings
- `realtimeVoiceDynamicTools` enabling Appshots, `speak_to_user`, and `end_realtime_voice_call`

### 3. Write the worker selection at the correct boundary

The critical fields are:

```text
collaborationMode.settings.model
collaborationMode.settings.reasoning_effort
```

ChatGPT's Voice constructor derives the eventual Codex `thread/start` request from `collaborationMode`. Top-level `model` or `config.model_reasoning_effort` fields on `start-conversation` are ignored.

The separate main-process IPC hook observes only:

```text
method == "thread/start"
threadSource == "realtime_voice"
```

In the default `inherit` mode it leaves the resulting model and effort unchanged. In explicit pin mode it replaces them. Ordinary chats and `thread/resume` requests are untouched.

### 4. Change the worker inside an existing Voice task

The retained picker uses ChatGPT's native model catalog and `updateThreadSettingsForNextTurn()` implementation. That sends:

```text
thread/settings/update { threadId, model, effort }
```

The bundled Codex app server applies the update to subsequent turns without adding a transcript item or restarting the realtime session.

### 5. Start Voice in an ordinary existing task

ChatGPT already ships an existing-thread handler that calls:

```text
thread/realtime/start { threadId: conversationId, ... }
```

The app normally makes that handler available only when the thread is already classified as a Voice thread. The existing-task source breakpoints change the realtime-controls result so `isStartAvailable` and `isVoiceThread` enable the native button and handler. They also clear the main window's launch-pending state after the matching global Voice session takes ownership; this exposes the native Stop control instead of leaving a disabled loading ring. When ChatGPT marks an idle task as interrupted, Voice takes precedence over its Resume button because the Voice path already performs `maybe-resume-conversation`. New-chat behavior, text submission, and running turns are unchanged.

### 6. Keep the Voice conversation visible while it is active

The app server already emits `thread/realtime/transcript/delta` and `thread/realtime/transcript/done` for both sides of an active Voice conversation, but ChatGPT normally adds the gray Voice transcript to the task only after the session ends. The transcript breakpoint mirrors those existing notifications into a display-only panel above the composer. It accumulates the current session while Voice is active, does not send messages or write synthetic history, and disappears after ChatGPT's normal finalized transcript takes over.

## Why earlier versions failed

1. The original implementation pinned every fresh Voice task to one environment-selected model. It worked but required reinstalling the configuration whenever the desired model changed.
2. The first inheritance attempt stopped rewriting `thread/start`. That exposed ChatGPT's Voice rollout default, `gpt-5.6-terra/low`, because the visible composer picker was not wired into the Voice constructor.
3. Breakpoint version 2 correctly captured the composer selection but wrote top-level `model` and `config` fields into `start-conversation`. The request accepted those mutations but ignored them, so the final worker remained Terra/low.
4. Breakpoint version 3 writes the selection into `collaborationMode.settings`, matching ChatGPT's native `mas()` merge before conversation creation. This is the proven working implementation.

## Verification

Run the deterministic checks without touching ChatGPT:

```bash
env -u CHATGPT_VOICE_WORKER_MODEL \
  -u CHATGPT_VOICE_WORKER_EFFORT \
  node ./inject-chatgpt-voice-enhancements.mjs \
  9229 30000 --self-test
```

The checks prove:

- ordinary task starts remain unchanged;
- a cold-start install waits for both ChatGPT Voice windows to finish loading;
- Voice resumes remain unchanged;
- per-chat mode preserves the Voice request produced from the composer selection;
- explicit pin mode replaces only fresh Voice starts;
- the selected project, roots, assignment, model, and reasoning survive the native handoff;
- unrelated collaboration settings remain intact.
- ordinary timers retain their original delays while Voice auto-end timers use `300000` ms.
- Voice capture receives the four processing constraints while non-Voice `getUserMedia` calls remain unchanged.
- the selected project is retained across the updated renderer's click-time composer teardown.
- fresh Voice starts receive the three requested `realtimeVoiceDynamicTools` fields without changing ordinary task starts.
- the current minified compact-composer gate is uniquely identified before the native Voice picker breakpoint is installed.
- the Voice-thread footer gate is uniquely identified and disabled only when `realtimeSession.isVoiceThread` is true.
- the existing-thread Voice gate is uniquely identified, enabled only when a conversation ID exists, and clears launch-pending only after the matching global session is available, while leaving new-chat behavior unchanged.
- an existing-thread start callback cached before installation is enabled when invoked, while a new-thread start remains unchanged.
- the native realtime notification dispatcher is uniquely identified and forwards only accepted Voice transcript/lifecycle notifications.
- successive transcript deltas accumulate by speaker, final text replaces partial recognition, and closing the session leaves ChatGPT's ordinary history path authoritative.

Self-tests are necessary but not sufficient after an app update. Final verification is one fresh Voice launch followed by checking that the task stayed in the selected project and that the provider received the selected model and reasoning effort.

## Scope and limitations

- This changes the Codex worker used by Voice, not the GPT-Live audio model.
- It does not change native dictation or its transcription service.
- Dynamic composer inheritance is implemented for fresh Voice tasks launched from a selected project. A projectless Voice launch continues to use ChatGPT's own Voice defaults unless explicit pin mode is active.
- The patch depends on current minified export names and React state shape.
- The active Voice picker changes the Codex worker for subsequent handoffs, not a worker turn already in progress.
- The existing-task Voice button appears only while the composer is empty and the task is not producing a response, matching ChatGPT's native action-control rules.
- The live transcript is display-only; finalized Voice messages remain owned by ChatGPT's normal transcript and handoff flow.
- Nothing is written into `/Applications/ChatGPT.app`; all runtime modifications disappear when ChatGPT exits.

## Package contents

- `install-chatgpt-voice-enhancements.sh` (required): validates configuration, finds or launches ChatGPT, opens the temporary inspector, invokes the injector, and verifies inspector shutdown.
- `inject-chatgpt-voice-enhancements.mjs` (required): installs the IPC hook and native Voice breakpoints; also contains deterministic self-tests.
- `chatgpt-voice-renderer-enhancements.js` (required): resolves project/composer state, applies the Voice-only timeout and microphone constraints, and renders the display-only live transcript.
- `diagnose-chatgpt-voice-enhancements.mjs` (optional): reports runtime state. Its mutation flags are development tools, not part of normal installation.

The installer is not a self-contained single file. Keep the installer and its two required JavaScript files together. The diagnostic file can be omitted for normal use.

## Diagnostics

With a ChatGPT inspector already open on port `9229`, print the current patch state:

```bash
node ./diagnose-chatgpt-voice-enhancements.mjs 9229
```

Assert that the existing-task Voice breakpoint is installed:

```bash
node ./diagnose-chatgpt-voice-enhancements.mjs 9229 --assert-existing-thread-voice
```

The diagnostic flags `--install-capture`, `--dispose-project-routing`, and `--inject-css` change the current in-memory runtime. They are intentionally excluded from the normal workflow.

## Security and distribution

This code has no embedded credentials or user-specific paths. It talks only to a loopback inspector endpoint and the local ChatGPT process. A GitHub “secret gist” is unlisted, not access-controlled: anyone with its URL can read it.
