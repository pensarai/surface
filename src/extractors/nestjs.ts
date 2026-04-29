import type { EndpointInfo, EndpointKind, Extractor } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  normalizePath,
} from "../utils.ts";

// ---------------------------------------------------------------------------
// Kind detection signals
// ---------------------------------------------------------------------------
//   - Default: a controller method with @Get/@Post/... → kind: "api"
//   - @Render('view') decorator on a method → kind: "page" (server-side
//     rendered template; the method returns view data, not JSON)
//   - @WebSocketGateway() class + @SubscribeMessage('event') method →
//     kind: "websocket" (event-driven socket handler, not an HTTP route)
// ---------------------------------------------------------------------------

interface ClassRange {
  start: number;
  end: number;
  name: string;
  // Decorators attached to the class declaration (text immediately preceding
  // the `class` keyword, back to the previous class or top of file).
  decorators: string;
}

/** Find every `class Foo` declaration with the decorator preamble that
 *  immediately precedes it. Used to associate methods with their owning
 *  class so we can read class-level decorators (e.g. @WebSocketGateway,
 *  @Controller). */
function findClasses(content: string): ClassRange[] {
  const classes: ClassRange[] = [];
  const classRe = /\bclass\s+(\w+)/g;
  let lastEnd = 0;
  for (const m of content.matchAll(classRe)) {
    const start = m.index!;
    const name = m[1]!;
    const decorators = content.slice(lastEnd, start);
    // Patch the previous class's `end` to be this class's start
    if (classes.length > 0) classes[classes.length - 1]!.end = start;
    classes.push({ start, end: content.length, name, decorators });
    lastEnd = start;
  }
  return classes;
}

// Returns the contiguous decorator stack around `offset` (the position of an
// `@Get/@Post/...` match), walking outward line-by-line. Stops at lines that
// end the previous method or statement (}, ;) or otherwise look like code,
// so a `@Render` on a sibling method cannot bleed into the result.
function methodDecoratorBlock(content: string, offset: number): string {
  const lineStart = (pos: number) => {
    let p = pos;
    while (p > 0 && content[p - 1] !== "\n") p--;
    return p;
  };
  const isStackLine = (line: string) =>
    line === "" ||
    line.startsWith("@") ||
    line.startsWith("//") ||
    line.startsWith("/*") ||
    line.startsWith("*") ||
    line.endsWith(",") ||
    line.endsWith("(") ||
    line.endsWith(")");
  const endsPrevStatement = (line: string) =>
    line.endsWith("}") || line.endsWith(";");

  // Walk backwards from the @Get line.
  let start = lineStart(offset);
  while (start > 0) {
    const prev = lineStart(start - 1);
    const line = content.slice(prev, start - 1).trim();
    if (endsPrevStatement(line)) break;
    if (!isStackLine(line)) break;
    start = prev;
  }

  // Walk forwards past any decorators between @Get and the method signature.
  // The method signature is the first line that doesn't start with `@` and
  // isn't a continuation of decorator args.
  let end = offset;
  while (end < content.length && content[end] !== "\n") end++;
  while (end < content.length) {
    const nextStart = end + 1;
    let nextEnd = nextStart;
    while (nextEnd < content.length && content[nextEnd] !== "\n") nextEnd++;
    const line = content.slice(nextStart, nextEnd).trim();
    if (line === "") {
      end = nextEnd;
      continue;
    }
    if (line.startsWith("@") || line.startsWith("//") || line.startsWith("*")) {
      end = nextEnd;
      continue;
    }
    if (line.endsWith(",") || line.endsWith(")")) {
      // Continuation of a multi-line decorator argument list.
      end = nextEnd;
      continue;
    }
    break;
  }

  return content.slice(start, end);
}

