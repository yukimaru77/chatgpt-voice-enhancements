# ChatGPT Desktop Voice enhancements

This package fixes project routing and unlocks the native controls and tools ChatGPT hides in Voice tasks. It also applies two Voice-only runtime tunings. It does not modify the signed app bundle.

The default `single-backend` policy now routes everything beyond simple social acknowledgments to the current Codex thread, asks that thread to do all work without delegation, and instructs the voice model to convey the full backend answer with only minimal adjustments for natural speech. Runtime prompts are in English. This is a prompt policy, not a hard tool sandbox.

**[日本語：目的 → Codex app のバージョンと構造 → 変更内容 → 実音声テスト](docs/single-backend-voice-ja.md)**

| Capability | Change | Result |
| --- | --- | --- |
| Single-backend, faithful speech | Policy | Same-thread work; no independent substantive voice answers, summaries, or worker delegation. Opt out with `CHATGPT_VOICE_POLICY=native`. |
| Project-aware Voice launch | Fix | A Voice task started from a selected project keeps that project's ID, working directory, workspace roots, and assignment instead of moving to `Documents/Codex/.../realtime-voice-chat-*`. |
| Voice in any existing task | Unlock | An ordinary task that began with text can start and stop Voice later. ChatGPT attaches realtime Voice to the same thread ID instead of requiring a new Voice-first task. |
| Per-task worker inheritance | Unlock | A fresh Voice task uses the Codex worker model and reasoning effort currently selected in the project's new-chat composer. It is no longer globally pinned to Sol/high or forced to the Voice rollout's Terra/low default. |
| Model picker inside Voice | Unlock | ChatGPT's native model/reasoning picker stays mounted while Voice is active and after it stops. Changing it updates subsequent worker handoffs in that same Voice task. |
| Five-minute inactivity window | Tune | Voice inactivity always waits five minutes before auto-ending instead of following the rollout's age-dependent 5–60 second schedule. |
| Voice microphone processing | Tune | Realtime Voice capture requests Chromium `voiceIsolation`, `echoCancellation`, `noiseSuppression`, and `autoGainControl`. Native dictation is not changed. |
| Voice dynamic tools | Unlock | Fresh Voice tasks receive Appshots, `speak_to_user`, and `end_realtime_voice_call` through the native `realtimeVoiceDynamicTools` request field. |
| Voice over interrupted Resume | Fix | When an idle task is resumable and Voice is also available, the Voice control wins instead of being replaced by the triangular Resume button. |
| Live Voice transcript | Fix | The current Voice conversation appears above the composer as it happens: user speech as bubbles and ChatGPT speech as gray quoted text. |

This is not a Sol/high model injector. The default mode follows the model and reasoning effort selected for each task. Fixed-model pinning remains an optional legacy-build compatibility mode.

## Compatibility status

- Current inspected and voice-tested ChatGPT Desktop: `26.908.40834` build `8881`
- Current bundled Codex: `0.154.0-alpha.6.2`
- Previously verified ChatGPT Desktop: `26.901.22334` build `7746`, bundled Codex `0.153.0`
- Legacy verified ChatGPT Desktop: `26.831.21537` build `7579`
- Worker request hook: `chatgpt-voice-worker-request-v6`
- Project Voice context: `chatgpt-native-project-voice-context-v12`
- Native project/model/policy breakpoints: `chatgpt-native-project-voice-breakpoints-v34`
- Voice policy tests on 2026-09-13: two synthesized WAV inputs, including one after a full app restart, passed through the actual app microphone/WebRTC path into the same existing text thread. Both backend turns read a local file and retained the session marker. The first final response matched the voice transcript after removal of the control prefix and whitespace; the second differed by one Japanese grammatical particle, without changing content. See the [Japanese report](docs/single-backend-voice-ja.md) for evidence and limitations.
- Runtime result on 2026-09-04: an existing text task completed two real Voice start/stop cycles on build `7746`; ChatGPT logged successful `thread/realtime/start` and `thread/realtime/stop` calls for the same thread, including a connected GPT-Live WebRTC sideband. The user also confirmed working Voice input in the app.

Build `7746` disables Electron's main-process inspector flags. This package therefore uses the app's loopback renderer debugger and one app-lifetime helper process on current builds. Build `7579` continues to use the older temporary main-process inspector path.

An app update can change the minified exports or launch schema. Revalidate before assuming compatibility with a newer build.

## Requirements

- macOS with ChatGPT Desktop installed (default: `/Applications/ChatGPT.app`)
- Node.js 22 or newer (`fetch` and `WebSocket` must be available globally)
- `bash`, `lsof`, `ps`, `awk`, `open`, and `osascript`

No npm install is required. The patch does not edit or re-sign ChatGPT.

