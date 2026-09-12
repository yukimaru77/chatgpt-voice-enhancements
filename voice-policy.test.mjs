import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  loadVoicePolicy, findVoiceSessionBoundary, voiceSessionConditionFor,
  voiceCoordinatorPolicyExpression,
} from "./voice-policy.mjs";

const policy = loadVoicePolicy("single-backend");
const source = `class Voice {
  async begin(scope, {microphone:mic, hostId:host, prompt:instructions=null,
    extraFutureField:extra, realtimeSessionOverrides:overrides,
    realtimeEndInstructions:end, conversationId:id, realtimeStartInstructions:start}) {
    return {mic, host, instructions, extra, overrides, end, id, start};
  }
}`;

test("only the semantic Voice boundary is selected; duplicates and missing fields fail closed", () => {
  assert.equal(findVoiceSessionBoundary(source).matchCount, 1);
  assert.equal(findVoiceSessionBoundary(source.replace("begin(", "renamedByFutureMinifier(")).matchCount, 1);
  assert.equal(findVoiceSessionBoundary(source + source).matchCount, 2);
  assert.equal(findVoiceSessionBoundary(source.replace("realtimeStartInstructions", "unknownField")).matchCount, 0);
  assert.equal(findVoiceSessionBoundary("class Text { async start(e,{prompt:p}) { return p; } }").matchCount, 0);
});

test("all three prompts are replaced before consumption, preserving thread, host, transport and microphone", async () => {
  const boundary = findVoiceSessionBoundary(source);
  const condition = voiceSessionConditionFor(boundary, policy);
  const instrumented = source.slice(0, boundary.breakpointOffset) + condition + ";" + source.slice(boundary.breakpointOffset);
  const context = {};
  const voice = runInNewContext(instrumented + ";new Voice()", context);
  for (const version of ["v1", "v3"]) {
    const input = {microphone:{live:true},hostId:"local",conversationId:"existing-task",
      prompt:"native prompt: summarize",realtimeStartInstructions:"delegate work",
      realtimeEndInstructions:"old end",realtimeSessionOverrides:{version,model:"keep-model"},extraFutureField:42};
    const result = await voice.begin({}, input);
    assert.equal(result.instructions, policy.frontend);
    assert.equal(result.start, policy.backend);
    assert.equal(result.end, policy.end);
    assert.equal(result.id, input.conversationId);
    assert.equal(result.host, input.hostId);
    assert.equal(result.mic, input.microphone);
    assert.equal(result.overrides, input.realtimeSessionOverrides);
    assert.equal(result.extra, 42);
    assert.equal(input.prompt, "native prompt: summarize", "do not mutate cached native configuration");
  }
  assert.equal(context.__chatgptVoicePolicyState.applications, 2);
  assert.equal(context.__chatgptVoicePolicyState.revision, policy.revision);
});

test("shorthand bindings and whitespace survive source changes", () => {
  const renamed = source.replace("prompt:instructions=null", "prompt = null");
  assert.equal(findVoiceSessionBoundary(renamed).bindings.prompt, "prompt");
});

test("new Voice tasks lose worker-orchestration instructions but retain model and project settings", () => {
  const original = {projectId:"project",newThread:{model:"selected",reasoningEffort:"high",developerInstructions:"spawn workers",voiceToolsDeveloperInstructions:"more delegation"},dynamicTools:{appshotsEnabled:true,transferVoiceCallEnabled:true}};
  const context = { treatment: original };
  runInNewContext(voiceCoordinatorPolicyExpression("treatment", policy), context);
  assert.equal(context.treatment.projectId, "project");
  assert.equal(context.treatment.newThread.model, "selected");
  assert.equal(context.treatment.newThread.reasoningEffort, "high");
  assert.match(context.treatment.newThread.developerInstructions, /Do not create a separate task/);
  assert.equal(context.treatment.newThread.voiceToolsDeveloperInstructions, null);
  assert.equal(context.treatment.dynamicTools.appshotsEnabled, true);
  assert.equal(context.treatment.dynamicTools.transferVoiceCallEnabled, false);
  assert.equal(original.newThread.developerInstructions, "spawn workers");
});

test("native opt-out, configuration validation, stable content revision and English runtime instructions", () => {
  const native = loadVoicePolicy("native");
  assert.equal(native.enabled, false);
  assert.equal(voiceCoordinatorPolicyExpression("treatment", native), "");
  assert.throws(() => loadVoicePolicy("typo"), /single-backend or native/);
  assert.equal(loadVoicePolicy("single-backend").revision, policy.revision);
  for (const key of ["frontend", "backend", "end"]) assert.doesNotMatch(policy[key], /[\u3040-\u30ff\u4e00-\u9fff]/);
});
