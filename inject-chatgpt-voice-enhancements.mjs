#!/usr/bin/env node

/**
 * Installs the ChatGPT Desktop Voice enhancement suite through the Electron
 * main-process
 * Chrome DevTools Protocol endpoint. It does not modify app.asar or any signed
 * application files. The patch lives only until that ChatGPT process exits.
 *
 * Normal use is through install-chatgpt-voice-enhancements.sh. Direct modes:
 *   node inject-chatgpt-voice-enhancements.mjs <port> <timeout-ms> --validate-only
 *   node inject-chatgpt-voice-enhancements.mjs <port> <timeout-ms> --self-test
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

const inspectorPort = Number.parseInt(process.argv[2] ?? "9333", 10);
const startupDeadline = Date.now() + Number.parseInt(process.argv[3] ?? "30000", 10);
const validateOnly = process.argv.includes("--validate-only");
const selfTest = process.argv.includes("--self-test");
const projectVoiceRoutingEnabled =
  process.env.CHATGPT_PROJECT_VOICE_ROUTING?.trim() !== "0";
const voiceDynamicTools = {
  appshotsEnabled: process.env.CHATGPT_VOICE_APPSHOTS?.trim() !== "0",
  endRealtimeVoiceCallEnabled:
    process.env.CHATGPT_VOICE_END_CALL_TOOL?.trim() !== "0",
  speakToUserEnabled: process.env.CHATGPT_VOICE_SPEAK_TO_USER?.trim() !== "0",
};
const inspectorEndpoint = `http://127.0.0.1:${inspectorPort}/json/list`;
const projectVoiceRendererTemplate = readFileSync(
  new URL("./chatgpt-voice-renderer-enhancements.js", import.meta.url),
  "utf8",
);
const projectVoicePatchVersion = "chatgpt-native-project-voice-breakpoints-v18";

function findVoiceStartRequestFunction(source) {
  const pattern = /async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let [A-Za-z_$][\w$]*=\2\.get\([^)]+\);if\([\s\S]{0,220}?\3\.source!==`composer_button_new_thread`\)[\s\S]{0,600}?\.requestRealtimeStart\(\3,/g;
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1
    ? { functionName: matches[0][1], matchCount: 1, requestVariable: matches[0][3] }
    : { matchCount: matches.length };
}

function findVoiceIntentMapper(source) {
  const pattern = /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{switch\(\2\.source\)\{case`composer_button_existing_thread`:return\{type:`exact`,locator:\2\.locator\};case`composer_button_new_thread`:return\{type:`new`,hostId:\3\}/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return { matchCount: matches.length };
  const match = matches[0];
  return {
    breakpointOffset: match.index + match[0].indexOf("switch("),
    functionName: match[1],
    matchCount: 1,
    requestVariable: match[2],
  };
}

function findVoiceCoordinator(source) {
  const pattern = /async function ([A-Za-z_$][\w$]*)\(\{activeCollaborationMode:([A-Za-z_$][\w$]*),activateRealtimeConversation:[A-Za-z_$][\w$]*,agentMode:[A-Za-z_$][\w$]*,currentLocalExecutionCwd:([A-Za-z_$][\w$]*),intent:([A-Za-z_$][\w$]*),memoryPreferences:[A-Za-z_$][\w$]*,onStartError:[A-Za-z_$][\w$]*,permissionProfileId:[A-Za-z_$][\w$]*,serviceTier:[A-Za-z_$][\w$]*,shouldSendPermissionOverrides:[A-Za-z_$][\w$]*,scope:[A-Za-z_$][\w$]*,treatment:([A-Za-z_$][\w$]*),threadToolsEnabled:[A-Za-z_$][\w$]*,workspaceRootsForLocalExecution:([A-Za-z_$][\w$]*)\}\)\{try\{/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return { matchCount: matches.length };
  const match = matches[0];
  return {
    breakpointOffset: match.index + match[0].lastIndexOf("try{"),
    cwdVariable: match[3],
    functionName: match[1],
    intentVariable: match[4],
    matchCount: 1,
    rootsVariable: match[6],
    treatmentVariable: match[5],
  };
}

function findConversationStartBoundary(source) {
  const pattern = /async startConversation\(([A-Za-z_$][\w$]*),\{afterConversationCreated:[A-Za-z_$][\w$]*,beforeFirstTurn:[A-Za-z_$][\w$]*,returnAfterOptimisticTurn:[A-Za-z_$][\w$]*\}=\{\}\)\{let\{input:[\s\S]{0,1800}?threadSource:[A-Za-z_$][\w$]*,threadStartKind:/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return { matchCount: matches.length };
  const match = matches[0];
  return {
    breakpointOffset: match.index + match[0].indexOf("let{input:"),
    matchCount: 1,
    requestVariable: match[1],
  };
}

function mainVoiceBreakpointConditionFor(startFunction) {
  const request = startFunction.requestVariable;
  return `(${request} && typeof ${request} === "object" && ${request}.source === "composer_button_new_thread" && (${request}.projectContext = globalThis.__chatgptNativeProjectVoiceContext?.() ?? null), globalThis.__chatgptNativeProjectVoiceBreakpointState.mainHandoffs += 1, false)`;
}

function overlayIntentBreakpointConditionFor(intentMapper) {
  const request = intentMapper.requestVariable;
  return `(globalThis.__chatgptActiveVoiceProjectContext = ${request} && typeof ${request} === "object" ? ${request}.projectContext ?? null : null, globalThis.__chatgptNativeProjectVoiceBreakpointState.overlayIntents += 1, false)`;
}

function voiceCoordinatorConditionFor(coordinator, dynamicTools) {
  const cwd = coordinator.cwdVariable;
  const roots = coordinator.rootsVariable;
  const treatment = coordinator.treatmentVariable;
  return `(() => { const context = globalThis.__chatgptActiveVoiceProjectContext; ${treatment} = { ...${treatment}, dynamicTools: { ...(${treatment}.dynamicTools ?? {}), ...${JSON.stringify(dynamicTools)} } }; globalThis.__chatgptNativeProjectVoiceBreakpointState.coordinatorRewrites += 1; globalThis.__chatgptNativeProjectVoiceBreakpointState.lastDynamicTools = ${treatment}.dynamicTools; if (context) { ${cwd} = context.cwd; ${roots} = context.workspaceRoots; const selection = context.voiceWorkerSelection; if (selection && typeof selection.model === "string" && typeof selection.reasoningEffort === "string") { ${treatment} = { ...${treatment}, newThread: { ...${treatment}.newThread, model: selection.model, reasoningEffort: selection.reasoningEffort } }; globalThis.__chatgptNativeProjectVoiceBreakpointState.modelRewrites += 1; globalThis.__chatgptNativeProjectVoiceBreakpointState.lastVoiceWorkerSelection = selection; } globalThis.__chatgptNativeProjectVoiceBreakpointState.lastProjectContext = context; } return false; })()`;
}

function conversationStartBoundaryConditionFor(boundary, dynamicTools) {
  const request = boundary.requestVariable;
  return `(() => { if (!${request} || ${request}.threadSource !== "realtime_voice") return false; const context = globalThis.__chatgptActiveVoiceProjectContext; ${request}.realtimeVoiceDynamicTools = { ...(${request}.realtimeVoiceDynamicTools ?? {}), ...${JSON.stringify(dynamicTools)} }; globalThis.__chatgptNativeProjectVoiceBreakpointState.dynamicToolRewrites += 1; globalThis.__chatgptNativeProjectVoiceBreakpointState.lastDynamicTools = ${request}.realtimeVoiceDynamicTools; if (context) { Object.assign(${request}, { cwd: context.cwd, workspaceRoots: context.workspaceRoots, workspaceKind: "project", skipFallbackConfigReadForProjectlessCwd: false, projectAssignment: context.projectAssignment }); const selection = context.voiceWorkerSelection; if (selection && typeof selection.model === "string" && typeof selection.reasoningEffort === "string") { const currentMode = ${request}.collaborationMode && typeof ${request}.collaborationMode === "object" ? ${request}.collaborationMode : { mode: "default" }; ${request}.collaborationMode = { ...currentMode, settings: { ...(currentMode.settings ?? {}), model: selection.model, reasoning_effort: selection.reasoningEffort } }; globalThis.__chatgptNativeProjectVoiceBreakpointState.modelRewrites += 1; globalThis.__chatgptNativeProjectVoiceBreakpointState.lastVoiceWorkerSelection = selection; } delete ${request}.projectlessOutputDirectory; globalThis.__chatgptNativeProjectVoiceBreakpointState.threadRewrites += 1; globalThis.__chatgptNativeProjectVoiceBreakpointState.lastProjectContext = context; } return false; })()`;
}

function findVoiceThreadFooterGate(source) {
  const pattern = /realtimeSession:([A-Za-z_$][\w$]*),waveformCanvasRef:[A-Za-z_$][\w$]*\}=([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=\1\.isVoiceThread\|\|\1\.thread\.phase!==`inactive`[\s\S]{0,2200}?jo\(nD,/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return { matchCount: matches.length };
  const match = matches[0];
  const breakpointNeedle = "jo(nD,";
  return {
    breakpointOffset: match.index + match[0].lastIndexOf(breakpointNeedle),
    gateVariable: match[3],
    matchCount: 1,
    realtimeSessionVariable: match[1],
  };
}

function findExistingThreadVoiceGate(source) {
  const pattern = /([A-Za-z_$][\w$]*)=\(([A-Za-z_$][\w$]*)!=null\|\|([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)!=null\)&&([A-Za-z_$][\w$]*)&&navigator\.mediaDevices\?\.getUserMedia!=null&&typeof RTCPeerConnection<`u`,([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(async\(\)=>\{[\s\S]{0,1800}?return\{isStartAvailable:\1,isSubmitStarting:[\s\S]{0,240}?isVoiceThread:\3,startConversation:\6,thread:[A-Za-z_$][\w$]*,visiblePhase:![A-Za-z_$][\w$]*\|\|([A-Za-z_$][\w$]*)===`inactive`/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return { matchCount: matches.length };
  const match = matches[0];
  const prefix = source.slice(Math.max(0, match.index - 3200), match.index);
  const signatures = [...prefix.matchAll(/function [A-Za-z_$][\w$]*\(\{conversationId:([A-Za-z_$][\w$]*),executionTargetCwd:[A-Za-z_$][\w$]*,executionTargetHostId:([A-Za-z_$][\w$]*),/g)];
  const signature = signatures.at(-1);
  if (!signature || signature[1] !== match[4]) return { matchCount: 0 };
  const realtimeStateMatches = [...prefix.matchAll(
    /([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(Q\)[\s\S]{0,1800}?,([A-Za-z_$][\w$]*)=Y\([^)]+\),([A-Za-z_$][\w$]*)=Y\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=[^,]+&&[A-Za-z_$][\w$]*\(\3,[^,]+,[^)]+\)&&\3\.phase!==`failed`,([A-Za-z_$][\w$]*)=\2\.phase!==`inactive`[\s\S]{0,260}?\?\2:null,([A-Za-z_$][\w$]*)=\5\?`inactive`:\6\?\.phase\?\?/g,
  )];
  const realtimeState = realtimeStateMatches.at(-1);
  if (!realtimeState || realtimeState[7] !== match[7]) return { matchCount: 0 };
  const breakpointNeedle = "return{isStartAvailable:" + match[1];
  return {
    activeSessionVariable: realtimeState[6],
    availabilityVariable: match[1],
    conversationIdVariable: match[4],
    featureEnabledVariable: match[5],
    hostIdVariable: signature[2],
    isVoiceThreadVariable: match[3],
    launchPendingVariable: realtimeState[5],
    launchStateAtom: realtimeState[4],
    phaseVariable: match[7],
    storeVariable: realtimeState[1],
    breakpointOffset: match.index + match[0].lastIndexOf(breakpointNeedle),
    matchCount: 1,
  };
}

function findExistingThreadVoiceSourceGuard(source) {
  const pattern = /let\{threadSource:([A-Za-z_$][\w$]*)\}=await ([A-Za-z_$][\w$]*)\(`maybe-resume-conversation`,\{hostId:([A-Za-z_$][\w$]*),conversationId:([A-Za-z_$][\w$]*),[\s\S]{0,800}?\}\);if\(\1!==`realtime_voice`\)throw Error\(`This thread is not a voice chat`\)/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return { matchCount: matches.length };
  const match = matches[0];
  const breakpointNeedle = "if(" + match[1] + "!==`realtime_voice`)";
  return {
    breakpointOffset: match.index + match[0].lastIndexOf(breakpointNeedle),
    conversationIdVariable: match[4],
    matchCount: 1,
    requestFunction: match[2],
    threadSourceVariable: match[1],
  };
}

function findExistingThreadPresentationGate(source) {
  const pattern = /async requestStart\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=\2\.source===`composer_button_new_thread`\|\|\2\.source===`composer_button_existing_thread`[\s\S]{0,2200}?let ([A-Za-z_$][\w$]*)=!\4,/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return { matchCount: matches.length };
  const match = matches[0];
  const breakpointNeedle = "let " + match[5] + "=!" + match[4] + ",";
  return {
    breakpointOffset: match.index + match[0].lastIndexOf(breakpointNeedle),
    mainWindowLaunchVariable: match[4],
    matchCount: 1,
    requestVariable: match[2],
  };
}

function findInterruptedResumeVoicePrecedence(source) {
  const pattern = /else if\(([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)!=null&&([A-Za-z_$][\w$]*)===`interrupted`&&[\s\S]{0,360}?([A-Za-z_$][\w$]*)===`empty-message`\)\{[\s\S]{0,800}?\}else if\(([A-Za-z_$][\w$]*)\.isStartButtonVisible\)\{/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return { matchCount: matches.length };
  const match = matches[0];
  return {
    breakpointOffset: match.index,
    matchCount: 1,
    resumeLoadingVariable: match[1],
    threadStatusVariable: match[3],
    voiceControlVariable: match[5],
  };
}

function sourceLocationAt(source, offset) {
  const before = source.slice(0, offset);
  const lastNewline = before.lastIndexOf("\n");
  return {
    lineNumber: before.split("\n").length - 1,
    columnNumber: offset - lastNewline - 1,
  };
}

function voiceThreadFooterConditionFor(gateVariable, realtimeSessionVariable) {
  return `(${realtimeSessionVariable}.isVoiceThread && (${gateVariable} = false, globalThis.__chatgptNativeProjectVoiceBreakpointState.voiceFooterGateHits += 1), false)`;
}

function existingThreadVoiceConditionFor(gate) {
  const activeSession = gate.activeSessionVariable;
  const conversationId = gate.conversationIdVariable;
  const isVoiceThread = gate.isVoiceThreadVariable;
  const isAvailable = gate.availabilityVariable;
  const featureEnabled = gate.featureEnabledVariable;
  const launchPending = gate.launchPendingVariable;
  const launchStateAtom = gate.launchStateAtom;
  const phase = gate.phaseVariable;
  const store = gate.storeVariable;
  return `(${conversationId} != null && !${isVoiceThread} && (${isVoiceThread} = true, ${isAvailable} = ${featureEnabled} && navigator.mediaDevices?.getUserMedia != null && typeof RTCPeerConnection !== "undefined", globalThis.__chatgptNativeProjectVoiceBreakpointState.existingThreadVoiceGateHits += 1, globalThis.__chatgptNativeProjectVoiceBreakpointState.lastExistingThreadId = ${conversationId}, ${launchPending} && ${activeSession}?.phase === "active" && (${store}.set(${launchStateAtom}, null), ${launchPending} = false, ${phase} = ${activeSession}.phase, globalThis.__chatgptNativeProjectVoiceBreakpointState.existingThreadHandoffCompletions += 1)), false)`;
}

function existingThreadPresentationConditionFor(gate) {
  const request = gate.requestVariable;
  const mainWindowLaunch = gate.mainWindowLaunchVariable;
  return `(${request}?.source === "composer_button_existing_thread" && (${mainWindowLaunch} = false, globalThis.__chatgptNativeProjectVoiceMainState.existingThreadOverlayStarts += 1, globalThis.__chatgptNativeProjectVoiceMainState.lastSource = ${request}.source), false)`;
}

function interruptedResumeVoicePrecedenceConditionFor(gate) {
  return `(${gate.voiceControlVariable}.isStartButtonVisible && (${gate.resumeLoadingVariable} = false, ${gate.threadStatusVariable} = "voice-ready", globalThis.__chatgptNativeProjectVoiceBreakpointState.interruptedResumeOverrides += 1), false)`;
}

function existingThreadVoiceSourceConditionFor(guard) {
  const threadSource = guard.threadSourceVariable;
  const conversationId = guard.conversationIdVariable;
  return `(${threadSource} !== "realtime_voice" && (${threadSource} = "realtime_voice", globalThis.__chatgptNativeProjectVoiceBreakpointState.existingThreadSourceOverrides += 1, globalThis.__chatgptNativeProjectVoiceBreakpointState.lastExistingThreadId = ${conversationId}), false)`;
}

let voiceWorker;
try {
  voiceWorker = resolveVoiceWorkerConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const { mode: voiceWorkerMode, model, reasoningEffort } = voiceWorker;
const hookVersion = "chatgpt-voice-worker-request-v6";
let activeConnection = null;
let stopping = false;
const overrideSource = String.raw`
(() => {
  const stateKey = "__chatgptVoiceWorkerRequestOverrideState";
  const hookVersion = ${JSON.stringify(hookVersion)};
  const requestedMode = ${JSON.stringify(voiceWorkerMode)};
  const requestedModel = ${JSON.stringify(model)};
  const requestedReasoningEffort = ${JSON.stringify(reasoningEffort)};
  const messageFromViewChannel = "codex_desktop:message-from-view";
  const existing = globalThis[stateKey];
  if (
    existing?.hookVersion === hookVersion &&
    existing?.installed === true &&
    typeof existing?.setConfig === "function"
  ) {
    existing.setConfig(requestedMode, requestedModel, requestedReasoningEffort);
    return existing;
  }
  existing?.restore?.();

  let appRequire = null;
  if (typeof require === "function") {
    appRequire = require;
  } else if (typeof process.mainModule?.require === "function") {
    appRequire = process.mainModule.require.bind(process.mainModule);
  } else if (typeof process.getBuiltinModule === "function") {
    const Module = process.getBuiltinModule("module");
    appRequire = Module.createRequire(
      process.resourcesPath + "/app.asar/package.json",
    );
  }
  if (appRequire == null) {
    throw new Error("Electron main-process module loader is unavailable");
  }
  const { app, ipcMain } = appRequire("electron");
  const inspector = appRequire("node:inspector");
  const invokeHandlers = ipcMain?._invokeHandlers;
  if (
    typeof invokeHandlers?.get !== "function" ||
    typeof invokeHandlers?.set !== "function"
  ) {
    throw new Error("Electron ipcMain invoke-handler map is unavailable");
  }

  const inspectorArgPattern = /^--inspect(?:-brk|-wait|-port)?(?:=|$)/;
  const inheritedInspectorArgs = process.execArgv.filter((arg) =>
    inspectorArgPattern.test(arg),
  );
  process.execArgv.splice(
    0,
    process.execArgv.length,
    ...process.execArgv.filter((arg) => !inspectorArgPattern.test(arg)),
  );
  app?.commandLine?.removeSwitch?.("inspect");

  const state = {
    hookVersion,
    version:
      requestedMode === "inherit"
        ? hookVersion + ":inherit"
        : hookVersion + ":" + requestedModel + ":" + requestedReasoningEffort,
    installed: false,
    mode: requestedMode,
    model: requestedModel,
    reasoningEffort: requestedReasoningEffort,
    targetChannel: messageFromViewChannel,
    targetRegistered: false,
    voiceStartsSeen: 0,
    inheritedVoiceStarts: 0,
    rewrittenRequests: 0,
    lastMethod: null,
    lastThreadId: null,
    lastRequestId: null,
    lastOriginalModel: null,
    lastOriginalEffort: null,
    inheritedInspectorArgs,
  };
  let registrationPoll = null;
  let originalTargetHandler = null;
  let wrappedTargetHandler = null;
  Object.defineProperties(state, {
    closeInspector: {
      enumerable: false,
      value: () => inspector.close(),
    },
    setConfig: {
      enumerable: false,
      value: (nextMode, nextModel, nextReasoningEffort) => {
        state.mode = nextMode;
        state.model = nextModel;
        state.reasoningEffort = nextReasoningEffort;
        state.version =
          nextMode === "inherit"
            ? hookVersion + ":inherit"
            : hookVersion + ":" + nextModel + ":" + nextReasoningEffort;
      },
    },
    restore: {
      enumerable: false,
      value: () => {
        if (registrationPoll != null) clearInterval(registrationPoll);
        if (
          wrappedTargetHandler != null &&
          invokeHandlers.get(messageFromViewChannel) === wrappedTargetHandler
        ) {
          invokeHandlers.set(messageFromViewChannel, originalTargetHandler);
        }
        state.installed = false;
      },
    },
  });

  function rewriteVoiceThreadStart(message) {
    if (
      message == null ||
      typeof message !== "object" ||
      message.request?.params == null ||
      typeof message.request.params !== "object"
    ) {
      return message;
    }

    const request = message.request;
    const params = request.params;
    if (request.method !== "thread/start" || params.threadSource !== "realtime_voice") {
      return message;
    }

    state.voiceStartsSeen += 1;
    state.lastMethod = request.method;
    state.lastThreadId = params.threadId ?? null;
    state.lastRequestId = request.id ?? null;
    state.lastOriginalModel = params.model ?? null;
    state.lastOriginalEffort = params.config?.model_reasoning_effort ?? null;

    if (state.mode === "inherit") {
      state.inheritedVoiceStarts += 1;
      return message;
    }

    state.rewrittenRequests += 1;

    return {
      ...message,
      request: {
        ...request,
        params: {
          ...params,
          model: state.model,
          config: {
            ...(params.config ?? {}),
            model_reasoning_effort: state.reasoningEffort,
          },
        },
      },
    };
  }

  function installTargetHandler() {
    let listener = invokeHandlers.get(messageFromViewChannel);
    while (
      typeof listener === "function" &&
      listener.__chatgptVoiceWorkerOverride === true &&
      typeof listener.__chatgptVoiceWorkerOriginalHandler === "function"
    ) {
      listener = listener.__chatgptVoiceWorkerOriginalHandler;
    }
    if (typeof listener !== "function") return false;

    originalTargetHandler = listener;
    wrappedTargetHandler = function chatgptVoiceWorkerHandler(event, ...args) {
      if (args.length > 0) args[0] = rewriteVoiceThreadStart(args[0]);
      return Reflect.apply(listener, this, [event, ...args]);
    };
    Object.defineProperties(wrappedTargetHandler, {
      __chatgptVoiceWorkerOverride: { value: true },
      __chatgptVoiceWorkerOriginalHandler: { value: listener },
    });
    invokeHandlers.set(messageFromViewChannel, wrappedTargetHandler);
    state.targetRegistered = true;
    if (registrationPoll != null) clearInterval(registrationPoll);
    return true;
  }

  state.installed = true;
  globalThis[stateKey] = state;
  if (!installTargetHandler()) {
    registrationPoll = setInterval(installTargetHandler, 10);
  }
  return state;
})()
`;
const projectVoiceInstallerSource = String.raw`
(async () => {
  let appRequire = null;
  if (typeof require === "function") {
    appRequire = require;
  } else if (typeof process.mainModule?.require === "function") {
    appRequire = process.mainModule.require.bind(process.mainModule);
  } else if (typeof process.getBuiltinModule === "function") {
    const Module = process.getBuiltinModule("module");
    appRequire = Module.createRequire(
      process.resourcesPath + "/app.asar/package.json",
    );
  }
  if (appRequire == null) {
    throw new Error("Electron main-process module loader is unavailable");
  }
  const { BrowserWindow } = appRequire("electron");
  const fs = appRequire("node:fs");
  const inspector = appRequire("node:inspector");
  const path = appRequire("node:path");
  const stateKey = "__chatgptNativeProjectVoicePatchState";
  const version = ${JSON.stringify(projectVoicePatchVersion)};
  const progress = (step) => {
    globalThis.__chatgptVoiceInstallProgress = { step, version };
  };
  progress("start");
  const rendererSource = ${JSON.stringify(projectVoiceRendererTemplate)};
  const voiceDynamicTools = ${JSON.stringify(voiceDynamicTools)};
  const previous = globalThis[stateKey];
  if (previous?.version === version && previous?.installed === true) {
    return previous.publicState();
  }
  const previousHasAttachedDebugger = previous?.attachments?.some(
    (attachment) => attachment?.contents?.debugger?.isAttached?.() === true,
  );
  if (previousHasAttachedDebugger) {
    await previous.restore();
  } else if (previous) {
    previous.installed = false;
  }
  progress("previous-restored");
  const assetsPath = path.join(process.resourcesPath, "app.asar", "webview", "assets");
  const appInitialAsset = fs
    .readdirSync(assetsPath)
    .find((name) => /^app-initial-[A-Za-z0-9_-]+[.]js$/.test(name));
  if (!appInitialAsset) {
    throw new Error("ChatGPT app-initial renderer asset is unavailable");
  }
  const appInitialUrl = "app://-/assets/" + appInitialAsset;
  const appInitialSource = fs.readFileSync(path.join(assetsPath, appInitialAsset), "utf8");
  const findVoiceThreadFooterGate = ${findVoiceThreadFooterGate.toString()};
  const findVoiceStartRequestFunction = ${findVoiceStartRequestFunction.toString()};
  const findVoiceIntentMapper = ${findVoiceIntentMapper.toString()};
  const findVoiceCoordinator = ${findVoiceCoordinator.toString()};
  const findConversationStartBoundary = ${findConversationStartBoundary.toString()};
  const findExistingThreadVoiceGate = ${findExistingThreadVoiceGate.toString()};
  const findExistingThreadVoiceSourceGuard = ${findExistingThreadVoiceSourceGuard.toString()};
  const findExistingThreadPresentationGate = ${findExistingThreadPresentationGate.toString()};
  const findInterruptedResumeVoicePrecedence = ${findInterruptedResumeVoicePrecedence.toString()};
  const sourceLocationAt = ${sourceLocationAt.toString()};
  const voiceThreadFooterConditionFor = ${voiceThreadFooterConditionFor.toString()};
  const mainVoiceBreakpointConditionFor = ${mainVoiceBreakpointConditionFor.toString()};
  const overlayIntentBreakpointConditionFor = ${overlayIntentBreakpointConditionFor.toString()};
  const voiceCoordinatorConditionFor = ${voiceCoordinatorConditionFor.toString()};
  const conversationStartBoundaryConditionFor = ${conversationStartBoundaryConditionFor.toString()};
  const existingThreadVoiceConditionFor = ${existingThreadVoiceConditionFor.toString()};
  const existingThreadVoiceSourceConditionFor = ${existingThreadVoiceSourceConditionFor.toString()};
  const existingThreadPresentationConditionFor = ${existingThreadPresentationConditionFor.toString()};
  const interruptedResumeVoicePrecedenceConditionFor = ${interruptedResumeVoicePrecedenceConditionFor.toString()};
  const voiceThreadFooterGate = findVoiceThreadFooterGate(appInitialSource);
  if (voiceThreadFooterGate.matchCount !== 1) {
    throw new Error(
      "Expected one Voice thread footer gate, found " +
        voiceThreadFooterGate.matchCount,
    );
  }
  const voiceThreadFooterLocation = sourceLocationAt(
    appInitialSource,
    voiceThreadFooterGate.breakpointOffset,
  );
  const voiceThreadFooterCondition = voiceThreadFooterConditionFor(
    voiceThreadFooterGate.gateVariable,
    voiceThreadFooterGate.realtimeSessionVariable,
  );
  const existingThreadVoiceGate = findExistingThreadVoiceGate(appInitialSource);
  if (existingThreadVoiceGate.matchCount !== 1) {
    throw new Error(
      "Expected one existing-thread Voice gate, found " +
        existingThreadVoiceGate.matchCount,
    );
  }
  const existingThreadVoiceLocation = sourceLocationAt(
    appInitialSource,
    existingThreadVoiceGate.breakpointOffset,
  );
  const existingThreadVoiceCondition = existingThreadVoiceConditionFor(
    existingThreadVoiceGate,
  );
  const interruptedResumeVoicePrecedence = findInterruptedResumeVoicePrecedence(
    appInitialSource,
  );
  if (interruptedResumeVoicePrecedence.matchCount !== 1) {
    throw new Error(
      "Expected one interrupted-task Voice precedence gate, found " +
        interruptedResumeVoicePrecedence.matchCount,
    );
  }
  const interruptedResumeVoicePrecedenceLocation = sourceLocationAt(
    appInitialSource,
    interruptedResumeVoicePrecedence.breakpointOffset,
  );
  const interruptedResumeVoicePrecedenceCondition =
    interruptedResumeVoicePrecedenceConditionFor(
      interruptedResumeVoicePrecedence,
    );
  const existingThreadVoiceSourceGuard = findExistingThreadVoiceSourceGuard(
    appInitialSource,
  );
  if (existingThreadVoiceSourceGuard.matchCount !== 1) {
    throw new Error(
      "Expected one existing-thread Voice source guard, found " +
        existingThreadVoiceSourceGuard.matchCount,
    );
  }
  const existingThreadVoiceSourceLocation = sourceLocationAt(
    appInitialSource,
    existingThreadVoiceSourceGuard.breakpointOffset,
  );
  const existingThreadVoiceSourceCondition = existingThreadVoiceSourceConditionFor(
    existingThreadVoiceSourceGuard,
  );
  const voiceStartFunction = findVoiceStartRequestFunction(appInitialSource);
  if (voiceStartFunction.matchCount !== 1) {
    throw new Error(
      "Expected one Voice start request function, found " +
        voiceStartFunction.matchCount,
    );
  }
  const voiceIntentMapper = findVoiceIntentMapper(appInitialSource);
  if (voiceIntentMapper.matchCount !== 1) {
    throw new Error(
      "Expected one Voice intent mapper, found " + voiceIntentMapper.matchCount,
    );
  }
  const mainCondition = mainVoiceBreakpointConditionFor(voiceStartFunction);
  const overlayIntentCondition = overlayIntentBreakpointConditionFor(
    voiceIntentMapper,
  );
  const overlayIntentLocation = sourceLocationAt(
    appInitialSource,
    voiceIntentMapper.breakpointOffset,
  );
  const voiceCoordinator = findVoiceCoordinator(appInitialSource);
  if (voiceCoordinator.matchCount !== 1) {
    throw new Error(
      "Expected one Voice coordinator, found " + voiceCoordinator.matchCount,
    );
  }
  const voiceCoordinatorLocation = sourceLocationAt(
    appInitialSource,
    voiceCoordinator.breakpointOffset,
  );
  const voiceCoordinatorCondition = voiceCoordinatorConditionFor(
    voiceCoordinator,
    voiceDynamicTools,
  );
  const conversationStartBoundary = findConversationStartBoundary(
    appInitialSource,
  );
  if (conversationStartBoundary.matchCount !== 1) {
    throw new Error(
      "Expected one conversation-start boundary, found " +
        conversationStartBoundary.matchCount,
    );
  }
  const conversationStartBoundaryLocation = sourceLocationAt(
    appInitialSource,
    conversationStartBoundary.breakpointOffset,
  );
  const conversationStartBoundaryCondition =
    conversationStartBoundaryConditionFor(
      conversationStartBoundary,
      voiceDynamicTools,
    );
  const buildPath = path.join(process.resourcesPath, "app.asar", ".vite", "build");
  const mainAssets = fs.readdirSync(buildPath).filter((name) => name.endsWith(".js"));
  const mainMatches = mainAssets.flatMap((name) => {
    const source = fs.readFileSync(path.join(buildPath, name), "utf8");
    const gate = findExistingThreadPresentationGate(source);
    return gate.matchCount === 1 ? [{ name, source, gate }] : [];
  });
  if (mainMatches.length !== 1) {
    throw new Error(
      "Expected one existing-thread presentation gate, found " + mainMatches.length,
    );
  }
  const mainAsset = mainMatches[0].name;
  const existingThreadPresentationGate = mainMatches[0].gate;
  const existingThreadPresentationLocation = sourceLocationAt(
    mainMatches[0].source,
    existingThreadPresentationGate.breakpointOffset,
  );
  const existingThreadPresentationCondition = existingThreadPresentationConditionFor(
    existingThreadPresentationGate,
  );
  progress("source-gates-resolved");
  const windows = BrowserWindow.getAllWindows().filter(
    (window) =>
      !window.webContents.isDestroyed() &&
      window.webContents.getURL().startsWith("app://-/index.html"),
  );
  const mainWindow = windows.find(
    (window) => !window.webContents.getURL().includes("initialRoute=%2Favatar-overlay"),
  );
  const overlayWindow = windows.find((window) =>
    window.webContents.getURL().includes("initialRoute=%2Favatar-overlay"),
  );
  if (!mainWindow || !overlayWindow) {
    throw new Error("ChatGPT main and avatar-overlay windows must both be loaded");
  }
  const contextResult = await mainWindow.webContents.executeJavaScript(
    rendererSource,
    true,
  );
  progress("renderer-context-installed");
  if (contextResult?.installed !== true) {
    throw new Error(
      "Project Voice context resolver did not install: " + JSON.stringify(contextResult),
    );
  }

  const attachments = [];
  const breakpointIds = [];
  const attach = async (contents, label) => {
    if (contents.debugger.isAttached()) {
      throw new Error("Cannot install project Voice breakpoints; debugger already attached to " + label);
    }
    contents.debugger.attach("1.3");
    attachments.push({ contents, label });
    await contents.debugger.sendCommand("Runtime.enable");
    await contents.debugger.sendCommand("Debugger.enable");
    return contents.debugger;
  };
  const functionObjectId = async (debuggerApi, exportName) => {
    const evaluated = await debuggerApi.sendCommand("Runtime.evaluate", {
      expression:
        "import(" + JSON.stringify(appInitialUrl) + ").then((module) => {" +
          "const direct=module[" + JSON.stringify(exportName) + "];" +
          "if(typeof direct==='function')return direct;" +
          "const name=" + JSON.stringify(exportName) + ";" +
          "return Object.values(module).find((candidate)=>{" +
            "if(typeof candidate!=='function')return false;" +
            "const source=Function.prototype.toString.call(candidate);" +
            "return source.startsWith('function '+name+'(')||source.startsWith('async function '+name+'(');" +
          "});" +
        "})",
      awaitPromise: true,
      returnByValue: false,
    });
    const objectId = evaluated?.result?.objectId;
    if (!objectId || evaluated.result.type !== "function") {
      throw new Error("ChatGPT export " + exportName + " is not an inspectable function");
    }
    return objectId;
  };
  const proveConditionalMutation = async (debuggerApi, label) => {
    const probe = await debuggerApi.sendCommand("Runtime.evaluate", {
      expression:
        "globalThis.__chatgptProjectVoiceBreakpointProbe=function(e,t){return t}",
      returnByValue: false,
    });
    const objectId = probe?.result?.objectId;
    if (!objectId) throw new Error("Could not create breakpoint probe in " + label);
    const breakpoint = await debuggerApi.sendCommand(
      "Debugger.setBreakpointOnFunctionCall",
      { objectId, condition: "(t.value=7,false)" },
    );
    const result = await debuggerApi.sendCommand("Runtime.evaluate", {
      expression: "globalThis.__chatgptProjectVoiceBreakpointProbe({},{}).value",
      returnByValue: true,
    });
    await debuggerApi.sendCommand("Debugger.removeBreakpoint", {
      breakpointId: breakpoint.breakpointId,
    });
    await debuggerApi.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
    await debuggerApi.sendCommand("Runtime.evaluate", {
      expression: "delete globalThis.__chatgptProjectVoiceBreakpointProbe",
      returnByValue: true,
    });
    if (result?.result?.value !== 7) {
      throw new Error("Conditional function breakpoint mutation failed in " + label);
    }
  };
  const installBreakpoint = async (debuggerApi, exportName, condition) => {
    const objectId = await functionObjectId(debuggerApi, exportName);
    try {
      const installed = await debuggerApi.sendCommand(
        "Debugger.setBreakpointOnFunctionCall",
        { objectId, condition },
      );
      breakpointIds.push({ debuggerApi, breakpointId: installed.breakpointId });
    } finally {
      await debuggerApi.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  };
  const installSourceBreakpoint = async (debuggerApi, url, location, condition) => {
    const installed = await debuggerApi.sendCommand("Debugger.setBreakpointByUrl", {
      url,
      lineNumber: location.lineNumber,
      columnNumber: location.columnNumber,
      condition,
    });
    if (!Array.isArray(installed.locations) || installed.locations.length === 0) {
      throw new Error("Voice source breakpoint did not resolve");
    }
    breakpointIds.push({ debuggerApi, breakpointId: installed.breakpointId });
    return installed.locations[0];
  };

  let voiceThreadFooterBreakpointLocation = null;
  let existingThreadVoiceBreakpointLocation = null;
  let interruptedResumeVoiceBreakpointLocation = null;
  let existingThreadVoiceSourceBreakpointLocation = null;
  let voiceCoordinatorBreakpointLocation = null;
  let conversationStartBoundaryBreakpointLocation = null;
  let existingThreadPresentationBreakpointLocation = null;
  let mainProcessBreakpointId = null;
  let mainProcessInspector = null;
  let mainPost = null;
  try {
    globalThis.__chatgptNativeProjectVoiceMainState = {
      existingThreadOverlayStarts: 0,
      lastSource: null,
    };
    mainProcessInspector = new inspector.Session();
    mainProcessInspector.connect();
    mainPost = (method, params = {}) =>
      new Promise((resolve, reject) => {
        mainProcessInspector.post(method, params, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
      });
    await mainPost("Debugger.enable");
    const mainBreakpoint = await mainPost("Debugger.setBreakpointByUrl", {
      urlRegex: mainAsset.replaceAll(".", "[.]") + "$",
      lineNumber: existingThreadPresentationLocation.lineNumber,
      columnNumber: existingThreadPresentationLocation.columnNumber,
      condition: existingThreadPresentationCondition,
    });
    if (!Array.isArray(mainBreakpoint.locations) || mainBreakpoint.locations.length === 0) {
      throw new Error("Existing-thread presentation breakpoint did not resolve");
    }
    mainProcessBreakpointId = mainBreakpoint.breakpointId;
    existingThreadPresentationBreakpointLocation = mainBreakpoint.locations[0];
    progress("existing-thread-presentation-breakpoint-installed");
    const mainDebugger = await attach(mainWindow.webContents, "the main window");
    progress("main-debugger-attached");
    const overlayDebugger = await attach(overlayWindow.webContents, "the avatar overlay");
    progress("overlay-debugger-attached");
    await proveConditionalMutation(mainDebugger, "the main window");
    progress("main-debugger-proved");
    await proveConditionalMutation(overlayDebugger, "the avatar overlay");
    progress("overlay-debugger-proved");
    await mainDebugger.sendCommand("Runtime.evaluate", {
      expression:
        "globalThis.__chatgptNativeProjectVoiceBreakpointState={mainHandoffs:0,voiceFooterGateHits:0,existingThreadVoiceGateHits:0,existingThreadHandoffCompletions:0,interruptedResumeOverrides:0,lastExistingThreadId:null}",
      returnByValue: true,
    });
    await overlayDebugger.sendCommand("Runtime.evaluate", {
      expression:
        "globalThis.__chatgptNativeProjectVoiceBreakpointState={overlayIntents:0,coordinatorRewrites:0,threadRewrites:0,modelRewrites:0,dynamicToolRewrites:0,lastProjectContext:null,lastVoiceWorkerSelection:null,lastDynamicTools:null}",
      returnByValue: true,
    });
    await installBreakpoint(
      mainDebugger,
      voiceStartFunction.functionName,
      mainCondition,
    );
    progress("main-handoff-breakpoint-installed");
    voiceThreadFooterBreakpointLocation = await installSourceBreakpoint(
      mainDebugger,
      appInitialUrl,
      voiceThreadFooterLocation,
      voiceThreadFooterCondition,
    );
    progress("voice-footer-breakpoint-installed");
    existingThreadVoiceBreakpointLocation = await installSourceBreakpoint(
      mainDebugger,
      appInitialUrl,
      existingThreadVoiceLocation,
      existingThreadVoiceCondition,
    );
    progress("existing-thread-ui-breakpoint-installed");
    interruptedResumeVoiceBreakpointLocation = await installSourceBreakpoint(
      mainDebugger,
      appInitialUrl,
      interruptedResumeVoicePrecedenceLocation,
      interruptedResumeVoicePrecedenceCondition,
    );
    progress("interrupted-resume-voice-breakpoint-installed");
    existingThreadVoiceSourceBreakpointLocation = await installSourceBreakpoint(
      overlayDebugger,
      appInitialUrl,
      existingThreadVoiceSourceLocation,
      existingThreadVoiceSourceCondition,
    );
    progress("existing-thread-source-breakpoint-installed");
    await installSourceBreakpoint(
      overlayDebugger,
      appInitialUrl,
      overlayIntentLocation,
      overlayIntentCondition,
    );
    progress("overlay-intent-breakpoint-installed");
    voiceCoordinatorBreakpointLocation = await installSourceBreakpoint(
      overlayDebugger,
      appInitialUrl,
      voiceCoordinatorLocation,
      voiceCoordinatorCondition,
    );
    progress("voice-coordinator-breakpoint-installed");
    conversationStartBoundaryBreakpointLocation = await installSourceBreakpoint(
      overlayDebugger,
      appInitialUrl,
      conversationStartBoundaryLocation,
      conversationStartBoundaryCondition,
    );
    progress("conversation-start-boundary-breakpoint-installed");
  } catch (error) {
    for (const item of breakpointIds.reverse()) {
      await item.debuggerApi.sendCommand("Debugger.removeBreakpoint", {
        breakpointId: item.breakpointId,
      }).catch(() => {});
    }
    for (const attachment of attachments.reverse()) {
      if (attachment.contents.debugger.isAttached()) attachment.contents.debugger.detach();
    }
    if (mainProcessBreakpointId != null && mainPost != null) {
      await mainPost("Debugger.removeBreakpoint", {
        breakpointId: mainProcessBreakpointId,
      }).catch(() => {});
    }
    mainProcessInspector?.disconnect();
    await mainWindow.webContents.executeJavaScript(
      "window.__chatgptNativeProjectVoiceContextState?.dispose?.(); true",
      true,
    ).catch(() => {});
    throw error;
  }

  const state = {
    version,
    installed: true,
    attachments,
    breakpointIds,
    mainProcessBreakpointId,
    mainProcessInspector,
    mainPost,
    async restore() {
      for (const item of [...state.breakpointIds].reverse()) {
        await item.debuggerApi.sendCommand("Debugger.removeBreakpoint", {
          breakpointId: item.breakpointId,
        }).catch(() => {});
      }
      for (const attachment of [...state.attachments].reverse()) {
        if (!attachment.contents.isDestroyed() && attachment.contents.debugger.isAttached()) {
          attachment.contents.debugger.detach();
        }
      }
      if (state.mainProcessBreakpointId != null && state.mainPost != null) {
        await state.mainPost("Debugger.removeBreakpoint", {
          breakpointId: state.mainProcessBreakpointId,
        }).catch(() => {});
      }
      state.mainProcessInspector?.disconnect();
      globalThis.__chatgptNativeProjectVoiceMainState = null;
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.webContents.isDestroyed()) continue;
        await window.webContents.executeJavaScript(
          "window.__chatgptNativeProjectVoiceContextState?.dispose?.(); globalThis.__chatgptActiveVoiceProjectContext=null; true",
          true,
        ).catch(() => {});
      }
      state.installed = false;
    },
    publicState() {
      return {
        installed: state.installed,
        inactivityTimeoutMs: contextResult.inactivityTimeoutMs ?? null,
        voiceCaptureConstraints: contextResult.voiceCaptureConstraints ?? null,
        voiceDynamicTools: ${JSON.stringify(voiceDynamicTools)},
        voiceCoordinatorLocation: voiceCoordinatorBreakpointLocation,
        conversationStartBoundaryLocation:
          conversationStartBoundaryBreakpointLocation,
        projectContext: contextResult.projectContext ?? null,
        status: state.installed ? "ready" : "stopped",
        version: state.version,
        breakpoints: state.breakpointIds.length,
        voiceModelPicker: {
          enabled: true,
          location: voiceThreadFooterBreakpointLocation,
        },
        existingThreadVoice: {
          enabled: true,
          presentation: "global-overlay",
          presentationLocation: existingThreadPresentationBreakpointLocation,
          uiLocation: existingThreadVoiceBreakpointLocation,
          interruptedResumeLocation: interruptedResumeVoiceBreakpointLocation,
          sourceGuardLocation: existingThreadVoiceSourceBreakpointLocation,
        },
      };
    },
  };
  globalThis[stateKey] = state;
  progress("state-committed");
  progress("complete");
  return state.publicState();
})()
`;
const projectVoiceCleanupSource = String.raw`
(async () => {
  const appRequire = typeof require === "function"
    ? require
    : process.mainModule?.require?.bind(process.mainModule);
  if (!appRequire) return false;
  const { BrowserWindow } = appRequire("electron");
  await globalThis.__chatgptNativeProjectVoicePatchState?.restore?.();
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents;
    if (contents.isDestroyed()) continue;
    await contents.executeJavaScript(
      "window.__chatgptProjectVoiceRoutingOverrideState?.dispose?.(); window.__chatgptNativeProjectVoiceContextState?.dispose?.(); globalThis.__chatgptActiveVoiceProjectContext=null; true",
      true,
    ).catch(() => {});
  }
  return true;
})()
`;

async function main() {
  if (selfTest) {
    runOverrideSelfTest();
    runVoiceThreadFooterGateSelfTest();
    await runExistingThreadVoiceGateSelfTest();
    await runProjectVoiceRendererSelfTest();
    return;
  }

  if (validateOnly) {
    if (voiceWorkerMode === "inherit") {
      console.log(
        "Validated per-chat Voice worker selection: each fresh Voice task inherits the model and reasoning selected in its new-chat composer.",
      );
    } else {
      console.log(
        `Validated pinned Voice worker config: ${model} with ${reasoningEffort} reasoning (${voiceWorker.catalogPath}).`,
      );
    }
    return;
  }

  const target = await waitForInspectorTarget();
  const connection = await openInspectorConnection(target.webSocketDebuggerUrl);
  activeConnection = connection;

  try {
    await connection.send("Runtime.enable", {});
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: overrideSource,
      returnByValue: true,
    });
    const state = evaluated?.result?.value;
    if (state?.installed !== true) {
      throw new Error(`Main-process request override did not install: ${JSON.stringify(state)}`);
    }

    await waitForTargetRegistration(connection);
    let projectVoiceState = null;
    if (projectVoiceRoutingEnabled) {
      const projectVoiceEvaluation = await connection.send("Runtime.evaluate", {
        expression: projectVoiceInstallerSource,
        awaitPromise: true,
        returnByValue: true,
      });
      projectVoiceState = projectVoiceEvaluation?.result?.value;
      if (projectVoiceState?.installed !== true) {
        throw new Error(
          `Dynamic project Voice routing did not install: ${JSON.stringify(projectVoiceState)}`,
        );
      }
    } else {
      await connection.send("Runtime.evaluate", {
        expression: projectVoiceCleanupSource,
        awaitPromise: true,
        returnByValue: true,
      });
    }
    if (voiceWorkerMode === "inherit") {
      console.log(
        "Installed per-chat Voice worker selection; fresh Voice tasks preserve the model and reasoning selected in the composer.",
      );
    } else {
      console.log(
        `Installed pinned Voice worker override: ${model} (${reasoningEffort} reasoning).`,
      );
    }
    console.log("Wrapped only the registered message-from-view IPC handler; ordinary tasks and resumed Voice tasks remain untouched.");
    if (projectVoiceState) {
      console.log(
        `Installed dynamic project Voice routing for ${projectVoiceState.projectContext?.label ?? "the active project"}.`,
      );
      console.log(
        `Installed fixed Voice inactivity timeout: ${projectVoiceState.inactivityTimeoutMs / 60000} minutes.`,
      );
      console.log(
        `Installed Voice microphone processing: ${Object.keys(projectVoiceState.voiceCaptureConstraints ?? {}).join(", ")}.`,
      );
      console.log(
        "Installed Voice dynamic tools: Appshots, speak_to_user, end_realtime_voice_call.",
      );
      console.log("Installed native Voice launch for ordinary existing tasks.");
    } else {
      console.log("Dynamic project Voice routing is disabled; native Voice remains untouched.");
    }
    await connection
      .send("Runtime.evaluate", {
        expression:
          "setTimeout(() => globalThis.__chatgptVoiceWorkerRequestOverrideState?.closeInspector?.(), 1000); true",
        returnByValue: true,
      })
      .catch(() => {});
    console.log("Main-process debugger detached; ChatGPT can continue normally.");
  } catch (error) {
    await connection
      .send("Runtime.evaluate", {
        expression: projectVoiceCleanupSource,
        awaitPromise: true,
        returnByValue: true,
      })
      .catch(() => {});
    await connection
      .send("Runtime.evaluate", {
        expression:
          "globalThis.__chatgptVoiceWorkerRequestOverrideState?.restore?.(); true",
        returnByValue: true,
      })
      .catch(() => {});
    throw error;
  } finally {
    connection.close();
    activeConnection = null;
  }
}

function runVoiceThreadFooterGateSelfTest() {
  const source =
    'function g(){let{realtimeSession:r,waveformCanvasRef:w}=state,gated=r.isVoiceThread||r.thread.phase!==`inactive`,[a,b]=useState(0);jo(nD,q??null);return gated?null:footer()}';
  const gate = findVoiceThreadFooterGate(source);
  assert.equal(gate.matchCount, 1);
  assert.equal(gate.gateVariable, "gated");
  assert.equal(gate.realtimeSessionVariable, "r");
  assert.equal(source.slice(gate.breakpointOffset, gate.breakpointOffset + 6), "jo(nD,");
  assert.deepEqual(sourceLocationAt("first\n" + source, gate.breakpointOffset + 6), {
    lineNumber: 1,
    columnNumber: gate.breakpointOffset,
  });
  assert.equal(findVoiceThreadFooterGate("const compact = true").matchCount, 0);
  const condition = voiceThreadFooterConditionFor(
    gate.gateVariable,
    gate.realtimeSessionVariable,
  );
  const voiceContext = {
    gated: true,
    r: { isVoiceThread: true, thread: { phase: "inactive" } },
    globalThis: {
      __chatgptNativeProjectVoiceBreakpointState: {
        voiceFooterGateHits: 0,
      },
    },
  };
  runInNewContext(condition, voiceContext);
  assert.equal(voiceContext.gated, false);
  assert.equal(
    voiceContext.globalThis.__chatgptNativeProjectVoiceBreakpointState
      .voiceFooterGateHits,
    1,
  );
  const ordinaryContext = {
    gated: false,
    r: { isVoiceThread: false, thread: { phase: "inactive" } },
    globalThis: {
      __chatgptNativeProjectVoiceBreakpointState: {
        voiceFooterGateHits: 0,
      },
    },
  };
  runInNewContext(condition, ordinaryContext);
  assert.equal(ordinaryContext.gated, false);
  assert.equal(
    ordinaryContext.globalThis.__chatgptNativeProjectVoiceBreakpointState
      .voiceFooterGateHits,
    0,
  );
  const actionSource =
    'if(active){button=stop}else if(resumeLoading||conversationId!=null&&threadStatus===`interrupted`&&!submitting&&!hidden&&!blocked&&composerState===`empty-message`){button=resume}else if(voiceControl.isStartButtonVisible){button=voice}';
  const precedence = findInterruptedResumeVoicePrecedence(actionSource);
  assert.equal(precedence.matchCount, 1);
  const precedenceContext = {
    resumeLoading: true,
    threadStatus: "interrupted",
    voiceControl: { isStartButtonVisible: true },
    globalThis: {
      __chatgptNativeProjectVoiceBreakpointState: {
        interruptedResumeOverrides: 0,
      },
    },
  };
  runInNewContext(
    interruptedResumeVoicePrecedenceConditionFor(precedence),
    precedenceContext,
  );
  assert.equal(precedenceContext.resumeLoading, false);
  assert.equal(precedenceContext.threadStatus, "voice-ready");
  assert.equal(
    precedenceContext.globalThis.__chatgptNativeProjectVoiceBreakpointState
      .interruptedResumeOverrides,
    1,
  );
  console.log(
    "Voice footer gate self-test passed: Voice threads retain native footer controls and Voice takes precedence over Resume when both actions are available.",
  );
}

async function runExistingThreadVoiceGateSelfTest() {
  const voiceRuntimeSource =
    'async function bhs(e,t,n){let r=e.get(hY);if(r!=null&&r.phase!==`failed`&&t.source!==`composer_button_new_thread`)return;let i=crypto.randomUUID();await Mp.realtimeVoiceRuntime.requestRealtimeStart(t,i)}function Sys(e,t){switch(e.source){case`composer_button_existing_thread`:return{type:`exact`,locator:e.locator};case`composer_button_new_thread`:return{type:`new`,hostId:t};case`avatar_overlay_button_new_thread`:return{type:`resume`,hostId:t}}}';
  const voiceStartFunction = findVoiceStartRequestFunction(voiceRuntimeSource);
  assert.deepEqual(voiceStartFunction, {
    functionName: "bhs",
    matchCount: 1,
    requestVariable: "t",
  });
  const voiceIntentMapper = findVoiceIntentMapper(voiceRuntimeSource);
  assert.equal(voiceIntentMapper.functionName, "Sys");
  assert.equal(voiceIntentMapper.matchCount, 1);
  assert.equal(voiceIntentMapper.requestVariable, "e");
  assert.equal(
    voiceRuntimeSource.startsWith("switch(", voiceIntentMapper.breakpointOffset),
    true,
  );
  const source =
    'function hook({conversationId:e,executionTargetCwd:t,executionTargetHostId:n,isComposerInputVisible:r,onStartNewConversation:i,onTranscriptChange:a}){let o=Vo(Q),p=compact(),m=Y(Ux),h=Y(_X),g=e!=null&&lts(h,e,n)&&h.phase!==`failed`,_=m.phase!==`inactive`&&e!=null&&m.locator.conversationId===e&&m.locator.hostId===n?m:null,v=g?`inactive`:_?.phase??p.phase,D=(i!=null||u&&e!=null)&&l&&navigator.mediaDevices?.getUserMedia!=null&&typeof RTCPeerConnection<`u`,O=$m(async()=>{if(u&&e!=null){await start(e)}else await i?.()});return{isStartAvailable:D,isSubmitStarting:T||g||v===`starting`,isVoiceThread:u,startConversation:O,thread:w,visiblePhase:!r||v===`inactive`?null:v}}';
  const gate = findExistingThreadVoiceGate(source);
  assert.equal(gate.matchCount, 1);
  assert.equal(gate.availabilityVariable, "D");
  assert.equal(gate.conversationIdVariable, "e");
  assert.equal(gate.featureEnabledVariable, "l");
  assert.equal(gate.hostIdVariable, "n");
  assert.equal(gate.isVoiceThreadVariable, "u");
  assert.equal(gate.activeSessionVariable, "_");
  assert.equal(gate.launchPendingVariable, "g");
  assert.equal(gate.launchStateAtom, "_X");
  assert.equal(gate.phaseVariable, "v");
  assert.equal(gate.storeVariable, "o");
  assert.equal(
    source.startsWith("return{isStartAvailable:D", gate.breakpointOffset),
    true,
  );
  assert.equal(findExistingThreadVoiceGate("const unrelated = true").matchCount, 0);

  const condition = existingThreadVoiceConditionFor(gate);
  const clearedLaunchStates = [];
  const existingThread = {
    _: { phase: "active" },
    _X: "launch-state-atom",
    D: false,
    e: "existing-thread-id",
    g: true,
    l: true,
    n: "local-host",
    o: {
      set(atom, value) {
        clearedLaunchStates.push({ atom, value });
      },
    },
    u: false,
    v: "inactive",
    navigator: { mediaDevices: { getUserMedia() {} } },
    RTCPeerConnection() {},
    globalThis: {
      __chatgptNativeProjectVoiceBreakpointState: {
        existingThreadHandoffCompletions: 0,
        existingThreadVoiceGateHits: 0,
        lastExistingThreadId: null,
      },
    },
  };
  runInNewContext(condition, existingThread);
  assert.equal(existingThread.D, true);
  assert.equal(existingThread.g, false);
  assert.equal(existingThread.u, true);
  assert.equal(existingThread.v, "active");
  assert.deepEqual(clearedLaunchStates, [
    { atom: "launch-state-atom", value: null },
  ]);
  assert.equal(
    existingThread.globalThis.__chatgptNativeProjectVoiceBreakpointState
      .existingThreadHandoffCompletions,
    1,
  );
  assert.equal(
    existingThread.globalThis.__chatgptNativeProjectVoiceBreakpointState
      .existingThreadVoiceGateHits,
    1,
  );
  assert.equal(
    existingThread.globalThis.__chatgptNativeProjectVoiceBreakpointState
      .lastExistingThreadId,
    "existing-thread-id",
  );
  const newThread = {
    D: false,
    e: null,
    l: true,
    n: "local-host",
    u: false,
    v: "inactive",
    navigator: { mediaDevices: { getUserMedia() {} } },
    RTCPeerConnection() {},
    globalThis: {
      __chatgptNativeProjectVoiceBreakpointState: {
        existingThreadHandoffCompletions: 0,
        existingThreadVoiceGateHits: 0,
        lastExistingThreadId: null,
      },
    },
  };
  runInNewContext(condition, newThread);
  assert.equal(newThread.D, false);
  assert.equal(newThread.u, false);
  assert.equal(
    newThread.globalThis.__chatgptNativeProjectVoiceBreakpointState
      .existingThreadVoiceGateHits,
    0,
  );

  const managerSource =
    'async open(e){let{conversationId:t,hostId:n}=e;let{threadSource:r}=await Rf(`maybe-resume-conversation`,{hostId:n,conversationId:t,model:null,workspaceRoots:[`/`]});if(r!==`realtime_voice`)throw Error(`This thread is not a voice chat`);return{locator:e}}';
  const sourceGuard = findExistingThreadVoiceSourceGuard(managerSource);
  assert.equal(sourceGuard.matchCount, 1);
  assert.equal(sourceGuard.conversationIdVariable, "t");
  assert.equal(sourceGuard.requestFunction, "Rf");
  assert.equal(sourceGuard.threadSourceVariable, "r");
  assert.equal(
    managerSource.startsWith("if(r!==`realtime_voice`)", sourceGuard.breakpointOffset),
    true,
  );
  assert.equal(
    findExistingThreadVoiceSourceGuard("const unrelated = true").matchCount,
    0,
  );
  const sourceCondition = existingThreadVoiceSourceConditionFor(sourceGuard);
  const ordinarySource = {
    r: "cli",
    t: "existing-thread-id",
    globalThis: {
      __chatgptNativeProjectVoiceBreakpointState: {
        existingThreadSourceOverrides: 0,
        lastExistingThreadId: null,
      },
    },
  };
  runInNewContext(sourceCondition, ordinarySource);
  assert.equal(ordinarySource.r, "realtime_voice");
  assert.equal(
    ordinarySource.globalThis.__chatgptNativeProjectVoiceBreakpointState
      .existingThreadSourceOverrides,
    1,
  );
  assert.equal(
    ordinarySource.globalThis.__chatgptNativeProjectVoiceBreakpointState
      .lastExistingThreadId,
    "existing-thread-id",
  );

  const mainSource =
    'class Voice{async requestStart(e,t,r){let i=t.source===`composer_button_new_thread`||t.source===`composer_button_existing_thread`,a=null;if(i){a={launchId:r,origin:e}}let c=!i,l=++this.sessionGeneration;this.pendingStart={...t,preferredPresentationSurface:i?`main-thread`:`global-overlay`}}}';
  const presentationGate = findExistingThreadPresentationGate(mainSource);
  assert.equal(presentationGate.matchCount, 1);
  assert.equal(presentationGate.mainWindowLaunchVariable, "i");
  assert.equal(presentationGate.requestVariable, "t");
  assert.equal(
    mainSource.startsWith("let c=!i,", presentationGate.breakpointOffset),
    true,
  );
  const presentationCondition = existingThreadPresentationConditionFor(
    presentationGate,
  );
  const presentationContext = {
    i: true,
    t: { source: "composer_button_existing_thread" },
    globalThis: {
      __chatgptNativeProjectVoiceMainState: {
        existingThreadOverlayStarts: 0,
        lastSource: null,
      },
    },
  };
  runInNewContext(presentationCondition, presentationContext);
  assert.equal(presentationContext.i, false);
  assert.equal(
    presentationContext.globalThis.__chatgptNativeProjectVoiceMainState
      .existingThreadOverlayStarts,
    1,
  );
  console.log(
    "Existing-thread Voice gate self-test passed: ordinary tasks gain the native Voice path, retain exact-thread routing, start on the global overlay, and clear the launch handoff once active.",
  );
}

async function runProjectVoiceRendererSelfTest() {
  class FakeElement {}
  const projectId = "project-selected-at-click-time";
  const cwd = "/tmp/project-selected-at-click-time";
  const composer = new FakeElement();
  const projectRow = new FakeElement();
  const modelPicker = new FakeElement();
  composer.__reactFiber$test = {
    memoizedProps: { selectedProject: { projectId, type: "local" } },
    pendingProps: null,
    return: null,
  };
  projectRow.dataset = { appActionSidebarProjectId: projectId };
  projectRow.__reactFiber$test = {
    memoizedProps: {
      group: {
        projectId,
        projectKind: "local",
        label: "selected-project",
        path: cwd,
        rootPaths: [cwd, `${cwd}/secondary-root`],
      },
    },
    pendingProps: null,
    return: null,
  };
  modelPicker.__reactFiber$test = {
    memoizedProps: { "data-selected-reasoning-effort": "xhigh" },
    pendingProps: null,
    return: {
      memoizedProps: {
        model: "xai/grok-4.5",
        reasoningEffort: "xhigh",
        onSelectModel() {},
        onSelectReasoningEffort() {},
      },
      pendingProps: null,
      return: null,
    },
  };
  let projectComposerVisible = false;
  const listeners = new Map();
  const document = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    querySelector(selector) {
      return selector === "[data-codex-composer-root]" && projectComposerVisible
        ? composer
        : null;
    },
    querySelectorAll(selector) {
      if (!projectComposerVisible) return [];
      if (selector === "[data-app-action-sidebar-project-row]") return [projectRow];
      if (selector === "[data-selected-reasoning-effort]") return [modelPicker];
      return [];
    },
  };
  const scheduledTimeouts = [];
  const mediaRequests = [];
  const originalSetTimeout = (callback, delay, ...args) => {
    scheduledTimeouts.push({ args, callback, delay });
    return scheduledTimeouts.length;
  };
  const originalGetUserMedia = async constraints => {
    mediaRequests.push(constraints);
    return { constraints };
  };
  const context = {
    document,
    Element: FakeElement,
    navigator: { mediaDevices: { getUserMedia: originalGetUserMedia } },
    setTimeout: originalSetTimeout,
  };
  context.window = context;
  context.globalThis = context;
  const installed = await runInNewContext(projectVoiceRendererTemplate, context);
  assert.equal(installed.installed, true);
  assert.equal(installed.projectContext, null);
  const state = context.__chatgptNativeProjectVoiceContextState;
  assert.equal(installed.inactivityTimeoutMs, 300_000);
  context.setTimeout(() => {}, 123);
  context.setTimeout(() => runtime.stopRealtimeForAutoEnd(store), 123);
  assert.equal(scheduledTimeouts[0].delay, 123);
  assert.equal(scheduledTimeouts[1].delay, 300_000);
  await context.navigator.mediaDevices.getUserMedia({ audio: { deviceId: "dictation" } });
  await context.navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, deviceId: "voice", noiseSuppression: true },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(mediaRequests[0])), {
    audio: { deviceId: "dictation" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(mediaRequests[1])), {
    audio: {
      autoGainControl: true,
      channelCount: 1,
      deviceId: "voice",
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: true,
    },
  });
  projectComposerVisible = true;
  listeners.get("pointerdown")();
  projectComposerVisible = false;
  const selectedProject = context.__chatgptNativeProjectVoiceContext();
  assert.deepEqual(JSON.parse(JSON.stringify(selectedProject)), {
    projectId,
    cwd,
    workspaceRoots: [cwd, `${cwd}/secondary-root`],
    label: "selected-project",
    projectAssignment: {
      projectKind: "local",
      projectId,
      path: cwd,
      cwd,
      pendingCoreUpdate: false,
    },
    voiceWorkerSelection: {
      model: "xai/grok-4.5",
      reasoningEffort: "xhigh",
    },
  });
  state.dispose();
  assert.equal(context.__chatgptNativeProjectVoiceContext, undefined);
  assert.equal(listeners.size, 0);
  assert.equal(context.setTimeout, originalSetTimeout);
  assert.equal(context.navigator.mediaDevices.getUserMedia, originalGetUserMedia);

  const breakpointState = {
    mainHandoffs: 0,
    overlayIntents: 0,
    coordinatorRewrites: 0,
    threadRewrites: 0,
    modelRewrites: 0,
    lastProjectContext: null,
    lastVoiceWorkerSelection: null,
    dynamicToolRewrites: 0,
    lastDynamicTools: null,
  };
  const request = { source: "composer_button_new_thread" };
  runInNewContext(
    mainVoiceBreakpointConditionFor({ requestVariable: "t" }),
    {
    t: request,
    globalThis: {
      __chatgptNativeProjectVoiceContext: () => selectedProject,
      __chatgptNativeProjectVoiceBreakpointState: breakpointState,
    },
    },
  );
  assert.deepEqual(request.projectContext, selectedProject);
  runInNewContext(
    overlayIntentBreakpointConditionFor({ requestVariable: "e" }),
    {
    e: request,
    globalThis: {
      __chatgptActiveVoiceProjectContext: null,
      __chatgptNativeProjectVoiceBreakpointState: breakpointState,
    },
    },
  );
  const startParams = {
    collaborationMode: {
      mode: "default",
      settings: {
        developer_instructions: "preserve me",
        model: "gpt-5.6-terra",
        reasoning_effort: "low",
      },
    },
    cwd: "/tmp/projectless",
    workspaceRoots: [],
    workspaceKind: "projectless",
    projectlessOutputDirectory: "/tmp/output",
    threadSource: "realtime_voice",
  };
  const overlayGlobal = {
    __chatgptActiveVoiceProjectContext: selectedProject,
    __chatgptNativeProjectVoiceBreakpointState: breakpointState,
  };
  const coordinatorSource =
    'async function jys({activeCollaborationMode:e,activateRealtimeConversation:t,agentMode:n,currentLocalExecutionCwd:r,intent:i,memoryPreferences:a,onStartError:o,permissionProfileId:s,serviceTier:c,shouldSendPermissionOverrides:l,scope:u,treatment:d,threadToolsEnabled:f,workspaceRootsForLocalExecution:p}){try{return run(r,p,d)}}';
  const coordinator = findVoiceCoordinator(coordinatorSource);
  assert.equal(coordinator.matchCount, 1);
  const coordinatorContext = {
    r: "/tmp/projectless",
    p: [],
    d: {
      dynamicTools: {},
      newThread: {
        model: "gpt-5.6-terra",
        reasoningEffort: "low",
      },
    },
    globalThis: overlayGlobal,
  };
  runInNewContext(
    voiceCoordinatorConditionFor(coordinator, voiceDynamicTools),
    coordinatorContext,
  );
  assert.equal(coordinatorContext.r, cwd);
  assert.deepEqual(JSON.parse(JSON.stringify(coordinatorContext.p)), [
    cwd,
    `${cwd}/secondary-root`,
  ]);
  assert.equal(coordinatorContext.d.newThread.model, "xai/grok-4.5");
  assert.equal(coordinatorContext.d.newThread.reasoningEffort, "xhigh");
  assert.deepEqual(
    JSON.parse(JSON.stringify(coordinatorContext.d.dynamicTools)),
    voiceDynamicTools,
  );
  assert.equal(breakpointState.coordinatorRewrites, 1);

  const startBoundarySource =
    'class Runtime{async startConversation(e,{afterConversationCreated:t,beforeFirstTurn:n,returnAfterOptimisticTurn:r}={}){let{input:i,sideConversation:a,threadSource:o,threadStartKind:k}=e;return e}}';
  const startBoundary = findConversationStartBoundary(startBoundarySource);
  assert.equal(startBoundary.matchCount, 1);
  runInNewContext(
    conversationStartBoundaryConditionFor(startBoundary, voiceDynamicTools),
    {
      e: startParams,
      globalThis: overlayGlobal,
    },
  );
  assert.equal(startParams.cwd, cwd);
  assert.deepEqual(
    JSON.parse(JSON.stringify(startParams.realtimeVoiceDynamicTools)),
    voiceDynamicTools,
  );
  assert.equal(breakpointState.dynamicToolRewrites, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(startParams.workspaceRoots)), [
    cwd,
    `${cwd}/secondary-root`,
  ]);
  assert.equal(startParams.workspaceKind, "project");
  assert.deepEqual(
    JSON.parse(JSON.stringify(startParams.projectAssignment)),
    JSON.parse(JSON.stringify(selectedProject.projectAssignment)),
  );
  assert.equal("projectlessOutputDirectory" in startParams, false);
  assert.equal(startParams.collaborationMode.settings.model, "xai/grok-4.5");
  assert.equal(
    startParams.collaborationMode.settings.reasoning_effort,
    "xhigh",
  );
  assert.equal(
    startParams.collaborationMode.settings.developer_instructions,
    "preserve me",
  );
  assert.equal(breakpointState.modelRewrites, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(breakpointState.lastVoiceWorkerSelection)),
    JSON.parse(JSON.stringify(selectedProject.voiceWorkerSelection)),
  );
  console.log(
    "Project Voice self-test passed: project routing, composer worker selection, five-minute inactivity, and Voice-only microphone processing are installed without affecting ordinary timers or dictation capture.",
  );
}

function runOverrideSelfTest() {
  const messageFromViewChannel = "codex_desktop:message-from-view";
  const originalTargetListener = (_event, message) => message;
  const handlers = new Map([[messageFromViewChannel, originalTargetListener]]);
  const ipcMain = {
    _invokeHandlers: handlers,
    handle(channel, listener) {
      if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
      handlers.set(channel, listener);
    },
  };
  const originalHandle = ipcMain.handle;
  const removedSwitches = [];
  const context = {
    process: {
      execArgv: ["--inspect=9333", "--trace-warnings"],
      mainModule: {
        require(specifier) {
          if (specifier === "electron") {
            return {
              app: {
                commandLine: {
                  removeSwitch(name) {
                    removedSwitches.push(name);
                  },
                },
              },
              ipcMain,
            };
          }
          if (specifier === "node:inspector") return { close() {} };
          throw new Error(`Unexpected self-test module: ${specifier}`);
        },
      },
    },
  };
  context.globalThis = context;

  const state = runInNewContext(overrideSource, context);
  assert.equal(state.installed, true);
  assert.equal(state.mode, voiceWorkerMode);
  assert.deepEqual(
    context.process.execArgv,
    ["--trace-warnings"],
    "Electron worker threads must not inherit the temporary inspector switch",
  );
  assert.deepEqual(removedSwitches, ["inspect"]);
  assert.equal(ipcMain.handle, originalHandle);
  assert.equal(state.targetRegistered, true);
  const installedListener = handlers.get(messageFromViewChannel);
  assert.equal(typeof installedListener, "function");
  assert.notEqual(installedListener, originalTargetListener);
  assert.equal(installedListener.__chatgptVoiceWorkerOverride, true);
  assert.equal(
    installedListener.__chatgptVoiceWorkerOriginalHandler,
    originalTargetListener,
  );

  const unrelatedListener = () => "unrelated";
  ipcMain.handle("unrelated-channel", unrelatedListener);
  assert.equal(handlers.get("unrelated-channel"), unrelatedListener);
  assert.equal(ipcMain.handle, originalHandle);

  const dispatch = (message) => installedListener({}, structuredClone(message));
  const nonRequestMessage = { type: "unrelated-ipc-message" };
  assert.deepEqual(dispatch(nonRequestMessage), nonRequestMessage);

  const ordinaryStart = {
    request: {
      id: 1,
      method: "thread/start",
      params: {
        config: { model_reasoning_effort: "default" },
        model: "xai/grok-4.5",
        threadSource: "user",
      },
    },
  };
  assert.deepEqual(dispatch(ordinaryStart), ordinaryStart);

  const voiceStart = {
    request: {
      id: 2,
      method: "thread/start",
      params: {
        config: { existing_key: true, model_reasoning_effort: "low" },
        model: "gpt-5.6-terra",
        threadSource: "realtime_voice",
      },
    },
  };
  const rewrittenVoiceStart = dispatch(voiceStart);
  if (voiceWorkerMode === "inherit") {
    assert.deepEqual(rewrittenVoiceStart, voiceStart);
    assert.equal(state.inheritedVoiceStarts, 1);
    assert.equal(state.rewrittenRequests, 0);
  } else {
    assert.equal(rewrittenVoiceStart.request.params.model, model);
    assert.equal(
      rewrittenVoiceStart.request.params.config.model_reasoning_effort,
      reasoningEffort,
    );
  }
  assert.equal(rewrittenVoiceStart.request.params.config.existing_key, true);

  state.setConfig("pin", "replacement-model", "replacement-effort");
  assert.equal(
    handlers.get(messageFromViewChannel),
    installedListener,
    "changing Voice worker config must update the existing wrapper, not stack another one",
  );
  const rewrittenAfterConfigChange = dispatch(voiceStart);
  assert.equal(rewrittenAfterConfigChange.request.params.model, "replacement-model");
  assert.equal(
    rewrittenAfterConfigChange.request.params.config.model_reasoning_effort,
    "replacement-effort",
  );

  state.setConfig("inherit", null, null);
  assert.deepEqual(
    dispatch(voiceStart),
    voiceStart,
    "inherit mode must preserve the model and reasoning selected in the composer",
  );

  const voiceResume = {
    request: {
      id: 3,
      method: "thread/resume",
      params: { threadId: "known-voice-thread" },
    },
  };
  assert.deepEqual(dispatch(voiceResume), voiceResume);

  state.restore();
  assert.equal(
    handlers.get(messageFromViewChannel),
    originalTargetListener,
    "restoring the override must put the original IPC handler back",
  );

  const deferredHandlers = new Map();
  let registrationPoll = null;
  const deferredIpcMain = {
    _invokeHandlers: deferredHandlers,
    handle(channel, listener) {
      deferredHandlers.set(channel, listener);
    },
  };
  const deferredContext = {
    process: {
      execArgv: ["--inspect=9333"],
      mainModule: {
        require(specifier) {
          if (specifier === "electron") {
            return {
              app: { commandLine: { removeSwitch() {} } },
              ipcMain: deferredIpcMain,
            };
          }
          if (specifier === "node:inspector") return { close() {} };
          throw new Error(`Unexpected deferred self-test module: ${specifier}`);
        },
      },
    },
    setInterval(callback) {
      registrationPoll = callback;
      return 1;
    },
    clearInterval() {},
  };
  deferredContext.globalThis = deferredContext;
  const deferredState = runInNewContext(overrideSource, deferredContext);
  assert.equal(deferredState.targetRegistered, false);
  assert.equal(typeof registrationPoll, "function");
  deferredIpcMain.handle(messageFromViewChannel, originalTargetListener);
  registrationPoll();
  assert.equal(deferredState.targetRegistered, true);
  assert.notEqual(
    deferredHandlers.get(messageFromViewChannel),
    originalTargetListener,
    "the poller must wrap a target handler registered after injection",
  );

  console.log(
    "Voice override self-test passed: existing and deferred target handlers wrap cleanly, ordinary starts and resumes stay untouched, and fresh Voice starts support composer inheritance or explicit pinning.",
  );
}

async function waitForInspectorTarget() {
  let lastError = null;
  while (Date.now() < startupDeadline) {
    try {
      const targets = await (await fetch(inspectorEndpoint)).json();
      const target = targets.find((candidate) => candidate.webSocketDebuggerUrl);
      if (target) return target;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for the ChatGPT main-process inspector on port ${inspectorPort}: ${lastError?.message ?? "no inspector target"}`,
  );
}

async function waitForTargetRegistration(connection) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression:
        "globalThis.__chatgptVoiceWorkerRequestOverrideState?.targetRegistered === true",
      returnByValue: true,
    });
    if (evaluated?.result?.value === true) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for ChatGPT's message-from-view IPC handler registration");
}

function openInspectorConnection(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    const eventWaiters = new Map();
    const eventBacklog = new Map();
    let nextId = 1;
    let opened = false;
    const openTimeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out opening the main-process inspector WebSocket"));
    }, 15000);

    function rejectOutstanding(error) {
      for (const command of pending.values()) {
        clearTimeout(command.timeout);
        command.reject(error);
      }
      pending.clear();
      for (const waiters of eventWaiters.values()) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timeout);
          waiter.reject(error);
        }
      }
      eventWaiters.clear();
    }

    socket.addEventListener("open", () => {
      opened = true;
      clearTimeout(openTimeout);
      resolve({
        send(method, params) {
          if (socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error(`Inspector WebSocket closed before ${method}`));
          }
          const id = nextId++;
          return new Promise((resolveCommand, rejectCommand) => {
            const timeout = setTimeout(() => {
              pending.delete(id);
              rejectCommand(new Error(`Timed out while running ${method}`));
            }, 15000);
            pending.set(id, {
              method,
              resolve: resolveCommand,
              reject: rejectCommand,
              timeout,
            });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        waitForEvent(method, timeoutMs) {
          const backlogged = eventBacklog.get(method);
          if (backlogged?.length) return Promise.resolve(backlogged.shift());
          return new Promise((resolveEvent, rejectEvent) => {
            const timeout = setTimeout(() => {
              const waiters = eventWaiters.get(method) ?? [];
              eventWaiters.set(method, waiters.filter((waiter) => waiter.resolve !== resolveEvent));
              rejectEvent(new Error(`Timed out waiting for ${method}`));
            }, timeoutMs);
            const waiters = eventWaiters.get(method) ?? [];
            waiters.push({ resolve: resolveEvent, reject: rejectEvent, timeout });
            eventWaiters.set(method, waiters);
          });
        },
        close() {
          socket.close();
        },
      });
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id != null) {
        const command = pending.get(message.id);
        if (!command) return;
        pending.delete(message.id);
        clearTimeout(command.timeout);
        if (message.error) {
          command.reject(
            new Error(message.error.message ?? JSON.stringify(message.error)),
          );
        } else if (message.result?.exceptionDetails) {
          command.reject(
            new Error(
              message.result.exceptionDetails.exception?.description ??
                message.result.exceptionDetails.text ??
                `Runtime exception during ${command.method}`,
            ),
          );
        } else {
          command.resolve(message.result);
        }
        return;
      }

      if (!message.method) return;
      const waiters = eventWaiters.get(message.method) ?? [];
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timeout);
        waiter.resolve(message.params);
        eventWaiters.set(message.method, waiters);
      } else {
        const backlogged = eventBacklog.get(message.method) ?? [];
        backlogged.push(message.params);
        eventBacklog.set(message.method, backlogged);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(openTimeout);
      const error = new Error("Main-process inspector WebSocket error");
      if (!opened) reject(error);
      rejectOutstanding(error);
    });
    socket.addEventListener("close", () => {
      clearTimeout(openTimeout);
      const error = new Error("Main-process inspector WebSocket closed");
      if (!opened) reject(error);
      rejectOutstanding(error);
    });
  });
}

function resolveVoiceWorkerConfig() {
  const selectedModel = (
    process.env.CHATGPT_VOICE_WORKER_MODEL ?? "selected"
  ).trim();
  const inheritedValues = new Set(["selected", "inherit", "composer"]);
  if (inheritedValues.has(selectedModel.toLowerCase())) {
    const selectedEffort = (
      process.env.CHATGPT_VOICE_WORKER_EFFORT ?? "selected"
    ).trim();
    if (!inheritedValues.has(selectedEffort.toLowerCase())) {
      throw new Error(
        "CHATGPT_VOICE_WORKER_EFFORT must also be selected/inherit/composer when the Voice worker model follows the composer.",
      );
    }
    return {
      mode: "inherit",
      model: null,
      reasoningEffort: null,
      catalogPath: null,
    };
  }

  const selectedEffort = (
    process.env.CHATGPT_VOICE_WORKER_EFFORT ?? "high"
  ).trim();
  const codexHomePath = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const catalogPath =
    process.env.CHATGPT_VOICE_MODEL_CATALOG?.trim() ||
    join(codexHomePath, "opencodex-catalog.json");

  if (!selectedModel) throw new Error("CHATGPT_VOICE_WORKER_MODEL must not be empty.");
  if (!selectedEffort) throw new Error("CHATGPT_VOICE_WORKER_EFFORT must not be empty.");

  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read the Codex model catalog at ${catalogPath}: ${error.message}`);
  }

  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const selected = models.find(
    (candidate) =>
      (candidate?.slug ?? candidate?.id ?? candidate?.model) === selectedModel,
  );
  if (!selected) {
    throw new Error(
      `Voice worker model ${JSON.stringify(selectedModel)} is not present in ${catalogPath}.`,
    );
  }

  const reasoningLevels =
    selected.supported_reasoning_levels ?? selected.supportedReasoningEfforts;
  const supportedEfforts = Array.isArray(reasoningLevels)
    ? reasoningLevels
        .map((entry) =>
          typeof entry === "string"
            ? entry
            : (entry?.effort ?? entry?.reasoningEffort),
        )
        .filter((entry) => typeof entry === "string")
    : [];
  const acceptsEffort =
    supportedEfforts.includes(selectedEffort) ||
    (supportedEfforts.length === 0 && selectedEffort === "none");
  if (!acceptsEffort) {
    const expected = supportedEfforts.length ? supportedEfforts.join(", ") : "none";
    throw new Error(
      `Voice worker model ${selectedModel} does not support reasoning effort ${JSON.stringify(selectedEffort)}. Supported: ${expected}.`,
    );
  }

  return {
    mode: "pin",
    model: selectedModel,
    reasoningEffort: selectedEffort,
    catalogPath,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function resumeBeforeExit(exitCode) {
  if (stopping) return;
  stopping = true;
  if (activeConnection) {
    await activeConnection
      .send("Runtime.evaluate", {
        expression: projectVoiceCleanupSource,
        returnByValue: true,
      })
      .catch(() => {});
    await activeConnection
      .send("Runtime.evaluate", {
        expression:
          "globalThis.__chatgptVoiceWorkerRequestOverrideState?.restore?.(); true",
        returnByValue: true,
      })
      .catch(() => {});
    activeConnection.close();
  }
  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void resumeBeforeExit(130);
});
process.once("SIGTERM", () => {
  void resumeBeforeExit(143);
});

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
