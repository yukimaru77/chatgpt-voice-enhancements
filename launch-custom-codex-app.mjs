// Optional macOS launcher: keep the signed app untouched and pin its external backend.
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { inspectAppProcesses, matchesBackend, publicProcessState } from "./custom-codex-processes.mjs";

const usage = "Usage: node launch-custom-codex-app.mjs [--custom|--bundled|--status]";
if (process.argv.length === 3 && process.argv[2] === "--help") {
  console.log(usage + "\nProfile: CHATGPT_CUSTOM_CODEX_PROFILE, or ~/.local/lib/codex-custom/profile.json");
  process.exit(0);
}
const profilePath = process.env.CHATGPT_CUSTOM_CODEX_PROFILE ?? join(homedir(), ".local/lib/codex-custom/profile.json");
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
profile.voiceRepository ??= fileURLToPath(new URL(".", import.meta.url));
const mode = process.argv[2] ?? "--custom";
if (process.argv.length > 3 || !["--custom", "--bundled", "--status"].includes(mode)) {
  throw new Error(usage);
}
const run = (file, args) => execFileSync(file, args, { encoding: "utf8" }).trim();
const plist = key => run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(profile.appPath, "Contents/Info.plist")]);
const appExecutable = join(profile.appPath, "Contents/MacOS", plist("CFBundleExecutable"));
const bundledCli = join(profile.appPath, "Contents/Resources/codex");
const processes = () => {
  const commands = new Map(run("/bin/ps", ["-axww", "-o", "pid=,args="]).split("\n").flatMap(line => {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    return m ? [[Number(m[1]), m[2]]] : [];
  }));
  return run("/bin/ps", ["-axww", "-o", "pid=,ppid=,comm="]).split("\n").flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), executable: m[3], command: commands.get(Number(m[1])) }] : [];
  });
};
function inspect(launcher) {
  const state = inspectAppProcesses(processes(), appExecutable, launcher);
  if (state.appCount > 1) throw new Error("Multiple matching app processes are running; no process was changed.");
  return state;
}
function debuggerReady(pid) {
  try {
    run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), `-iTCP:${profile.debugPort}`, "-sTCP:LISTEN"]);
    return true;
  } catch { return false; }
}
const waitUntil = async (predicate, seconds, message) => {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(message);
};
async function stream(file, args, env = process.env) {
  const child = spawn(file, args, { stdio: "inherit", env });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`${file}: ${signal}`)) : resolve(code));
  });
  if (code !== 0) throw new Error(`${file} exited with status ${code}`);
}

if (mode === "--status") {
  const launcher = profile.cliLauncher ? realpathSync(profile.cliLauncher) : undefined;
  const state = inspect(launcher);
  console.log(JSON.stringify({ appVersion: plist("CFBundleShortVersionString"), appBuild: plist("CFBundleVersion"), pinnedCli: profile.cliPath, cliLauncher: launcher ?? null, effectiveCliPath: launcher ?? profile.cliPath, customBackendMatches: matchesBackend(state, realpathSync(profile.cliPath), launcher), ...publicProcessState(state) }, null, 2));
} else {
  const custom = mode === "--custom";
  const expected = realpathSync(custom ? profile.cliPath : bundledCli);
  const launcher = custom && profile.cliLauncher ? realpathSync(profile.cliLauncher) : undefined;
  const effectiveCliPath = launcher ?? expected;
  if (custom) {
    for (const [path, digest] of [[profile.cliPath, profile.cliSha256], [join(dirname(profile.cliPath), "codex-code-mode-host"), profile.codeModeHostSha256]]) {
      if (createHash("sha256").update(readFileSync(path)).digest("hex") !== digest) throw new Error(`Pinned binary changed: ${path}`);
    }
    if (plist("CFBundleShortVersionString") !== profile.testedAppVersion || plist("CFBundleVersion") !== profile.testedAppBuild) {
      throw new Error("The app version changed. Revalidate the custom CLI before using it; use node launch-custom-codex-app.mjs --bundled to return to the bundled backend.");
    }
    run("/usr/bin/codesign", ["--verify", "--strict", expected]);
    await stream(process.execPath, [join(profile.voiceRepository, "inject-chatgpt-voice-enhancements.mjs"), String(profile.debugPort), "30000", "--check-app-compatibility"]);
  }
  let current = inspect(launcher);
  if (current.app && (!matchesBackend(current, expected, launcher) || !debuggerReady(current.app.pid))) {
    console.log("Gracefully restarting the app; confirm Quit in the app if prompted. Other CLI sessions are untouched.");
    const appTarget = JSON.stringify(profile.appPath);
    run("/usr/bin/osascript", ["-e", `tell application ${appTarget} to activate`, "-e", `tell application ${appTarget} to quit`]);
    await waitUntil(() => !inspect(launcher).app, 30, "The app did not quit. Finish or cancel any in-app quit confirmation and rerun; no process was force-terminated.");
    current = inspect(launcher);
  }
  if (!current.app) {
    run("/usr/bin/open", ["-na", profile.appPath, "--env", `CODEX_CLI_PATH=${effectiveCliPath}`, "--env", "CODEX_APP_SERVER_FORCE_CLI=1", "--args", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${profile.debugPort}`]);
  }
  await waitUntil(() => {
    const state = inspect(launcher);
    return matchesBackend(state, expected, launcher) && debuggerReady(state.app.pid);
  }, 60, "The app did not start the requested backend and debugger. No fallback backend is reported as successful.");
  await stream("/bin/bash", [join(profile.voiceRepository, "install-chatgpt-voice-enhancements.sh")], { ...process.env, CHATGPT_APP_PATH: profile.appPath, CHATGPT_MAIN_INSPECT_PORT: String(profile.debugPort) });
  const state = inspect(launcher);
  if (!matchesBackend(state, expected, launcher)) throw new Error("Backend changed during setup.");
  console.log(JSON.stringify({ ready: true, mode: custom ? "custom" : "bundled", appPid: state.app.pid, launcherPid: state.launchers[0]?.pid ?? null, backendPid: state.backends[0].pid, backendPath: expected, effectiveCliPath, cliVersion: run(expected, ["--version"]) }, null, 2));
}
