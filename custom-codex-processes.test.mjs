import test from "node:test";
import assert from "node:assert/strict";
import { inspectAppProcesses, matchesBackend, publicProcessState } from "./custom-codex-processes.mjs";

const appPath = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const cli = "/custom/build/codex";
const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
const launcher = "/custom/cx/codex-app-server";
const app = { pid: 10, ppid: 1, executable: appPath, command: appPath };
const bridge = { pid: 11, ppid: 10, executable: "/usr/bin/python3", command: `/usr/bin/python3 ${launcher} app-server --listen stdio://` };
const backend = (pid, ppid, executable = cli) => ({ pid, ppid, executable, command: `${executable} app-server --listen stdio://` });
const inspect = (rows, wrapper = launcher) => inspectAppProcesses(rows, appPath, wrapper);

test("a configured live bridge and its pinned backend match without a restart", () => {
  const state = inspect([app, bridge, backend(12, 11), backend(90, 89)]);
  assert.equal(matchesBackend(state, cli, launcher), true);
  assert.deepEqual(state.backends.map(p => p.pid), [12]);
  assert.equal(publicProcessState(state).launchers[0].command, undefined);
});

test("App's global CLI flags may precede the app-server subcommand", () => {
  const interpreter = "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python";
  const liveBridge = { ...bridge, executable: interpreter, command: `${interpreter} ${launcher} -c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.codex-app-tools.enabled=true` };
  assert.equal(matchesBackend(inspect([app, liveBridge, backend(12, 11)]), cli, launcher), true);
});

test("an unrelated bridge, a similarly named script or a sibling CLI cannot satisfy the chain", () => {
  for (const rows of [
    [app, { ...bridge, ppid: 99 }, backend(12, 11)],
    [app, { ...bridge, command: `/usr/bin/python3 ${launcher}-old app-server` }, backend(12, 11)],
    [app, bridge, backend(12, 10)],
    [app, bridge, backend(12, 11, bundled)],
  ]) assert.equal(matchesBackend(inspect(rows), cli, launcher), false);
});

test("duplicate backends and wrong command modes are not accepted", () => {
  assert.equal(matchesBackend(inspect([app, bridge, backend(12, 11), backend(13, 10)]), cli, launcher), false);
  assert.equal(matchesBackend(inspect([app, bridge, { ...backend(12, 11), command: `${cli} --version` }]), cli, launcher), false);
});

test("direct and bundled launch modes still require a direct native app-server", () => {
  assert.equal(matchesBackend(inspect([app, backend(12, 10)], null), cli), true);
  assert.equal(matchesBackend(inspect([app, backend(12, 10, bundled)], null), bundled), true);
  assert.equal(matchesBackend(inspect([app, bridge, backend(12, 11, bundled)], null), bundled), false);
});

test("nested tool-launched codex processes are not mistaken for the app backend", () => {
  const state = inspect([app, bridge, backend(12, 11), backend(13, 12)]);
  assert.equal(matchesBackend(state, cli, launcher), true);
  assert.equal(matchesBackend(inspect([app, { ...app, pid: 20 }, bridge, backend(12, 11)]), cli, launcher), false);
});
