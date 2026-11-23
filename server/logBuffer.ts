const MAX_ALL_LINES = 300;
const MAX_ERROR_LINES = 100;

const allLines: string[] = [];
const errorLines: string[] = [];
let installed = false;

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return arg.stack || arg.message || String(arg);
      }
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function pushLine(target: string[], max: number, line: string) {
  target.push(line);
  if (target.length > max) {
    target.splice(0, target.length - max);
  }
}

export function installServerLogCapture(): void {
  if (installed) return;
  installed = true;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  const stamp = () => new Date().toISOString().slice(11, 19);

  console.log = (...args: unknown[]) => {
    const text = `[${stamp()}] [INFO] ${formatArgs(args)}`;
    pushLine(allLines, MAX_ALL_LINES, text);
    origLog(...args);
  };

  console.warn = (...args: unknown[]) => {
    const text = `[${stamp()}] [WARN] ${formatArgs(args)}`;
    pushLine(allLines, MAX_ALL_LINES, text);
    origWarn(...args);
  };

  console.error = (...args: unknown[]) => {
    const text = `[${stamp()}] [ERROR] ${formatArgs(args)}`;
    pushLine(allLines, MAX_ALL_LINES, text);
    pushLine(errorLines, MAX_ERROR_LINES, text);
    origError(...args);
  };
}

export function getServerLogErrors(limit = 20): string[] {
  return errorLines.slice(-limit);
}

export function getServerLogs(limit = 50): string[] {
  return allLines.slice(-limit);
}
