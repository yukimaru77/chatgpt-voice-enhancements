#!/usr/bin/env node

/**
 * Inspector utility for ChatGPT Desktop Voice enhancement development.
 * With no flags it reports main-process and renderer state as JSON.
 * --assert-existing-thread-voice verifies the installed v10 capability.
 * --install-capture, --dispose-project-routing, and --inject-css mutate the
 * current in-memory runtime and are intended only for debugging.
 */

import { readFileSync } from "node:fs";

const inspectorPort = Number.parseInt(process.argv[2] ?? "9333", 10);
const assertExistingThreadVoice = process.argv.includes(
  "--assert-existing-thread-voice",
);
const sourceSearchIndex = process.argv.indexOf("--search-app-source");
const mainSourceSearchIndex = process.argv.indexOf("--search-main-source");
const detachRendererDebuggers = process.argv.includes(
  "--detach-renderer-debuggers",
);
const inspectInstallProgress = process.argv.includes("--install-progress");
const inspectBreakpointState = process.argv.includes("--breakpoint-state");
const inspectProjectContext = process.argv.includes("--project-context-debug");
const findFunctionIndex = process.argv.indexOf("--find-renderer-function");
const findFunctionName =
  findFunctionIndex >= 0 ? process.argv[findFunctionIndex + 1] : null;
const sourceSearchTerm =
  sourceSearchIndex >= 0 ? process.argv[sourceSearchIndex + 1] : null;
const mainSourceSearchTerm =
  mainSourceSearchIndex >= 0 ? process.argv[mainSourceSearchIndex + 1] : null;
if (sourceSearchIndex >= 0 && !sourceSearchTerm) {
  throw new Error("--search-app-source requires a search term");
}
if (mainSourceSearchIndex >= 0 && !mainSourceSearchTerm) {
  throw new Error("--search-main-source requires a search term");
}
if (findFunctionIndex >= 0 && !findFunctionName) {
  throw new Error("--find-renderer-function requires a function name");
}
const installCapture = process.argv.includes("--install-capture");
const disposeProjectRouting = process.argv.includes("--dispose-project-routing");
const injectCssIndex = process.argv.indexOf("--inject-css");
const injectCssPath = injectCssIndex >= 0 ? process.argv[injectCssIndex + 1] : null;
const injectedScript = injectCssPath
  ? readFileSync(injectCssPath, "utf8").match(
      /\/\*\s*@attune-script\s*\n([\s\S]*?)\n\s*@end-attune-script\s*\*\//,
    )?.[1]?.trim() ?? ""
  : "";
const safeInjectedScript = JSON.stringify(injectedScript)
  .replaceAll("`", "\\`")
  .replaceAll("${", "\\${");
const inspectorEndpoint = `http://127.0.0.1:${inspectorPort}/json/list`;

function inspectProjectContextInRenderer() {
  const fiberFor = (element) => {
    const key = Object.keys(element ?? {}).find(
      (name) =>
        name.startsWith("__reactFiber$") ||
        name.startsWith("__reactContainer$"),
    );
    return key ? element[key] : null;
  };
  const summarize = (value) => {
    if (!value || typeof value !== "object") return null;
    const result = {};
    for (const key of [
      "projectId", "id", "projectKind", "label", "name", "path", "cwd",
      "rootPath", "rootPaths", "workspaceRoots", "executionTargetCwd",
      "executionTargetHostId",
    ]) {
      const entry = value[key];
      if (
        entry == null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        Array.isArray(entry)
      ) result[key] = entry;
    }
    return Object.keys(result).length > 0 ? result : null;
  };
  const elements = new Set([
    ...document.querySelectorAll("[data-codex-composer-root]"),
    ...document.querySelectorAll("[data-app-action-sidebar-project-row]"),
    ...document.querySelectorAll("[aria-current]:not([aria-current=false])"),
    ...document.querySelectorAll("[aria-selected=true]"),
    ...[...document.querySelectorAll("[data-testid], [data-state], button, a")]
      .filter(
        (element) =>
          Object.keys(element.dataset ?? {}).some((key) =>
            /project|workspace|conversation|thread/i.test(key),
          ) || (element.textContent ?? "").trim() === ".codex",
      ),
  ]);
  return {
    resolver: globalThis.__chatgptNativeProjectVoiceContext?.() ?? null,
    elements: [...elements].slice(0, 40).map((element) => {
      const fibers = [];
      for (
        let fiber = fiberFor(element), depth = 0;
        fiber && depth < 80;
        fiber = fiber.return, depth += 1
      ) {
        for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
          if (!props || typeof props !== "object") continue;
          for (const [key, value] of Object.entries(props)) {
            if (!/project|workspace|cwd|executionTarget|group/i.test(key)) continue;
            const summary = summarize(value);
            if (summary || typeof value === "string") {
              fibers.push({ depth, key, value: summary ?? value });
            }
          }
        }
        if (fibers.length >= 30) break;
      }
      return {
        tag: element.tagName,
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
        ariaCurrent: element.getAttribute("aria-current"),
        ariaSelected: element.getAttribute("aria-selected"),
        dataset: { ...element.dataset },
        fibers: fibers.slice(0, 30),
      };
    }),
  };
}