## Install and normal use

Clone the repository, then make the installer executable:

```bash
git clone https://github.com/yukimaru77/chatgpt-voice-enhancements.git
cd chatgpt-voice-enhancements
chmod +x install-chatgpt-voice-enhancements.sh
```

If ChatGPT is closed, run:

```bash
./install-chatgpt-voice-enhancements.sh
```

If ChatGPT is already open normally, run:

```bash
./install-chatgpt-voice-enhancements.sh --restart
```

`--restart` asks macOS to quit ChatGPT gracefully and then launches it with the local debugger needed by this package. It never force-terminates the app and never sends `SIGUSR1`. Without `--restart`, an already-running app that lacks the debugger is left untouched and the installer prints the command to use.

On current builds, the debugger listens only on `127.0.0.1:9229`. One detached Node helper keeps the in-memory breakpoints active and automatically follows the Voice overlay when it is created, closed, or recreated. Both the debugger and helper end with ChatGPT. Running the installer again while they are active reuses the same helper instead of installing duplicates.

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

Run the installer again after ChatGPT fully quits, restarts, crashes, or updates. The hooks are in memory and disappear with the ChatGPT process.

## Existing tasks

An ordinary text-first task can now enter Voice without being recreated or moved. An existing Voice task retains the model and reasoning effort it was created with. The retained native picker can update those thread settings without creating another task. The change applies to subsequent worker turns; it does not replace a worker response already in progress and does not change the GPT-Live audio model.

## Optional fixed-model mode

Current protected builds (`7746` and newer) support the default composer-selected mode only. Explicit fixed-model pinning requires the legacy main-process inspector and is therefore available only on older compatible builds.

On a legacy build, providing a model explicitly restores the original pinning behavior:

```bash
CHATGPT_VOICE_WORKER_MODEL='gpt-5.6-sol' \
CHATGPT_VOICE_WORKER_EFFORT='xhigh' \
./install-chatgpt-voice-enhancements.sh
```

The model must exist in `${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json`, and the requested reasoning effort must be supported by that catalog entry. Override the catalog path with `CHATGPT_VOICE_MODEL_CATALOG`.

