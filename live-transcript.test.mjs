import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const payload = readFileSync(new URL("./chatgpt-voice-renderer-enhancements.js", import.meta.url), "utf8");

function setup() {
  class Element {
    children = [];
    dataset = {};
    style = {};
    attributes = {};
    isConnected = true;
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    querySelector() { return this.markdown ?? null; }
    querySelectorAll() { return []; }
    append(child) { child.remove(); child.parentElement = this; this.children.push(child); }
    insertBefore(child, before) {
      child.remove();
      child.parentElement = this;
      this.children.splice(this.children.indexOf(before), 0, child);
    }
    remove() {
      if (this.parentElement) {
        const children = this.parentElement.children;
        children.splice(children.indexOf(this), 1);
        this.parentElement = null;
      }
    }
    replaceChildren() { for (const child of [...this.children]) child.remove(); }
  }
  const parent = new Element();
  const nativeHistory = new Element();
  nativeHistory.textContent = "Native history stays untouched";
  const composer = new Element();
  composer.__reactFiber$test = { memoizedProps: { conversationId: "thread" } };
  parent.append(nativeHistory);
  parent.append(composer);
  const nativeRows = [];
  let notifyMutation;
  const context = {
    Element,
    MutationObserver: class {
      constructor(callback) { notifyMutation = callback; }
      observe() {}
      disconnect() {}
    },
    setTimeout: () => 1,
    clearTimeout() {},
    document: {
      body: parent,
      addEventListener() {}, removeEventListener() {},
      createElement: () => new Element(),
      querySelector: selector => selector === "[data-codex-composer-root]" ? composer : null,
      querySelectorAll: selector => selector.startsWith('[data-content-search-unit-key') ? nativeRows : [],
    },
  };
  context.window = context;
  runInNewContext(payload, context);
  const send = (type, role, value) => context.__chatgptNativeVoiceTranscriptEvent(
    `thread/realtime/${type}`,
    { threadId: "thread", role, ...(type.endsWith("delta") ? { delta: value } : { text: value }) },
  );
  const rows = () => parent.children.filter(child => child !== composer && child !== nativeHistory)
    .flatMap(root => root.children.map(row => [row.dataset.liveVoiceRole, row.children[0].textContent]));
  send("started");
  const addNative = (userText, assistantText, { completed = true, threadId = "thread", suffix = "" } = {}) => {
    const row = new Element();
    row.setAttribute("data-content-search-unit-key", `realtime-voice:transcript:user-${nativeRows.length}:assistant-${nativeRows.length}`);
    const entries = [
      { id: `user-${nativeRows.length}`, role: "user", completed: true, text: userText },
      { id: `assistant-${nativeRows.length}`, role: "assistant", completed, text: assistantText },
      ...(suffix ? [{ id: "suffix", role: "assistant", completed: true, text: suffix }] : []),
    ];
    row.__reactFiber$test = { memoizedProps: { conversationId: threadId, block: { entries } } };
    row.markdown = new Element();
    row.markdown.textContent = assistantText;
    row.append(row.markdown);
    nativeRows.push(row);
    return row;
  };
  const mutate = async () => { notifyMutation(); await Promise.resolve(); };
  return { send, rows, context, parent, nativeHistory, addNative, mutate };
}

test("only unfinished speech is displayed; done-only events and repeated words do not duplicate history", () => {
  const { send, rows, nativeHistory, parent } = setup();
  send("transcript/delta", "user", "はい");
  assert.deepEqual(rows(), [["user", "はい"]]);
  send("transcript/done", "user", "はい。");
  assert.deepEqual(rows(), []);
  send("transcript/done", "assistant", "了解です");
  assert.deepEqual(rows(), []);
  send("transcript/delta", "user", "はい");
  assert.deepEqual(rows(), [["user", "はい"]], "a new utterance with identical words remains visible");
  send("transcript/done", "user", "はい");
  assert.deepEqual(rows(), []);
  assert.equal(parent.children[0], nativeHistory);
  assert.equal(nativeHistory.textContent, "Native history stays untouched");
});