export const nestjs: Extractor = {
  id: "nestjs",
  detect: { depKeywords: ["@nestjs/core"], markers: [], scope: "root" },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const tsFiles = ctx.iterFiles([".ts"]);

    const controllerRe = /@Controller\s*\(\s*['"]([^'"]*)['"]\s*\)/;
    const wsGatewayRe = /@WebSocketGateway\s*\(([^)]*)\)|@WebSocketGateway\b/;
    // Captures: 1=method, 2=path, 3=between (text from after ) to handler), 4=handler
    // The lazy `.*?` may stop short if a Nest decorator like @Render / @Header
    // follows the http verb — those would otherwise be captured as the handler
    // name. We re-scan a forward window after the match to catch them.
    const methodRe =
      /@(Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*['"]?([^'")]*?)['"]?\s*\)(.*?)(?:async\s+)?(\w+)\s*\(/gs;
    // @SubscribeMessage('event'): websocket event handler
    const subscribeRe =
      /@SubscribeMessage\s*\(\s*['"]([^'"]*)['"]\s*\)(.*?)(?:async\s+)?(\w+)\s*\(/gs;
    const guardRe = /@UseGuards?\s*\(\s*(\w+)/g;

    for (const f of tsFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      // Only consider files that look like Nest classes — controllers or gateways.
      if (
        !content.includes("@Controller") &&
        !content.includes("@WebSocketGateway")
      )
        continue;
      const rel = ctx.rel(f);

      const lines = buildLineIndex(content);
      const classes = findClasses(content);

      // Fallback: file-level controller prefix (used when methods appear
      // outside any class, or the class scan fails for some reason).
      const fileCtrlMatch = controllerRe.exec(content);
      const fileControllerPrefix = fileCtrlMatch?.[1] ?? "";

      // Class-level guards from the very first class block (legacy behaviour).
      const fileClassAuth: string[] = [];
      const firstClassIdx = content.indexOf("class ");
      if (firstClassIdx > 0) {
        const preClass = content.slice(0, firstClassIdx);
        for (const gm of preClass.matchAll(guardRe)) {
          fileClassAuth.push(`@UseGuards(${gm[1]})`);
        }
      }

      // Resolve the class containing a given offset (or null if none).
      const classAt = (offset: number): ClassRange | null => {
        for (const c of classes) {
          if (offset >= c.start && offset < c.end) return c;
        }
        return null;
      };

      // Per-class context: prefix, guards, whether it's a websocket gateway,
      // and an optional namespace pulled out of @WebSocketGateway options.
      const classCtx = new Map<
        string,
        {
          prefix: string;
          auth: string[];
          isGateway: boolean;
          wsNamespace: string;
        }
      >();
      for (const c of classes) {
        const ctrl = controllerRe.exec(c.decorators);
        const prefix = ctrl?.[1] ?? "";
        const auth: string[] = [];
        for (const gm of c.decorators.matchAll(guardRe)) {
          auth.push(`@UseGuards(${gm[1]})`);
        }
        const ws = wsGatewayRe.exec(c.decorators);
        const isGateway = !!ws;
        // @WebSocketGateway(81, { namespace: '/events' })  → '/events'
        let wsNamespace = "";
        if (ws && ws[1]) {
          const nsMatch = /namespace\s*:\s*['"]([^'"]*)['"]/.exec(ws[1]);
          if (nsMatch) wsNamespace = nsMatch[1]!;
        }
        classCtx.set(c.name, { prefix, auth, isGateway, wsNamespace });
      }

      // -----------------------------------------------------------------
      // HTTP method handlers (@Get/@Post/...): kind = "api" or "page"
      // -----------------------------------------------------------------
      for (const m of content.matchAll(methodRe)) {
        const httpMethod = m[1]!.toUpperCase();
        const routePath = m[2]!;
        const between = m[3]!;
        let handler = m[4]!;
        const offset = m.index!;
        const line = lines.lineAt(offset);

        // The lazy capture may have grabbed a Nest decorator name (e.g.
        // @Render, @Header) as the "handler" because that decorator sits
        // between @Get and the real method. If `between` still contains an
        // `@`, walk forward past any remaining decorators to find the real
        // handler identifier.
        if (between.includes("@")) {
          const fwd = content.slice(offset, offset + 600);
          const after = fwd.indexOf(")");
          if (after >= 0) {
            const handlerRe =
              /(?:@\w+\s*\([^)]*\)\s*)*(?:async\s+)?(\w+)\s*\(/g;
            handlerRe.lastIndex = after + 1;
            const hm = handlerRe.exec(fwd);
            if (hm) handler = hm[1]!;
          }
        }

        // Pick up class-level info if the match is inside a class; fall back
        // to the legacy file-level lookup otherwise.
        const cls = classAt(offset);
        const prefix = cls
          ? (classCtx.get(cls.name)?.prefix ?? "")
          : fileControllerPrefix;
        const classAuth = cls
          ? (classCtx.get(cls.name)?.auth ?? [])
          : fileClassAuth;

        const fullPath = normalizePath(prefix + "/" + routePath);
        const params = extractPathParams(fullPath);

        const methodAuth = [...classAuth];
        for (const gm of between.matchAll(/@UseGuards?\s*\(\s*(\w+)/g)) {
          methodAuth.push(`@UseGuards(${gm[1]})`);
        }

        const searchText = between + m[0];
        for (const pm of searchText.matchAll(/@Query\s*\(\s*['"]?(\w+)/g)) {
          params.push({ name: pm[1]!, location: "query", required: true });
        }
        for (const pm of searchText.matchAll(/@Param\s*\(\s*['"]?(\w+)/g)) {
          params.push({ name: pm[1]!, location: "path", required: true });
        }

        // @Render decorator on the method = server-side rendered page →
        // kind: "page". The decorator may appear before @Get in the preceding
        // decorator stack, or between @Get and the handler. Walk line-by-line
        // out from the @Get match to capture exactly the contiguous decorator
        // stack of THIS method — stopping at any line that ends a previous
        // method or statement (}, ;) so we don't bleed into adjacent methods.
        const decoratorBlock = methodDecoratorBlock(content, offset);
        const hasRender = /@Render\s*\(/.test(decoratorBlock);
        const kind: EndpointKind = hasRender ? "page" : "api";

        endpoints.push(
          endpoint({
            method: httpMethod,
            path: fullPath,
            handler,
            file: rel,
            line,
            framework: "nestjs",
            kind,
            params,
            auth: methodAuth,
          }),
        );
      }

      // -----------------------------------------------------------------
      // Websocket handlers: @SubscribeMessage inside an @WebSocketGateway
      // class. Path = (gateway namespace) + event name. method = "WS".
      // -----------------------------------------------------------------
      for (const m of content.matchAll(subscribeRe)) {
        const eventName = m[1]!;
        const between = m[2]!;
        const handler = m[3]!;
        const offset = m.index!;
        const line = lines.lineAt(offset);

        const cls = classAt(offset);
        if (!cls) continue;
        const info = classCtx.get(cls.name);
        if (!info || !info.isGateway) continue;

        const fullPath = normalizePath(
          (info.wsNamespace || "") + "/" + eventName,
        );

        const methodAuth = [...info.auth];
        for (const gm of between.matchAll(/@UseGuards?\s*\(\s*(\w+)/g)) {
          methodAuth.push(`@UseGuards(${gm[1]})`);
        }

        endpoints.push(
          endpoint({
            method: "WS",
            path: fullPath,
            handler,
            file: rel,
            line,
            framework: "nestjs",
            kind: "websocket",
            params: extractPathParams(fullPath),
            auth: methodAuth,
          }),
        );
      }
    }

    return endpoints;
  },
};