To return to per-chat selection, rerun the installer without those environment variables. On a current build the installer rejects fixed-model configuration with a clear error instead of silently ignoring it.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHATGPT_VOICE_POLICY` | `single-backend` | English same-thread work and faithful-speech instructions. `native` disables these new prompt overrides. |
| `CHATGPT_APP_PATH` | `/Applications/ChatGPT.app` | ChatGPT Desktop application bundle. |
| `CHATGPT_MAIN_INSPECT_PORT` | `9229` | Loopback renderer debugger port on current builds; temporary main-process inspector port on legacy builds. |
| `CHATGPT_STARTUP_TIMEOUT_MS` | `90000` | Maximum time to wait for ChatGPT and its renderer to become ready. |
| `CHATGPT_PROJECT_VOICE_ROUTING` | enabled | Legacy builds may set this to `0` to disable project routing and renderer changes. Current protected builds require it enabled. |
| `CHATGPT_VOICE_WORKER_MODEL` | `selected` | `selected`, `inherit`, or `composer` follows the native composer. Other values enable fixed-model mode on legacy builds only. |
| `CHATGPT_VOICE_WORKER_EFFORT` | `selected` | Composer mode must use `selected`, `inherit`, or `composer`. Fixed-model mode defaults to `high`. |
| `CHATGPT_VOICE_MODEL_CATALOG` | `${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json` | Catalog used to validate a fixed model and effort. |
| `CHATGPT_VOICE_APPSHOTS` | enabled | Set to `0` to stop requesting Appshots for fresh Voice tasks. Availability still depends on the native Appshots capability check. |
| `CHATGPT_VOICE_END_CALL_TOOL` | enabled | Set to `0` to omit `end_realtime_voice_call` from fresh Voice tasks. |
| `CHATGPT_VOICE_SPEAK_TO_USER` | enabled | Set to `0` to omit `speak_to_user` from fresh Voice tasks. |
| `CODEX_HOME` | `$HOME/.codex` | Codex home used when deriving the default catalog path. |

## Runtime flow

### 1. Attach to current protected builds

Build `7746` already contains native project routing, composer-selected worker settings, the Voice model picker, and the existing-thread start path. The rollout treatment keeps part of that path disabled. The injector reads the loaded `app-initial` source inside the renderer, identifies exactly one native Voice coordinator and one realtime transcript dispatcher, and rejects the build if those signatures are ambiguous.

The app-lifetime helper holds coordinator and Voice-session policy breakpoints in the main window. While the avatar overlay exists, it holds those plus the transcript breakpoint there, for five total. With `CHATGPT_VOICE_POLICY=native`, the original counts are one in the main window and three in total. New targets are not startup-paused, because that can deadlock Electron overlay initialization. Single-backend installation waits for both app windows and their hooks; start Voice after installation succeeds. Closing and recreating the overlay is supported.

At the coordinator boundary the patch enables `existingThreadVoiceEnabled` and merges the requested `realtimeVoiceDynamicTools`. The single-backend policy also replaces new-Voice worker-orchestration instructions and disables the new-task voice-transfer flag. At the session boundary it replaces `prompt`, `realtimeStartInstructions`, and `realtimeEndInstructions` before either call-ownership transport consumes them. It does not replace the selected project, model, reasoning effort, or unrelated treatment fields.

### 2. Preserve project and worker selection

The current app's native Voice coordinator carries `projectId`, working directory, workspace roots, collaboration mode, and treatment settings into the Voice task. The default package mode leaves the resulting model and reasoning effort unchanged, so each fresh Voice task follows its new-chat composer.

On legacy build `7579`, the older six-breakpoint/main-process path captures those values from the composer and writes worker selection at the effective boundary:

```text
collaborationMode.settings.model
collaborationMode.settings.reasoning_effort
```

Top-level `model` or `config.model_reasoning_effort` fields on `start-conversation` do not control the eventual Voice worker. The legacy optional fixed-model hook therefore limits its rewrite to `thread/start` requests whose `threadSource` is `realtime_voice`; ordinary chats and resumes remain untouched.

### 3. Change the worker inside an existing Voice task

The retained picker uses ChatGPT's native model catalog and `updateThreadSettingsForNextTurn()` implementation. That sends:

```text
thread/settings/update { threadId, model, effort }
```

The bundled Codex app server applies the update to subsequent turns without adding a transcript item or restarting the realtime session.

### 4. Start Voice in an ordinary existing task

ChatGPT already ships an existing-thread handler that calls:

```text
thread/realtime/start { threadId: conversationId, ... }
```

On current builds the coordinator treatment breakpoint makes that native handler available for ordinary existing tasks. On legacy builds, the existing-task source breakpoints change the realtime-controls result and clear the matching launch-pending state after the global Voice session takes ownership. In both cases the composer exposes ChatGPT's native Stop control instead of remaining a disabled loading ring. New-chat behavior, text submission, and running turns are unchanged.

### 5. Apply renderer-only Voice behavior

`chatgpt-voice-renderer-enhancements.js` changes only realtime Voice behavior: the five-minute inactivity timeout, the four microphone-processing constraints, and the live display-only transcript. The app server already emits `thread/realtime/transcript/delta` and `thread/realtime/transcript/done` for both speakers. The transcript breakpoint mirrors those notifications into a panel above the composer without sending messages or writing synthetic history. The panel disappears after ChatGPT's normal finalized transcript takes over.

## Why earlier versions failed

1. The original implementation pinned every fresh Voice task to one environment-selected model. It worked but required reinstalling the configuration whenever the desired model changed.
2. The first inheritance attempt stopped rewriting `thread/start`. That exposed ChatGPT's Voice rollout default, `gpt-5.6-terra/low`, because the visible composer picker was not wired into the Voice constructor.
3. Breakpoint version 2 correctly captured the composer selection but wrote top-level `model` and `config` fields into `start-conversation`. The request accepted those mutations but ignored them, so the final worker remained Terra/low.
4. Breakpoint version 3 writes the selection into `collaborationMode.settings`, matching ChatGPT's native `mas()` merge before conversation creation. This is the proven working implementation.
5. Build `7746` disables Electron's Node inspector arguments, and sending `SIGUSR1` exits the app instead of opening an inspector. Version 32 selects the loopback renderer debugger for that build and never signals the app.

## Verification

Run the deterministic checks without touching ChatGPT:

```bash
node --test voice-policy.test.mjs
node ./inject-chatgpt-voice-enhancements.mjs 9229 30000 --check-app-compatibility
env -u CHATGPT_VOICE_WORKER_MODEL \
  -u CHATGPT_VOICE_WORKER_EFFORT \
  node ./inject-chatgpt-voice-enhancements.mjs \
  9229 30000 --self-test
```

The checks prove:

- ordinary task starts remain unchanged;
- the legacy cold-start path waits for both ChatGPT Voice windows to finish loading;
- Voice resumes remain unchanged;
- per-chat mode preserves the Voice request produced from the composer selection;
- explicit pin mode replaces only fresh Voice starts;
- the selected project, roots, assignment, model, and reasoning survive the native handoff;
- unrelated collaboration settings remain intact;
- ordinary timers retain their original delays while Voice auto-end timers use `300000` ms;
- Voice capture receives the four processing constraints while non-Voice `getUserMedia` calls remain unchanged;
- the selected project is retained across the updated renderer's click-time composer teardown;
- fresh Voice starts receive the three requested `realtimeVoiceDynamicTools` fields without changing ordinary task starts;
- the current protected build's native routing guard, coordinator, and transcript dispatcher are found exactly once without copying the full app bundle across the debugger connection;
- the legacy compact-composer, footer, existing-thread, and interrupted-resume gates are identified uniquely;
- an existing-thread start callback cached before installation is enabled when invoked, while a new-thread start remains unchanged;
- the native realtime notification dispatcher forwards only accepted Voice transcript/lifecycle notifications;
- successive transcript deltas accumulate by speaker, final text replaces partial recognition, and closing the session leaves ChatGPT's ordinary history path authoritative.

For an installed current build, the read-only runtime assertion is:

```bash
node ./diagnose-chatgpt-voice-enhancements.mjs \
  9229 --assert-existing-thread-voice
node ./diagnose-chatgpt-voice-enhancements.mjs \
  9229 --assert-voice-policy
```

Self-tests are necessary but not sufficient after an app update. Final verification is one real Voice start/stop cycle in an existing text task, including visible live transcript and an enabled Stop control. That verification passed on build `7746` on 2026-09-04.

## Scope and limitations

- This changes the Codex worker used by Voice, not the GPT-Live audio model.
- The new routing and no-summary requirements are model instructions, not guaranteed semantic enforcement. Existing CLI subagent tools are not removed. The transfer flag controls newly created Voice tasks, not tools already registered on an existing thread.
- Edited prompts apply on the next Voice start. Reinstalling does not rewrite an already-running voice model's context.
- Unknown or ambiguous native session boundaries fail the compatibility check. The new policy requires the renderer transport; old main-inspector builds must explicitly use `CHATGPT_VOICE_POLICY=native`.
- It does not change native dictation or its transcription service.
- Dynamic composer inheritance is implemented for fresh Voice tasks launched from a selected project. A projectless Voice launch continues to use ChatGPT's own Voice defaults unless explicit pin mode is active.
- The new policy discovers semantic parameter names instead of fixed minified identifiers, and checks for exactly one match. Other legacy/UI enhancements still depend on React state and app implementation details. A changed protocol still requires revalidation.
- Fixed-model mode and `CHATGPT_PROJECT_VOICE_ROUTING=0` are unavailable on current protected builds.
- The active Voice picker changes the Codex worker for subsequent handoffs, not a worker turn already in progress.
- The existing-task Voice button appears only while the composer is empty and the task is not producing a response, matching ChatGPT's native action-control rules.
- The live transcript is display-only; finalized Voice messages remain owned by ChatGPT's normal transcript and handoff flow.
- Nothing is written into `/Applications/ChatGPT.app`; all runtime modifications disappear when ChatGPT exits.

## Package contents

- `install-chatgpt-voice-enhancements.sh` (required): validates configuration, safely launches or gracefully restarts ChatGPT when requested, and selects the debugger transport for the installed build.
- `inject-chatgpt-voice-enhancements.mjs` (required): supervises current renderer targets or installs the legacy IPC/native Voice hooks; it also contains deterministic self-tests.
- `chatgpt-voice-renderer-enhancements.js` (required): resolves project/composer state, applies the Voice-only timeout and microphone constraints, and renders the display-only live transcript.
- `voice-policy.mjs` and `voice-policy/*.md` (required): semantic boundary detection, policy validation/revision tracking, and editable English runtime instructions.
- `voice-policy.test.mjs` and `tests/` (development): deterministic policy checks and opt-in real-app synthetic-microphone smoke testing.
- `diagnose-chatgpt-voice-enhancements.mjs` (optional): reports runtime state. Its mutation flags are development tools, not part of normal installation.

The installer is not a self-contained single file. Keep it with all required JavaScript modules and the `voice-policy/` directory. The diagnostic and test files can be omitted for normal use.

## Diagnostics

With a ChatGPT inspector already open on port `9229`, print the current patch state:

```bash
node ./diagnose-chatgpt-voice-enhancements.mjs 9229
```

Assert that the existing-task Voice breakpoint is installed:

```bash
node ./diagnose-chatgpt-voice-enhancements.mjs 9229 --assert-existing-thread-voice
```

Legacy diagnostic flags such as `--install-capture`, `--dispose-project-routing`, and `--inject-css` change the current in-memory runtime. They are unavailable on current protected builds and intentionally excluded from normal use.

## Security and distribution

This code has no embedded credentials or user-specific paths. It talks only to a debugger bound to `127.0.0.1` and the local ChatGPT process. Any local process can normally reach a loopback debugging port, so close ChatGPT when the patch is not needed.