test("interleaved speech updates each speaker's pending entry and finalizes the correct one", () => {
  const { send, rows, context } = setup();
  send("transcript/delta", "user", "お願い");
  send("transcript/delta", "assistant", "確認");
  send("transcript/delta", "user", "します");
  assert.deepEqual(rows(), [["user", "お願いします"], ["assistant", "確認"]]);
  send("transcript/done", "user", "お願いします。");
  assert.deepEqual(rows(), [["assistant", "確認"]]);
  send("transcript/delta", "assistant", "しますね");
  assert.deepEqual(rows(), [["assistant", "確認しますね"]]);
  send("transcript/done", "assistant", "確認しますね。");
  assert.deepEqual(rows(), []);
  assert.equal(context.__chatgptNativeProjectVoiceContextState.liveTranscriptSnapshot().entries.length, 2);
});

test("a renderer upgrade preserves received speech without duplicating the panel", () => {
  const { send, rows, context } = setup();
  send("transcript/delta", "user", "old partial");
  const old = context.__chatgptNativeProjectVoiceContextState;
  old.version = "previous-version";
  runInNewContext(payload, context);
  assert.equal(old.installed, false);
  assert.deepEqual(rows(), [["user", "old partial"]]);
});

test("a truncated native reply is repaired from the complete transcript after native rendering catches up", async () => {
  const { send, addNative, mutate, context } = setup();
  send("transcript/done", "user", "テストも必要です");
  send("transcript/delta", "assistant", "なるほど、追加");
  const row = addNative("テストも必要です", "なるほど、追加");
  await mutate();
  assert.equal(row.children.length, 1, "unfinished speech must not replace native history");
  send("transcript/done", "assistant", "なるほど、追加を確認しますね。実接続もテストします。");
  assert.equal(row.children.length, 2);
  assert.equal(row.markdown.style.display, "none");
  assert.equal(row.children[1].textContent, "なるほど、追加を確認しますね。実接続もテストします。");
  assert.equal(row.__reactFiber$test.memoizedProps.block.entries[1].text, "なるほど、追加", "stored native data is not rewritten");
  await mutate();
  assert.equal(row.children.length, 2, "observer updates must not duplicate repairs");
  context.__chatgptNativeProjectVoiceContextState.dispose();
  assert.equal(row.children.length, 1);
  assert.equal(row.markdown.style.display, undefined);
});

test("late native rows are repaired and a later full native rendering removes the replacement", async () => {
  const { send, addNative, mutate } = setup();
  send("transcript/done", "user", "質問");
  send("transcript/done", "assistant", "確認します。回答です。");
  const row = addNative("質問", "確認");
  await mutate();
  assert.equal(row.children[1].textContent, "確認します。回答です。");
  row.markdown.textContent = "確認します。回答です。";
  row.__reactFiber$test.memoizedProps.block.entries[1].text = row.markdown.textContent;
  await mutate();
  assert.equal(row.children.length, 1);
  assert.equal(row.markdown.style.display, undefined);
});

test("complete, unrelated, ambiguous and already split native answers are left alone", async () => {
  const { send, addNative, mutate } = setup();
  send("transcript/done", "user", "質問");
  send("transcript/done", "assistant", "確認します。回答です。");
  const rows = [
    addNative("質問", "確認します。回答です。"),
    addNative("別の質問", "確認"),
    addNative("質問", "確認", { threadId: "another-thread" }),
    addNative("質問", "確認", { completed: false }),
    addNative("質問", "確認します。", { suffix: "回答です。" }),
  ];
  await mutate();
  for (const row of rows) assert.equal(row.children.length, 1);
  send("transcript/done", "assistant", "確認します。別の回答です。");
  const ambiguous = addNative("質問", "確認");
  await mutate();
  assert.equal(ambiguous.children.length, 1);
});

test("a repair is removed when the missing text arrives in a following native item", async () => {
  const { send, addNative, mutate } = setup();
  send("transcript/done", "user", "質問");
  send("transcript/done", "assistant", "確認します。回答です。");
  const row = addNative("質問", "確認します。");
  await mutate();
  assert.equal(row.children.length, 2);
  row.__reactFiber$test.memoizedProps.block.entries.push({
    id: "later", role: "assistant", completed: true, text: "回答です。",
  });
  await mutate();
  assert.equal(row.children.length, 1);
  assert.equal(row.markdown.style.display, undefined);
});
