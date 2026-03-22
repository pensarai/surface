// ---------------------------------------------------------------------------
// Shared formatting utilities — color system, display helpers
//
// Single source of truth for ANSI output. Respects NO_COLOR, FORCE_COLOR,
// and TTY detection per the project's security invariants.
// ---------------------------------------------------------------------------

export const HAS_COLOR =
  process.env.FORCE_COLOR !== undefined ||
  (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);

function ansi(code: string): string {
  return HAS_COLOR ? code : "";
}

export const C = {
  reset: ansi("\x1b[0m"),
  dim: ansi("\x1b[2m"),
  bold: ansi("\x1b[1m"),
  white: ansi("\x1b[37m"),
  black: ansi("\x1b[30m"),
  gray: ansi("\x1b[90m"),
  yellow: ansi("\x1b[33m"),
  green: ansi("\x1b[32m"),
  red: ansi("\x1b[31m"),
  magenta: ansi("\x1b[35m"),
  cyan: ansi("\x1b[36m"),
  blue: ansi("\x1b[34m"),
  bgGreen: ansi("\x1b[42m"),
  bgYellow: ansi("\x1b[43m"),
  bgBlue: ansi("\x1b[44m"),
  bgCyan: ansi("\x1b[46m"),
  bgRed: ansi("\x1b[41m"),
  bgMagenta: ansi("\x1b[45m"),
  bgGray: ansi("\x1b[100m"),
};

const METHOD_STYLE: Record<string, { bg: string; fg: string }> = {
  GET: { bg: C.bgGreen, fg: C.black },
  POST: { bg: C.bgYellow, fg: C.black },
  PUT: { bg: C.bgBlue, fg: C.white },
  PATCH: { bg: C.bgCyan, fg: C.black },
  DELETE: { bg: C.bgRed, fg: C.white },
  ANY: { bg: C.bgGray, fg: C.white },
  WS: { bg: C.bgMagenta, fg: C.white },
  ACTION: { bg: C.bgMagenta, fg: C.white },
};

export function methodBadge(method: string): string {
  const style = METHOD_STYLE[method] ?? { bg: C.bgGray, fg: C.white };
  if (!HAS_COLOR) return ` ${method.padEnd(6)} `;
  return `${style.bg}${style.fg}${C.bold} ${method.padEnd(6)} ${C.reset}`;
}

export function shortenPath(fullPath: string): string {
  const home = process.env.HOME ?? "";
  if (home && fullPath.startsWith(home))
    return "~" + fullPath.slice(home.length);
  return fullPath;
}
