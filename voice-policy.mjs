import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export function loadVoicePolicy(mode = process.env.CHATGPT_VOICE_POLICY ?? "single-backend") {
  if (mode === "native") return { mode, enabled: false, revision: null };
  if (mode !== "single-backend") {
    throw new Error("CHATGPT_VOICE_POLICY must be single-backend or native");
  }
  const policy = { mode, enabled: true };
  for (const name of ["frontend", "backend", "end"]) {
    policy[name] = readFileSync(new URL(`./voice-policy/${name}.md`, import.meta.url), "utf8").trim();
    if (!policy[name]) throw new Error(`Voice policy ${name}.md must not be empty`);
    if (name !== "frontend" && Math.ceil(Buffer.byteLength(policy[name], "utf8") / 4) > 8192) {
      throw new Error(`Voice policy ${name}.md exceeds the app's 8192-unit instruction limit`);
    }
  }
  policy.revision = createHash("sha256")
    .update(JSON.stringify([policy.frontend, policy.backend, policy.end]))
    .digest("hex");
  return policy;
}

// Deliberately self-contained: the same analyzer runs in Node and in the renderer.
// Match semantic property names, never a build's minified class/variable name.
// Unknown signatures or multiple candidates are rejected by the installer.
export function findVoiceSessionBoundary(source) {
  const pattern = /async\s+(?:function\s+)?[A-Za-z_$][\w$]*\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*\{([^{}]{1,6000})\}\s*\)\s*\{/g;
  const fields = ["prompt", "realtimeStartInstructions", "realtimeEndInstructions", "conversationId", "hostId", "realtimeSessionOverrides", "microphone"];
  const matches = [];
  for (const match of source.matchAll(pattern)) {
    const bindings = {};
    for (const field of fields) {
      const property = new RegExp(`(?:^|,)\\s*${field}\\s*(?::\\s*([A-Za-z_$][\\w$]*))?\\s*(?=[,=]|$)`).exec(match[1]);
      if (property) bindings[field] = property[1] ?? field;
    }
    if (fields.every(field => bindings[field])) {
      matches.push({ bindings, breakpointOffset: match.index + match[0].length });
    }
  }
  return matches.length === 1 ? { matchCount: 1, ...matches[0] } : { matchCount: matches.length };
}

export function voiceSessionConditionFor(boundary, policy) {
  const b = boundary.bindings;
  return `(() => {
    ${b.prompt} = ${JSON.stringify(policy.frontend)};
    ${b.realtimeStartInstructions} = ${JSON.stringify(policy.backend)};
    ${b.realtimeEndInstructions} = ${JSON.stringify(policy.end)};
    const previous = globalThis.__chatgptVoicePolicyState;
    globalThis.__chatgptVoicePolicyState = {
      mode: ${JSON.stringify(policy.mode)}, revision: ${JSON.stringify(policy.revision)},
      applications: (previous?.applications ?? 0) + 1,
      lastThreadId: ${b.conversationId}, lastHostId: ${b.hostId},
      boundary: 'voice-session-start',
      frontendApplied: true, backendApplied: true, endApplied: true
    };
    return false;
  })()`;
}

export function voiceCoordinatorPolicyExpression(treatment, policy) {
  if (!policy.enabled) return "";
  // Do not leave the native new-Voice worker-orchestration prompt underneath
  // the realtime instructions. This base applies to new Voice tasks only.
  // The realtime protocol itself is added/removed by session start/end.
  const base = "Perform all work for this Codex task yourself in this same thread. Do not create a separate task, thread, or subagent for work, and do not delegate work to one.";
  return `${treatment} = { ...${treatment}, newThread: { ...${treatment}.newThread,
    developerInstructions: ${JSON.stringify(base)}, voiceToolsDeveloperInstructions: null
  }, dynamicTools: { ...${treatment}.dynamicTools, transferVoiceCallEnabled: false } };`;
}

export function voicePolicyAnalysisSource(policy) {
  return `const findVoiceSessionBoundary = ${findVoiceSessionBoundary.toString()};
    const voiceSessionConditionFor = ${voiceSessionConditionFor.toString()};
    const voicePolicy = ${JSON.stringify(policy)};`;
}

// ASAR read-only preflight. This runs before launching/restarting the app.
export function readAppInitialAsset(appPath) {
  const bytes = readFileSync(`${appPath}/Contents/Resources/app.asar`);
  const headerLength = bytes.readUInt32LE(12);
  const header = JSON.parse(bytes.subarray(16, 16 + headerLength).toString("utf8"));
  const files = header.files?.webview?.files?.assets?.files ?? {};
  const names = Object.keys(files).filter(name => /^app-initial-[A-Za-z0-9_-]+\.js$/.test(name));
  if (names.length !== 1) throw new Error(`Expected one app-initial asset, found ${names.length}`);
  const entry = files[names[0]];
  if (entry.unpacked || !Number.isFinite(Number(entry.offset))) throw new Error("Unsupported app-initial ASAR entry");
  const start = 8 + bytes.readUInt32LE(4) + Number(entry.offset);
  if (start < 0 || start + entry.size > bytes.length) throw new Error("Invalid app-initial ASAR bounds");
  return { name: names[0], source: bytes.subarray(start, start + entry.size).toString("utf8") };
}
