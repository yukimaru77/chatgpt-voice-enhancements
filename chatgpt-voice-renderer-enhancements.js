/**
 * Renderer payload loaded by inject-chatgpt-voice-enhancements.mjs.
 *
 * It captures the selected project/model at the Voice click boundary, extends
 * only the realtime Voice inactivity timer, and adds audio-processing
 * constraints only to the mono realtime Voice microphone request. This file is
 * an expression: its final value is the installation result returned to the
 * main-process injector.
 */
(() => {
  const INSTALL_KEY = "__chatgptNativeProjectVoiceContextState";
  const CONTEXT_KEY = "__chatgptNativeProjectVoiceContext";
  const VERSION = "chatgpt-native-project-voice-context-v9";
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
      voiceCaptureConstraints: VOICE_CAPTURE_CONSTRAINTS,
      projectContext: window[CONTEXT_KEY]?.() ?? null,
      version: VERSION,
    };
  }
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

  const state = {
    version: VERSION,
    installed: true,
    dispose() {
      document.removeEventListener("pointerdown", captureProjectContext, true);
      document.removeEventListener("click", captureProjectContext, true);
      if (window[CONTEXT_KEY] === currentProjectContext) delete window[CONTEXT_KEY];
      if (window.setTimeout === voiceAwareSetTimeout) window.setTimeout = originalSetTimeout;
      if (mediaDevices?.getUserMedia === voiceAwareGetUserMedia) {
        mediaDevices.getUserMedia = originalGetUserMedia;
      }
      state.installed = false;
    },
  };
  window[CONTEXT_KEY] = currentProjectContext;
  window[INSTALL_KEY] = state;
  return {
    installed: true,
    inactivityTimeoutMs: VOICE_INACTIVITY_TIMEOUT_MS,
    voiceCaptureConstraints: VOICE_CAPTURE_CONSTRAINTS,
    projectContext: currentProjectContext(),
    version: VERSION,
  };
})()