const target = (await (await fetch(inspectorEndpoint)).json()).find(
  (candidate) => candidate.webSocketDebuggerUrl,
);
if (!target) throw new Error(`No ChatGPT inspector target found on port ${inspectorPort}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("Inspector connection failed")), {
    once: true,
  });
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id == null) return;
  const command = pending.get(message.id);
  if (!command) return;
  pending.delete(message.id);
  if (message.error || message.result?.exceptionDetails) {
    command.reject(
      new Error(
        message.error?.message ??
          message.result.exceptionDetails.exception?.description ??
          message.result.exceptionDetails.text,
      ),
    );
    return;
  }
  command.resolve(message.result);
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await send("Runtime.enable", {});
const expression = `
(async () => {
  const appRequire = typeof require === "function"
    ? require
    : process.mainModule?.require?.bind(process.mainModule);
  if (!appRequire) throw new Error("ChatGPT main-process require is unavailable");
  const { BrowserWindow, ipcMain } = appRequire("electron");
  const fs = appRequire("node:fs");
  const path = appRequire("node:path");
  const appInitialAsset = fs.readdirSync(
    path.join(process.resourcesPath, "app.asar", "webview", "assets"),
  ).find((name) => /^app-initial-[A-Za-z0-9_-]+[.]js$/.test(name));
  const appInitialUrl = appInitialAsset
    ? "app://-/assets/" + appInitialAsset
    : null;
  const sourceSearchTerm = ${JSON.stringify(sourceSearchTerm)};
  const mainSourceSearchTerm = ${JSON.stringify(mainSourceSearchTerm)};
  const appSourceMatches = [];
  if (sourceSearchTerm) {
    for (const filename of fs.readdirSync(
      path.join(process.resourcesPath, "app.asar", "webview", "assets"),
    )) {
      if (filename !== appInitialAsset) continue;
      const source = fs.readFileSync(
        path.join(process.resourcesPath, "app.asar", "webview", "assets", filename),
        "utf8",
      );
      let offset = 0;
      while (appSourceMatches.length < 30) {
        const index = source.indexOf(sourceSearchTerm, offset);
        if (index < 0) break;
        appSourceMatches.push({
          filename,
          index,
          source: source.slice(Math.max(0, index - 1200), index + sourceSearchTerm.length + 1800),
        });
        offset = index + sourceSearchTerm.length;
      }
      if (appSourceMatches.length >= 30) break;
    }
    return { appSourceMatches };
  }
  if (mainSourceSearchTerm) {
    const buildPath = path.join(process.resourcesPath, "app.asar", ".vite", "build");
    const mainSourceMatches = [];
    for (const filename of fs.readdirSync(buildPath)) {
      if (!filename.endsWith(".js")) continue;
      const source = fs.readFileSync(path.join(buildPath, filename), "utf8");
      let offset = 0;
      while (mainSourceMatches.length < 20) {
        const index = source.indexOf(mainSourceSearchTerm, offset);
        if (index < 0) break;
        mainSourceMatches.push({
          filename,
          index,
          source: source.slice(
            Math.max(0, index - 1400),
            index + mainSourceSearchTerm.length + 2200,
          ),
        });
        offset = index + mainSourceSearchTerm.length;
      }
    }
    return { mainSourceMatches };
  }
  if (${JSON.stringify(detachRendererDebuggers)}) {
    const detachedWindowIds = [];
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.debugger.isAttached()) {
        window.webContents.debugger.detach();
        detachedWindowIds.push(window.id);
      }
    }
    return { detachedWindowIds };
  }
  if (${JSON.stringify(inspectInstallProgress)}) {
    return { installProgress: globalThis.__chatgptVoiceInstallProgress ?? null };
  }
  if (${JSON.stringify(inspectBreakpointState)}) {
    const patch = globalThis.__chatgptNativeProjectVoicePatchState ?? null;
    const attachments = [];
    for (const attachment of patch?.attachments ?? []) {
      let breakpointState = null;
      try {
        const expression = ${JSON.stringify(inspectProjectContext)} &&
          attachment.label === "the main window"
          ? ${JSON.stringify(`(${inspectProjectContextInRenderer.toString()})()`)}
          : "globalThis.__chatgptNativeProjectVoiceBreakpointState ?? null";
        const evaluated = await attachment.contents.debugger.sendCommand(
          "Runtime.evaluate",
          {
            expression,
            returnByValue: true,
          },
        );
        breakpointState = evaluated?.result?.value ?? null;
      } catch (error) {
        breakpointState = { error: String(error) };
      }
      attachments.push({
        label: attachment.label,
        url: attachment.contents.getURL(),
        breakpointState,
      });
    }
    return {
      patch: patch?.publicState?.() ?? null,
      mainState: globalThis.__chatgptNativeProjectVoiceMainState ?? null,
      attachments,
    };
  }
  if (${JSON.stringify(Boolean(findFunctionName))}) {
    const patch = globalThis.__chatgptNativeProjectVoicePatchState ?? null;
    const functions = [];
    for (const attachment of patch?.attachments ?? []) {
      const evaluated = await attachment.contents.debugger.sendCommand(
        "Runtime.evaluate",
        {
          expression:
            "import(" + JSON.stringify(appInitialUrl) + ").then((module) => " +
            "JSON.stringify(Object.entries(module).flatMap(([key,value]) => {" +
            "if(typeof value!=='function')return [];" +
            "const source=Function.prototype.toString.call(value);" +
            "return source.startsWith('function " + ${JSON.stringify(findFunctionName)} + "(') || source.startsWith('async function " + ${JSON.stringify(findFunctionName)} + "(') ? [{key,source}] : [];" +
            "})))",
          awaitPromise: true,
          returnByValue: true,
        },
      );
      functions.push({
        label: attachment.label,
        matches: JSON.parse(evaluated?.result?.value ?? "[]"),
      });
    }
    return { functions };
  }
  const capture = ${JSON.stringify(installCapture)};
  const disposeProjectRouting = ${JSON.stringify(disposeProjectRouting)};
  const injectRendererScript = ${JSON.stringify(Boolean(injectedScript))};
  const injectedScript = ${safeInjectedScript};
  const state = globalThis.__chatgptVoiceWorkerRequestOverrideState ?? null;
  const windows = [];

  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents;
    let renderer = null;
    let attachedForInjection = false;
    try {
      if (disposeProjectRouting) {
        await contents.executeJavaScript(
          "window.__chatgptProjectVoiceRoutingOverrideState?.dispose?.(); true",
          true,
        );
      }
      if (injectRendererScript) {
        if (!contents.debugger.isAttached()) {
          contents.debugger.attach("1.3");
          attachedForInjection = true;
        }
        await contents.debugger.sendCommand("Page.setBypassCSP", { enabled: true });
        await contents.executeJavaScript(injectedScript, true);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      const rendererExpression = String.raw\`
        (async () => {
          const key = "__chatgptVoiceBridgeCapture";
          const bridge = window.electronBridge;
          const sendDescriptor = bridge
            ? Object.getOwnPropertyDescriptor(bridge, "sendMessageFromView")
            : null;
          let captureResult = null;
          if (${JSON.stringify(installCapture)} && bridge?.sendMessageFromView) {
            if (!window[key]) {
              const original = bridge.sendMessageFromView;
              const calls = [];
              try {
                bridge.sendMessageFromView = function capturedSendMessageFromView(...args) {
                  const message = args[0];
                  calls.push({
                    at: Date.now(),
                    method: message?.request?.method ?? null,
                    params: message?.request?.params ?? null,
                    topLevelKeys:
                      message && typeof message === "object" ? Object.keys(message) : [],
                  });
                  if (calls.length > 50) calls.shift();
                  return Reflect.apply(original, this, args);
                };
                window[key] = { installed: bridge.sendMessageFromView !== original, calls };
              } catch (error) {
                window[key] = { installed: false, calls, error: String(error) };
              }
            }
            captureResult = window[key];
          } else {
            captureResult = window[key] ?? null;
          }
          const runtimeExports = [];
          const projectFiberSummary = (element) => {
            const fiberKey = Object.keys(element ?? {}).find((key) =>
              key.startsWith("__reactFiber$") || key.startsWith("__reactContainer$"),
            );
            let fiber = fiberKey ? element[fiberKey] : null;
            const found = [];
            for (let depth = 0; fiber && depth < 48; depth += 1, fiber = fiber.return) {
              const props = fiber.memoizedProps;
              if (!props || typeof props !== "object") continue;
              for (const key of ["selectedProject", "activeProject", "project", "group"]) {
                const value = props[key];
                if (!value || typeof value !== "object") continue;
                found.push({
                  depth,
                  key,
                  keys: Object.keys(value),
                  id: value.projectId ?? value.id ?? null,
                  path: value.cwd ?? value.path ?? null,
                  roots: value.workspaceRoots ?? value.rootPaths ?? null,
                  label: value.label ?? value.name ?? null,
                });
              }
            }
            return found;
          };
          const modelFiberSummary = (element) => {
            const fiberKey = Object.keys(element ?? {}).find((key) =>
              key.startsWith("__reactFiber$") || key.startsWith("__reactContainer$"),
            );
            let fiber = fiberKey ? element[fiberKey] : null;
            const found = [];
            const summarize = (value) => {
              if (value == null || ["string", "number", "boolean"].includes(typeof value)) {
                return value;
              }
              if (Array.isArray(value)) {
                return value.slice(0, 8).map((entry) => summarize(entry));
              }
              if (typeof value !== "object") return typeof value;
              const output = {};
              for (const [key, entry] of Object.entries(value).slice(0, 30)) {
                if (
                  /model|reason|effort|slug|id|label|value|setting/i.test(key) &&
                  (entry == null || ["string", "number", "boolean"].includes(typeof entry))
                ) {
                  output[key] = entry;
                }
              }
              return output;
            };
            for (let depth = 0; fiber && depth < 64; depth += 1, fiber = fiber.return) {
              const props = fiber.memoizedProps;
              if (!props || typeof props !== "object") continue;
              for (const [key, value] of Object.entries(props)) {
                if (!/model|reason|effort|collaboration|setting/i.test(key)) continue;
                found.push({ depth, key, value: summarize(value) });
              }
            }
            return found;
          };
          const resourceUrls = ["__CHATGPT_APP_INITIAL_URL__"].filter(
            (name) => name !== "null",
          ).concat(performance.getEntriesByType("resource")
            .map((entry) => entry.name)
            .filter((name) =>
              name.includes("/assets/app-initial-") && name.includes(".js"),
            ));
          for (const source of document.querySelectorAll("script[src]")) {
            try {
              const text = await fetch(source.src).then((response) => response.text());
              const marker = "app-initial-";
              let offset = 0;
              while ((offset = text.indexOf(marker, offset)) >= 0) {
                const end = text.indexOf(".js", offset);
                if (end < 0) break;
                const fileName = text.slice(offset, end + 3);
                resourceUrls.push(new URL(fileName, new URL("./", source.src)).href);
                offset = end + 3;
              }
            } catch {}
          }
          for (const url of [...new Set(resourceUrls)]) {
            try {
              const module = await import(url);
              const value = module.Rut;
              let requestDescriptor = null;
              let requestOwnerDepth = null;
              let requestOwner = value?.realtimeVoiceRuntime ?? null;
              for (let depth = 0; requestOwner != null && depth < 8; depth += 1) {
                const descriptor = Object.getOwnPropertyDescriptor(
                  requestOwner,
                  "requestRealtimeStart",
                );
                if (descriptor) {
                  requestDescriptor = descriptor;
                  requestOwnerDepth = depth;
                  break;
                }
                requestOwner = Object.getPrototypeOf(requestOwner);
              }
              runtimeExports.push({
                name: "Rut",
                valueType: typeof value,
                runtimeType: typeof value?.realtimeVoiceRuntime,
                requestType: typeof value?.realtimeVoiceRuntime?.requestRealtimeStart,
                registerType: typeof value?.realtimeVoiceRuntime?.registerRealtimeStarter,
                runtimeKeys:
                  value?.realtimeVoiceRuntime == null
                    ? []
                    : Object.getOwnPropertyNames(value.realtimeVoiceRuntime),
                requestSource:
                  typeof value?.realtimeVoiceRuntime?.requestRealtimeStart === "function"
                    ? Function.prototype.toString.call(
                        value.realtimeVoiceRuntime.requestRealtimeStart,
                      )
                    : null,
                requestOwnerDepth,
                requestDescriptor: requestDescriptor
                  ? {
                      writable: requestDescriptor.writable ?? null,
                      configurable: requestDescriptor.configurable ?? null,
                      hasGetter: typeof requestDescriptor.get === "function",
                      hasSetter: typeof requestDescriptor.set === "function",
                    }
                  : null,
                candidateExports: Object.entries(module).flatMap(([key, candidate]) => {
                  try {
                    return typeof candidate?.realtimeVoiceRuntime?.requestRealtimeStart ===
                      "function"
                      ? [{
                          key,
                          runtimeType: typeof candidate.realtimeVoiceRuntime,
                        }]
                      : [];
                  } catch {
                    return [];
                  }
                }),
              });
            } catch (error) {
              runtimeExports.push({ error: String(error) });
            }
          }
          return {
            href: location.href,
            codexWindowType: window.codexWindowType ?? null,
            bridgeExtensible: bridge ? Object.isExtensible(bridge) : null,
            bridgeFrozen: bridge ? Object.isFrozen(bridge) : null,
            sendDescriptor: sendDescriptor
              ? {
                  writable: sendDescriptor.writable ?? null,
                  configurable: sendDescriptor.configurable ?? null,
                  enumerable: sendDescriptor.enumerable ?? null,
                }
              : null,
            capture: captureResult,
            runtimeExports,
            projectVoiceState: window.__attuneCodexProjectVoiceV1
              ? {
                  installed: window.__attuneCodexProjectVoiceV1.installed,
                  status: window.__attuneCodexProjectVoiceV1.status,
                  wrapped: window.__attuneCodexProjectVoiceV1.wrapped,
                  projectContext: window.__attuneCodexProjectVoiceV1.projectContext,
                  lastCreatedConversationId:
                    window.__attuneCodexProjectVoiceV1.lastCreatedConversationId,
                  lastError: window.__attuneCodexProjectVoiceV1.lastError,
                  capabilities: window.__attuneCodexProjectVoiceV1.capabilities,
                }
              : null,
            projectVoiceRoutingState: window.__chatgptProjectVoiceRoutingOverrideState
              ? {
                  installed:
                    window.__chatgptProjectVoiceRoutingOverrideState.installed,
                  status: window.__chatgptProjectVoiceRoutingOverrideState.status,
                  projectContext:
                    window.__chatgptProjectVoiceRoutingOverrideState.currentProjectContext?.()
                    ?? window.__chatgptProjectVoiceRoutingOverrideState.projectContext,
                  lastCreatedConversationId:
                    window.__chatgptProjectVoiceRoutingOverrideState
                      .lastCreatedConversationId,
                  lastError:
                    window.__chatgptProjectVoiceRoutingOverrideState.lastError,
                  routedVoiceTasks:
                    window.__chatgptProjectVoiceRoutingOverrideState.routedVoiceTasks,
                  version: window.__chatgptProjectVoiceRoutingOverrideState.version,
                }
              : null,
            nativeProjectVoiceContextState: window.__chatgptNativeProjectVoiceContextState
              ? {
                  installed: window.__chatgptNativeProjectVoiceContextState.installed,
                  version: window.__chatgptNativeProjectVoiceContextState.version,
                  projectContext: window.__chatgptNativeProjectVoiceContext?.() ?? null,
                }
              : null,
            nativeProjectVoiceBreakpointState:
              globalThis.__chatgptNativeProjectVoiceBreakpointState ?? null,
            voiceControls: [...document.querySelectorAll("button, [role=button]")]
              .map((element) => ({
                tag: element.tagName,
                ariaLabel: element.getAttribute("aria-label"),
                title: element.getAttribute("title"),
                text: (element.textContent ?? "").replace(/\\s+/g, " ").trim(),
              }))
              .filter((control) =>
                [control.ariaLabel, control.title, control.text]
                  .filter(Boolean)
                  .some((value) => /voice/i.test(value)),
              ),
            projectRows: [...document.querySelectorAll(
              "[data-app-action-sidebar-project-row]",
            )].slice(0, 30).map((element) => ({
              text: (element.textContent ?? "").replace(/\\s+/g, " ").trim(),
              ariaCurrent: element.getAttribute("aria-current"),
              dataset: { ...element.dataset },
              fiber: projectFiberSummary(element),
            })),
            composerProjectFiber: projectFiberSummary(
              document.querySelector("[data-codex-composer-root]"),
            ),
            composerModelFiber: modelFiberSummary(
              document.querySelector("[data-codex-composer-root]"),
            ),
            modelControls: [...document.querySelectorAll("button, [role=button]")]
              .map((element) => ({
                text: (element.textContent ?? "").replace(/\\s+/g, " ").trim(),
                ariaLabel: element.getAttribute("aria-label"),
                title: element.getAttribute("title"),
                testId: element.getAttribute("data-testid"),
                modelFiber: modelFiberSummary(element),
              }))
              .filter((control) =>
                [control.text, control.ariaLabel, control.title, control.testId]
                  .filter(Boolean)
                  .some((value) => /model|reason|effort|gpt|claude|grok|sol|terra|luna/i.test(value)),
              )
              .slice(0, 30),
          };
        })()
      \`;
      renderer = await contents.executeJavaScript(
        rendererExpression.replace(
          "__CHATGPT_APP_INITIAL_URL__",
          String(appInitialUrl),
        ),
        true,
      );
    } catch (error) {
      renderer = { error: String(error) };
    } finally {
      if (attachedForInjection) {
        await contents.debugger.sendCommand("Page.setBypassCSP", { enabled: false }).catch(() => {});
        contents.debugger.detach();
      }
    }

    const mapKeys = (value) =>
      value && typeof value.keys === "function" ? [...value.keys()].map(String) : [];
    windows.push({
      id: window.id,
      visible: window.isVisible(),
      url: contents.getURL(),
      webContentsInvokeHandlers: mapKeys(contents._invokeHandlers),
      mainFrameInvokeHandlers: mapKeys(contents.mainFrame?._invokeHandlers),
      renderer,
    });
  }

  return {
    appSourceMatches,
    nativeProjectVoicePatchState:
      globalThis.__chatgptNativeProjectVoicePatchState?.publicState?.() ?? null,
    overrideState: state
      ? {
          version: state.version,
          installed: state.installed,
          rewrittenRequests: state.rewrittenRequests,
          lastMethod: state.lastMethod,
          lastThreadId: state.lastThreadId,
          lastOriginalModel: state.lastOriginalModel,
          lastOriginalEffort: state.lastOriginalEffort,
          wrapperStillInstalled:
            ipcMain._invokeHandlers?.get?.(state.targetChannel)?.name ===
            "chatgptVoiceWorkerHandler",
        }
      : null,
    ipcMainInvokeHandlers: ipcMain._invokeHandlers
      ? [...ipcMain._invokeHandlers.keys()].map(String)
      : [],
    captureRequested: capture,
    windows,
  };
})()
`;

const evaluated = await send("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
});
const runtimeState = evaluated.result.value;
if (inspectInstallProgress) {
  console.log(JSON.stringify(runtimeState?.installProgress ?? null));
} else if (detachRendererDebuggers) {
  console.log(JSON.stringify(runtimeState?.detachedWindowIds ?? []));
} else if (sourceSearchTerm) {
  console.log(JSON.stringify(runtimeState?.appSourceMatches ?? [], null, 2));
} else if (assertExistingThreadVoice) {
  if (runtimeState?.nativeProjectVoicePatchState?.existingThreadVoice?.enabled !== true) {
    throw new Error("Existing-thread Voice launch is not installed");
  }
  console.log("Existing-thread Voice launch is installed.");
} else {
  console.log(JSON.stringify(runtimeState, null, 2));
}
socket.close();
