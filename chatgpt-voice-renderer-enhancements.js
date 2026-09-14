/**
 * Renderer payload loaded by inject-chatgpt-voice-enhancements.mjs.
 *
 * It captures the selected project/model at the Voice click boundary, extends
 * only the realtime Voice inactivity timer, adds audio-processing constraints
 * only to the mono realtime Voice microphone request, and renders the active
 * realtime transcript without writing synthetic history. This file is an
 * expression: its final value is the installation result returned to the
 * main-process injector.
 */
(() => {
  const INSTALL_KEY = "__chatgptNativeProjectVoiceContextState";
  const CONTEXT_KEY = "__chatgptNativeProjectVoiceContext";
  const TRANSCRIPT_EVENT_KEY = "__chatgptNativeVoiceTranscriptEvent";
  const TRANSCRIPT_CHANNEL_NAME = "chatgpt-native-live-voice-transcript-v1";
  const TRANSCRIPT_ROOT_ATTRIBUTE = "data-chatgpt-live-voice-transcript";
  const VERSION = "chatgpt-native-project-voice-context-v15";
  const VOICE_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
  const AUTO_END_CALLBACK_MARKER = "stopRealtimeForAutoEnd";
  const VOICE_CAPTURE_CONSTRAINTS = {
    autoGainControl: true,
    echoCancellation: true,
    noiseSuppression: true,
    voiceIsolation: true,
  };

  const previous = window[INSTALL_KEY];
  if (previous?.version === VERSION && previous?.installed === true) {
    return {
      installed: true,
      inactivityTimeoutMs: VOICE_INACTIVITY_TIMEOUT_MS,
      liveTranscript: previous.liveTranscriptSnapshot?.() ?? null,
      voiceCaptureConstraints: VOICE_CAPTURE_CONSTRAINTS,
      projectContext: window[CONTEXT_KEY]?.() ?? null,
      version: VERSION,
    };
  }
  const previousTranscript = previous?.liveTranscriptSnapshot?.();
  previous?.dispose?.();

  const originalSetTimeout = window.setTimeout;
  const voiceAwareSetTimeout = function (callback, delay, ...args) {
    const callbackSource =
      typeof callback === "function"
        ? Function.prototype.toString.call(callback)
        : "";
    const effectiveDelay = callbackSource.includes(AUTO_END_CALLBACK_MARKER)
      ? VOICE_INACTIVITY_TIMEOUT_MS
      : delay;
    return Reflect.apply(originalSetTimeout, window, [callback, effectiveDelay, ...args]);
  };
  window.setTimeout = voiceAwareSetTimeout;

  const mediaDevices = window.navigator?.mediaDevices;
  const originalGetUserMedia = mediaDevices?.getUserMedia;
  const voiceAwareGetUserMedia =
    typeof originalGetUserMedia === "function"
      ? function (constraints) {
          const audio = constraints?.audio;
          const isRealtimeVoiceCapture =
            audio != null &&
            typeof audio === "object" &&
            audio.channelCount === 1 &&
            audio.noiseSuppression === true;
          if (!isRealtimeVoiceCapture) {
            return Reflect.apply(originalGetUserMedia, this, [constraints]);
          }
          return Reflect.apply(originalGetUserMedia, this, [
            {
              ...constraints,
              audio: { ...audio, ...VOICE_CAPTURE_CONSTRAINTS },
            },
          ]);
        }
      : null;
  if (voiceAwareGetUserMedia != null) mediaDevices.getUserMedia = voiceAwareGetUserMedia;

  const isAbsolutePath = (value) =>
    typeof value === "string" && value.startsWith("/");
  const normalizedRoots = (value, fallback) => {
    const roots = Array.isArray(value) ? value.filter(isAbsolutePath) : [];
    if (roots.length > 0) return [...new Set(roots)];
    return isAbsolutePath(fallback) ? [fallback] : [];
  };
  const fiberForElement = (element) => {
    if (!element) return null;
    const key = Object.keys(element).find(
      (candidate) =>
        candidate.startsWith("__reactFiber$") ||
        candidate.startsWith("__reactContainer$"),
    );
    return key ? element[key] : null;
  };
  const selectedProjectIdFromFiber = (start) => {
    let fiber = start;
    for (let depth = 0; fiber && depth < 48; depth += 1, fiber = fiber.return) {
      const selectedProject =
        fiber.memoizedProps?.selectedProject ?? fiber.pendingProps?.selectedProject;
      const projectId = selectedProject?.projectId ?? selectedProject?.id;
      if (typeof projectId === "string" && projectId.length > 0) return projectId;
    }
    return null;
  };
  const selectedVoiceWorkerFromComposer = () => {
    const candidates = document.querySelectorAll(
      "[data-selected-reasoning-effort]",
    );
    for (const element of candidates) {
      let fiber = fiberForElement(element);
      for (let depth = 0; fiber && depth < 48; depth += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps ?? fiber.pendingProps;
        if (!props || typeof props !== "object") continue;
        if (
          typeof props.model === "string" &&
          props.model.length > 0 &&
          typeof props.reasoningEffort === "string" &&
          props.reasoningEffort.length > 0 &&
          typeof props.onSelectModel === "function" &&
          typeof props.onSelectReasoningEffort === "function"
        ) {
          return {
            model: props.model,
            reasoningEffort: props.reasoningEffort,
          };
        }
      }
    }
    return null;
  };
  const contextFromProjectRow = (row) => {
    let fiber = fiberForElement(row);
    for (let depth = 0; fiber && depth < 48; depth += 1, fiber = fiber.return) {
      const candidates = [
        fiber.memoizedProps?.group,
        fiber.pendingProps?.group,
        fiber.memoizedProps?.project,
        fiber.pendingProps?.project,
      ];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const projectId = candidate.projectId ?? candidate.id;
        const roots = normalizedRoots(
          candidate.rootPaths ?? candidate.workspaceRoots,
          candidate.path ?? candidate.cwd,
        );
        const cwd = [candidate.path, candidate.cwd, roots[0]].find(isAbsolutePath);
        if (typeof projectId !== "string" || !cwd) continue;
        return {
          projectId,
          cwd,
          workspaceRoots: normalizedRoots(roots, cwd),
          label:
            candidate.label ??
            candidate.name ??
            cwd.split("/").filter(Boolean).at(-1) ??
            cwd,
          projectAssignment: {
            projectKind: candidate.projectKind ?? "local",
            projectId,
            path: cwd,
            cwd,
            pendingCoreUpdate: false,
          },
        };
      }
    }
    return null;
  };
  const projectContextsById = new Map();
  const refreshProjectContexts = () => {
    for (const row of document.querySelectorAll(
      "[data-app-action-sidebar-project-row]",
    )) {
      const context = contextFromProjectRow(row);
      if (context) projectContextsById.set(context.projectId, context);
    }
  };
  const resolveProjectContext = () => {
    refreshProjectContexts();
    const composer = document.querySelector("[data-codex-composer-root]");
    const selectedProjectId = selectedProjectIdFromFiber(fiberForElement(composer));
    if (selectedProjectId == null) return null;
    const row = [
      ...document.querySelectorAll("[data-app-action-sidebar-project-row]"),
    ].find(
      (candidate) =>
        candidate.dataset.appActionSidebarProjectId === selectedProjectId,
    );
    const context =
      contextFromProjectRow(row) ?? projectContextsById.get(selectedProjectId);
    if (context?.projectId !== selectedProjectId) return null;
    return {
      ...context,
      voiceWorkerSelection: selectedVoiceWorkerFromComposer(),
    };
  };
  refreshProjectContexts();
  let capturedProjectContext = resolveProjectContext();
  const captureProjectContext = () => {
    capturedProjectContext = resolveProjectContext();
  };
  const currentProjectContext = () =>
    resolveProjectContext() ?? capturedProjectContext;
  document.addEventListener("pointerdown", captureProjectContext, true);
  document.addEventListener("click", captureProjectContext, true);

  const isAvatarOverlay =
    typeof location !== "undefined" &&
    (location.pathname === "/avatar-overlay" ||
      new URLSearchParams(location.search).get("initialRoute")?.split("?")[0] ===
        "/avatar-overlay");
  const liveTranscript = {
    active: previousTranscript?.active ?? false,
    entries: previousTranscript?.entries ?? [],
    nextEntryId: 1 + Math.max(0, ...(previousTranscript?.entries ?? []).map(
      (entry) => Number(entry.id?.split("-").at(-1)) || 0,
    )),
    threadId: previousTranscript?.threadId ?? null,
  };
  let liveTranscriptRoot = null;
  let liveTranscriptCloseTimer = null;
  let liveTranscriptChannel = null;
  let liveTranscriptObserver = null;
  let lifecycleCheckScheduled = false;
  let voiceEndControlSeen = false;

  const currentConversationId = () => {
    let fiber = fiberForElement(
      document.querySelector?.("[data-codex-composer-root]"),
    );
    for (let depth = 0; fiber && depth < 48; depth += 1, fiber = fiber.return) {
      for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
        const conversationId =
          props?.conversationId ?? props?.browserConversationId;
        if (typeof conversationId === "string" && conversationId.length > 0) {
          return conversationId;
        }
      }
    }
    return null;
  };
  const transcriptSnapshot = () => ({
    active: liveTranscript.active,
    entries: liveTranscript.entries.map((entry) => ({ ...entry })),
    threadId: liveTranscript.threadId,
  });
  const hasVoiceEndControl = () => {
    const composer = document.querySelector?.("[data-codex-composer-root]");
    if (!composer?.querySelectorAll) return false;
    for (const button of composer.querySelectorAll("button")) {
      let fiber = fiberForElement(button);
      for (let depth = 0; fiber && depth < 16; depth += 1, fiber = fiber.return) {
        for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
          if (props?.action === "end") return true;
        }
      }
    }
    return false;
  };
  const removeLiveTranscript = () => {
    liveTranscriptRoot?.remove?.();
    liveTranscriptRoot = null;
  };
  const clearLiveTranscriptCloseTimer = () => {
    if (liveTranscriptCloseTimer == null) return;
    window.clearTimeout?.(liveTranscriptCloseTimer);
    liveTranscriptCloseTimer = null;
  };
  const transcriptReferenceColors = () => {
    const userBubble = document.querySelector?.(
      "[data-user-message-bubble='true']",
    );
    if (!userBubble || typeof getComputedStyle !== "function") {
      return { userBackground: "#000000", userText: "#ffffff" };
    }
    const style = getComputedStyle(userBubble);
    return {
      userBackground: style.backgroundColor || "#000000",
      userText: style.color || "#ffffff",
    };
  };
  const transcriptRepairs = new Map();
  const normalizeTranscriptText = (text) => text.replace(/\s+/g, "");
  const removeTranscriptRepair = (original, repair) => {
    original.style.display = repair.display;
    repair.replacement.remove();
    transcriptRepairs.delete(original);
  };
  const repairNativeTranscripts = () => {
    if (isAvatarOverlay) return;
    const threadId = currentConversationId();
    for (const [original, repair] of transcriptRepairs) {
      if (!original.isConnected || threadId !== repair.threadId ||
          original.textContent !== repair.originalText) {
        removeTranscriptRepair(original, repair);
      }
    }
    if (threadId == null || threadId !== liveTranscript.threadId) return;
    for (const row of document.querySelectorAll(
      '[data-content-search-unit-key^="realtime-voice:transcript:"]',
    )) {
      let fiber = fiberForElement(row);
      let block = null;
      for (let depth = 0; fiber && depth < 24; depth += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (props?.block?.entries && props.conversationId === threadId) {
          block = props.block;
          break;
        }
      }
      if (!block) continue;
      const key = row.getAttribute("data-content-search-unit-key");
      const index = block.entries.findIndex((entry) => key.endsWith(`:${entry.id}`));
      const native = block.entries[index];
      if (native?.role !== "assistant" || native.completed !== true || !native.text?.trim()) continue;
      const user = block.entries.slice(0, index).findLast((entry) => entry.role === "user");
      if (!user) continue;
      const prefix = normalizeTranscriptText(native.text);
      const candidates = [];
      let matchesUser = false;
      for (const entry of liveTranscript.entries) {
        if (entry.role === "user") {
          matchesUser = entry.done && normalizeTranscriptText(entry.text) === normalizeTranscriptText(user.text);
        } else if (matchesUser && entry.done) {
          const full = normalizeTranscriptText(entry.text);
          if (full.length > prefix.length && full.startsWith(prefix)) candidates.push(entry);
        }
      }
      // Only repair an unambiguous truncated reply to the same user utterance.
      if (candidates.length !== 1) continue;
      const following = block.entries.slice(index);
      const nextUser = following.findIndex((entry) => entry.role === "user");
      const nativeReply = following.slice(0, nextUser < 0 ? undefined : nextUser)
        .filter((entry) => entry.role === "assistant").map((entry) => entry.text).join("");
      const original = row.querySelector('[data-markdown-text-style="assistant-message"]');
      if (normalizeTranscriptText(nativeReply).includes(normalizeTranscriptText(candidates[0].text))) {
        const repair = transcriptRepairs.get(original);
        if (repair) removeTranscriptRepair(original, repair);
        continue;
      }
      if (!original || transcriptRepairs.has(original)) continue;
      const replacement = document.createElement("div");
      replacement.setAttribute("data-chatgpt-voice-transcript-repair", "true");
      replacement.textContent = candidates[0].text;
      replacement.style.whiteSpace = "pre-wrap";
      replacement.style.overflowWrap = "anywhere";
      transcriptRepairs.set(original, {
        display: original.style.display,
        originalText: original.textContent,
        replacement,
        threadId,
      });
      original.style.display = "none";
      original.parentElement.append(replacement);
    }
  };
  const createLiveTranscriptRoot = () => {
    if (typeof document.createElement !== "function") return null;
    const root = document.createElement("section");
    root.setAttribute(TRANSCRIPT_ROOT_ATTRIBUTE, "true");
    root.setAttribute("aria-label", "音声会話のライブ文字起こし");
    root.setAttribute("aria-live", "polite");
    Object.assign(root.style, {
      background: "var(--color-surface, #ffffff)",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      maxHeight: "min(38dvh, 360px)",
      overflowY: "auto",
      padding: "4px 0",
      pointerEvents: "auto",
      scrollbarGutter: "stable",
      width: "100%",
    });
    return root;
  };
  const renderLiveTranscript = () => {
    if (isAvatarOverlay || typeof document.createElement !== "function") return;
    repairNativeTranscripts();
    // Completed transcripts belong to the app's native conversation history.
    const pendingEntries = liveTranscript.entries.filter((entry) => !entry.done);
    const composer = document.querySelector?.("[data-codex-composer-root]");
    const composerParent = composer?.parentElement;
    const matchesVisibleConversation =
      liveTranscript.threadId != null &&
      currentConversationId() === liveTranscript.threadId;
    if (
      pendingEntries.length === 0 ||
      !matchesVisibleConversation ||
      !composerParent
    ) {
      removeLiveTranscript();
      return;
    }
    liveTranscriptRoot ??= createLiveTranscriptRoot();
    if (!liveTranscriptRoot) return;
    if (liveTranscriptRoot.parentElement !== composerParent) {
      composerParent.insertBefore(liveTranscriptRoot, composer);
    }
    liveTranscriptRoot.dataset.threadId = liveTranscript.threadId;
    liveTranscriptRoot.dataset.active = String(liveTranscript.active);
    liveTranscriptRoot.replaceChildren();
    const colors = transcriptReferenceColors();
    for (const entry of pendingEntries) {
      const row = document.createElement("div");
      row.dataset.liveVoiceRole = entry.role;
      row.dataset.liveVoiceFinal = String(entry.done);
      Object.assign(row.style, {
        display: "flex",
        justifyContent: entry.role === "user" ? "flex-end" : "stretch",
        minWidth: "0",
        width: "100%",
      });
      const text = document.createElement("div");
      text.textContent = entry.text;
      Object.assign(text.style, {
        fontFamily: "-apple-system, system-ui, 'Segoe UI', sans-serif",
        fontSize: "14px",
        fontWeight: "430",
        lineHeight: "1.625",
        overflowWrap: "anywhere",
        whiteSpace: "pre-wrap",
      });
      if (entry.role === "user") {
        Object.assign(text.style, {
          background: colors.userBackground,
          borderRadius: "22px",
          color: colors.userText,
          maxWidth: "min(var(--user-chat-width, 80%), 80%)",
          padding: "10px 16px",
        });
      } else {
        Object.assign(text.style, {
          borderInlineStart:
            "4px solid var(--color-border, rgba(26, 28, 31, 0.08))",
          color: "var(--color-text, #1a1c1f)",
          padding: "8px 0 8px 20px",
          width: "100%",
        });
      }
      row.append(text);
      liveTranscriptRoot.append(row);
    }
    liveTranscriptRoot.scrollTop = liveTranscriptRoot.scrollHeight;
  };
  const startLiveTranscript = (threadId) => {
    clearLiveTranscriptCloseTimer();
    liveTranscript.active = true;
    liveTranscript.threadId = threadId;
    liveTranscript.entries = [];
    liveTranscript.nextEntryId = 1;
    voiceEndControlSeen = hasVoiceEndControl();
    renderLiveTranscript();
  };
  const ensureLiveTranscriptThread = (threadId) => {
    if (liveTranscript.threadId !== threadId) startLiveTranscript(threadId);
    liveTranscript.active = true;
  };
  const appendLiveTranscriptDelta = (threadId, role, delta) => {
    if (typeof delta !== "string" || delta.length === 0) return;
    ensureLiveTranscriptThread(threadId);
    const normalizedRole = role === "user" ? "user" : "assistant";
    let entry = liveTranscript.entries.findLast(
      (candidate) => !candidate.done && candidate.role === normalizedRole,
    );
    if (!entry) {
      entry = {
        done: false,
        id: `live-voice-${liveTranscript.nextEntryId++}`,
        role: normalizedRole,
        text: "",
      };
      liveTranscript.entries.push(entry);
    }
    entry.text += delta;
    renderLiveTranscript();
  };
  const finishLiveTranscriptEntry = (threadId, role, text) => {
    ensureLiveTranscriptThread(threadId);
    const normalizedRole = role === "user" ? "user" : "assistant";
    let entry = liveTranscript.entries.findLast(
      (candidate) => !candidate.done && candidate.role === normalizedRole,
    );
    if (!entry) {
      entry = {
        done: false,
        id: `live-voice-${liveTranscript.nextEntryId++}`,
        role: normalizedRole,
        text: "",
      };
      liveTranscript.entries.push(entry);
    }
    if (typeof text === "string" && text.length > 0) entry.text = text;
    entry.done = true;
    if (entry.text.length === 0) {
      liveTranscript.entries.splice(liveTranscript.entries.indexOf(entry), 1);
    }
    renderLiveTranscript();
  };
  const closeLiveTranscript = () => {
    liveTranscript.active = false;
    voiceEndControlSeen = false;
    renderLiveTranscript();
    clearLiveTranscriptCloseTimer();
    liveTranscriptCloseTimer = Reflect.apply(originalSetTimeout, window, [
      () => {
        liveTranscriptCloseTimer = null;
        if (!liveTranscript.active) {
          removeLiveTranscript();
          liveTranscript.entries = [];
          liveTranscript.threadId = null;
        }
      },
      1500,
    ]);
  };
  const checkLiveTranscriptLifecycle = () => {
    lifecycleCheckScheduled = false;
    repairNativeTranscripts();
    if (
      !liveTranscript.active ||
      liveTranscript.threadId == null ||
      currentConversationId() !== liveTranscript.threadId ||
      !document.querySelector?.("[data-codex-composer-root]")
    ) {
      return;
    }
    if (hasVoiceEndControl()) {
      voiceEndControlSeen = true;
    } else if (voiceEndControlSeen) {
      closeLiveTranscript();
    }
  };
  const scheduleLiveTranscriptLifecycleCheck = () => {
    if (lifecycleCheckScheduled) return;
    lifecycleCheckScheduled = true;
    Promise.resolve().then(checkLiveTranscriptLifecycle);
  };
  const relevantTranscriptMethods = new Set([
    "thread/realtime/started",
    "thread/realtime/transcript/delta",
    "thread/realtime/transcript/done",
    "thread/realtime/error",
    "thread/realtime/closed",
  ]);
  const applyTranscriptEnvelope = (envelope) => {
    if (
      !envelope ||
      !relevantTranscriptMethods.has(envelope.method) ||
      typeof envelope.params?.threadId !== "string"
    ) {
      return false;
    }
    const { method, params } = envelope;
    switch (method) {
      case "thread/realtime/started":
        startLiveTranscript(params.threadId);
        break;
      case "thread/realtime/transcript/delta":
        appendLiveTranscriptDelta(params.threadId, params.role, params.delta);
        break;
      case "thread/realtime/transcript/done":
        finishLiveTranscriptEntry(params.threadId, params.role, params.text);
        break;
      case "thread/realtime/error":
      case "thread/realtime/closed":
        if (liveTranscript.threadId === params.threadId) closeLiveTranscript();
        break;
    }
    return true;
  };
  const acceptNativeTranscriptEvent = (method, params) => {
    if (!relevantTranscriptMethods.has(method)) return false;
    const safeParams = {
      delta: typeof params?.delta === "string" ? params.delta : null,
      message: typeof params?.message === "string" ? params.message : null,
      reason: typeof params?.reason === "string" ? params.reason : null,
      role: typeof params?.role === "string" ? params.role : null,
      text: typeof params?.text === "string" ? params.text : null,
      threadId: typeof params?.threadId === "string" ? params.threadId : null,
    };
    const envelope = { method, params: safeParams };
    const accepted = applyTranscriptEnvelope(envelope);
    if (accepted) liveTranscriptChannel?.postMessage?.(envelope);
    return accepted;
  };
  if (typeof BroadcastChannel === "function") {
    try {
      liveTranscriptChannel = new BroadcastChannel(TRANSCRIPT_CHANNEL_NAME);
      liveTranscriptChannel.addEventListener("message", (event) => {
        applyTranscriptEnvelope(event.data);
      });
    } catch {
      liveTranscriptChannel = null;
    }
  }
  if (
    !isAvatarOverlay &&
    typeof MutationObserver === "function" &&
    document.body
  ) {
    liveTranscriptObserver = new MutationObserver(
      scheduleLiveTranscriptLifecycleCheck,
    );
    liveTranscriptObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-label", "disabled"],
      childList: true,
      characterData: true,
      subtree: true,
    });
  }
  window[TRANSCRIPT_EVENT_KEY] = acceptNativeTranscriptEvent;

  const state = {
    version: VERSION,
    installed: true,
    liveTranscriptSnapshot: transcriptSnapshot,
    dispose() {
      document.removeEventListener("pointerdown", captureProjectContext, true);
      document.removeEventListener("click", captureProjectContext, true);
      if (window[CONTEXT_KEY] === currentProjectContext) delete window[CONTEXT_KEY];
      if (window[TRANSCRIPT_EVENT_KEY] === acceptNativeTranscriptEvent) {
        delete window[TRANSCRIPT_EVENT_KEY];
      }
      clearLiveTranscriptCloseTimer();
      liveTranscriptChannel?.close?.();
      liveTranscriptChannel = null;
      liveTranscriptObserver?.disconnect?.();
      liveTranscriptObserver = null;
      removeLiveTranscript();
      for (const [original, repair] of transcriptRepairs) removeTranscriptRepair(original, repair);
      if (window.setTimeout === voiceAwareSetTimeout) window.setTimeout = originalSetTimeout;
      if (mediaDevices?.getUserMedia === voiceAwareGetUserMedia) {
        mediaDevices.getUserMedia = originalGetUserMedia;
      }
      state.installed = false;
    },
  };
  window[CONTEXT_KEY] = currentProjectContext;
  window[INSTALL_KEY] = state;
  renderLiveTranscript();
  return {
    installed: true,
    inactivityTimeoutMs: VOICE_INACTIVITY_TIMEOUT_MS,
    liveTranscript: transcriptSnapshot(),
    voiceCaptureConstraints: VOICE_CAPTURE_CONSTRAINTS,
    projectContext: currentProjectContext(),
    version: VERSION,
  };
})()
