// Opt-in real-app smoke test. Uses a WAV as a synthetic microphone, not text
// append calls. Only the explicitly supplied test thread is observed.
import { readFileSync, writeFileSync } from "node:fs";
import { appTargets, connectTarget } from "./cdp.mjs";
import { readAppInitialAsset } from "../voice-policy.mjs";

const [action, threadId, path] = process.argv.slice(2);
if (!threadId || !["prepare", "start", "play", "status", "stop", "restore"].includes(action)) {
  throw new Error("Usage: node tests/voice-smoke.mjs prepare|start|play|status|stop|restore THREAD_ID [WAV_OR_REPORT_PATH]");
}
const { name, source } = readAppInitialAsset(process.env.CHATGPT_APP_PATH ?? "/Applications/ChatGPT.app");
// These are test adapters for the inspected build, not the production hook.
const serviceMatch = /(?:,|\{)Iq as ([A-Za-z_$][\w$]*)/.exec(source);
if (!serviceMatch) throw new Error("Smoke test needs a service-export adapter for this app build");
const getService = `const module = await import(${JSON.stringify("app://-/assets/" + name)}); const service = module[${JSON.stringify(serviceMatch[1])}];`;
const targets = await appTargets();
const selected = ["start", "stop"].includes(action) ? targets.filter(t => !t.url.includes("avatar-overlay")) : targets;
const results = [];
for (const target of selected) {
  const client = await connectTarget(target);
  try {
    let expression;
    if (action === "prepare") {
      const wav = readFileSync(path).toString("base64");
      expression = `(async () => {
        if (globalThis.__voicePolicySmoke) throw new Error('Restore the previous smoke-test input first');
        const context = new AudioContext({sampleRate:48000});
        const encoded = atob(${JSON.stringify(wav)});
        const bytes = Uint8Array.from(encoded, c => c.charCodeAt(0));
        const buffer = await context.decodeAudioData(bytes.buffer);
        const destination = context.createMediaStreamDestination();
        const original = navigator.mediaDevices.getUserMedia;
        const originalEvent = globalThis.__chatgptNativeVoiceTranscriptEvent;
        const state = {context, buffer, destination, original, originalEvent,
          threadId:${JSON.stringify(threadId)}, events:[], captures:[], peers:[], played:false};
        navigator.mediaDevices.getUserMedia = function(constraints) {
          if (constraints?.audio && (constraints.audio.channelCount === 1 || constraints.audio.channelCount?.ideal === 1)) {
            state.captures.push(constraints);
            return Promise.resolve(destination.stream.clone());
          }
          return Reflect.apply(original, this, [constraints]);
        };
        globalThis.__chatgptNativeVoiceTranscriptEvent = function(method, params) {
          if (params?.threadId === state.threadId) state.events.push({method,params,time:Date.now()});
          return originalEvent?.(method,params) ?? false;
        };
        const OriginalPeer = RTCPeerConnection;
        state.originalPeer = OriginalPeer;
        globalThis.RTCPeerConnection = new Proxy(OriginalPeer, {construct(target,args) {
          const peer = Reflect.construct(target,args);
          state.peers.push(peer);
          return peer;
        }});
        globalThis.__voicePolicySmoke = state;
        await context.resume();
        return {prepared:true,duration:buffer.duration,audioContext:context.state};
      })()`;
    } else if (action === "start") {
      expression = `(async()=>{${getService}
        const snapshot=await service.realtimeVoice.getSnapshot();
        if(snapshot.phase!=='inactive') throw new Error('Another voice call is active; not replacing it');
        await service.realtimeVoiceRuntime.requestRealtimeStart({source:'composer_button_existing_thread',locator:{hostId:'local',conversationId:${JSON.stringify(threadId)}}},crypto.randomUUID());
        return {requested:true};
      })()`;
    } else if (action === "play") {
      expression = `(async()=>{const state=globalThis.__voicePolicySmoke;
        if(!state || state.captures.length===0) return {played:false,reason:'not the microphone owner'};
        if(state.played) return {played:false,reason:'already played'};
        await state.context.resume();
        const source=state.context.createBufferSource();source.buffer=state.buffer;source.connect(state.destination);source.start();state.source=source;state.played=true;
        return {played:true,duration:state.buffer.duration};})()`;
    } else if (action === "stop") {
      expression = `(async()=>{${getService}
        const snapshot=await service.realtimeVoice.getSnapshot();
        if(snapshot.locator?.conversationId!==${JSON.stringify(threadId)}) return {stopped:false,snapshot};
        return {stopped:await service.realtimeVoice.control(snapshot.locator,{type:'stop'})};})()`;
    } else if (action === "restore") {
      expression = `(async()=>{const state=globalThis.__voicePolicySmoke;if(!state)return {restored:false};
        try{state.source?.stop()}catch{}
        navigator.mediaDevices.getUserMedia=state.original;
        globalThis.__chatgptNativeVoiceTranscriptEvent=state.originalEvent;
        globalThis.RTCPeerConnection=state.originalPeer;
        for(const track of state.destination.stream.getTracks())track.stop();await state.context.close();
        delete globalThis.__voicePolicySmoke;return {restored:true};})()`;
    } else {
      expression = `(async()=>{${getService}
        const state=globalThis.__voicePolicySmoke;
        const peers=[];for(const peer of state?.peers??[]){const stats=await peer.getStats();peers.push({connectionState:peer.connectionState,stats:[...stats.values()].filter(s=>['outbound-rtp','inbound-rtp','media-source'].includes(s.type))});}
        return {snapshot:await service.realtimeVoice.getSnapshot(),policy:globalThis.__chatgptVoicePolicyState??null,
          smoke:state?{captures:state.captures,played:state.played,events:state.events,peers}:null};})()`;
    }
    const response = await client.send("Runtime.evaluate", {expression,awaitPromise:true,returnByValue:true,userGesture:true});
    if(response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    results.push({target:target.url,result:response.result?.value});
  } finally { client.close(); }
}
if (action === "status" && path) writeFileSync(path, JSON.stringify(results,null,2)+"\n");
console.log(JSON.stringify(results,null,2));
