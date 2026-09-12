// Match the app's backend chain, not codex processes started by unrelated sessions.
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const appServer = process => /(?:^|\s)app-server(?:\s|$)/.test(process.command ?? "");

function isLauncher(process, launcher) {
  if (!launcher || !appServer(process)) return false;
  if (process.executable === launcher) return true;
  // A shebang script appears as its interpreter in macOS ps's comm column.
  return /\/(?:python[\d.]*|node)$/i.test(process.executable) &&
    new RegExp(`(?:^|\\s)${escaped(launcher)}(?:\\s|$)`).test(process.command ?? "");
}

export function inspectAppProcesses(all, appExecutable, launcher) {
  const apps = all.filter(process => process.executable === appExecutable);
  const app = apps.length === 1 ? apps[0] : undefined;
  const children = app ? all.filter(process => process.ppid === app.pid) : [];
  const launchers = children.filter(process => isLauncher(process, launcher));
  const launcherPids = new Set(launchers.map(process => process.pid));
  const backends = all.filter(process => !launcherPids.has(process.pid) && /\/codex$/.test(process.executable) &&
    (process.ppid === app?.pid || launcherPids.has(process.ppid)));
  return { app, appCount: apps.length, launchers, backends };
}

export function matchesBackend(state, expected, launcher) {
  const { app, launchers, backends } = state;
  if (!app || backends.length !== 1 || backends[0].executable !== expected || !appServer(backends[0])) return false;
  return launcher
    ? launchers.length === 1 && backends[0].ppid === launchers[0].pid
    : backends[0].ppid === app.pid;
}

export function publicProcessState(state) {
  // Full argv is needed for matching but can include private app/session arguments.
  const withoutCommand = ({ command, ...process }) => process;
  return {
    ...state,
    app: state.app && withoutCommand(state.app),
    launchers: state.launchers.map(withoutCommand),
    backends: state.backends.map(withoutCommand),
  };
}
