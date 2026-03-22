import type { FunctionDef } from "./types.ts";

/**
 * Language-aware function/method boundary detection.
 *
 * Returns function definitions sorted by line number.
 * Used by impact analysis to resolve "which function encloses this hunk?"
 */
export function findFunctions(content: string, ext: string): FunctionDef[] {
  const patterns = PATTERNS_BY_EXT[ext];
  if (!patterns) return [];

  const lines = content.split("\n");
  const defs: FunctionDef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const pat of patterns) {
      const m = pat.exec(line);
      if (m && m[1]) {
        defs.push({ name: m[1], line: i + 1 });
        break; // one match per line
      }
    }
  }

  return defs;
}

// ---------------------------------------------------------------------------
// Language patterns — each regex must capture the function name in group 1
// ---------------------------------------------------------------------------

const PY_PATTERNS = [/^\s*(?:async\s+)?def\s+(\w+)\s*\(/];

const TS_JS_PATTERNS = [
  // function declarations
  /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/,
  // arrow / function-expr assigned to const/let/var
  /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])*=>/,
  /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/,
  // class method (including async)
  /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
];

const GO_PATTERNS = [
  // func Name(  or  func (recv) Name(
  /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/,
];

const RB_PATTERNS = [/^\s*def\s+(\w+)/];

const JAVA_PATTERNS = [
  // access modifier + optional static/final + return type + name(
  /(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/,
];

const PHP_PATTERNS = [
  /(?:public|private|protected)?\s*(?:static\s+)?function\s+(\w+)\s*\(/,
];

const RS_PATTERNS = [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[(<]/];

const PATTERNS_BY_EXT: Record<string, RegExp[]> = {
  ".py": PY_PATTERNS,
  ".ts": TS_JS_PATTERNS,
  ".tsx": TS_JS_PATTERNS,
  ".js": TS_JS_PATTERNS,
  ".jsx": TS_JS_PATTERNS,
  ".mjs": TS_JS_PATTERNS,
  ".go": GO_PATTERNS,
  ".rb": RB_PATTERNS,
  ".java": JAVA_PATTERNS,
  ".kt": JAVA_PATTERNS,
  ".php": PHP_PATTERNS,
  ".rs": RS_PATTERNS,
};
