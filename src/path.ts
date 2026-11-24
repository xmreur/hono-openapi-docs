import type { OpenAPIParameter } from "./types.ts";

export interface ConvertedHonoPath {
  readonly openAPIPath: string;
  readonly implicitParams: OpenAPIParameter[];
}

/**
 * Convert a Hono route path (e.g. `/users/:id{[0-9]+}`, `/posts/:slug?`)
 * into an OpenAPI path (`/users/{id}`, `/posts/{slug}`) and extract implicit path params.
 */
export function convertHonoPath(honoPath: string): ConvertedHonoPath {
  const normalized = normalizePath(honoPath);
  if (normalized === "/") {
    return { openAPIPath: "/", implicitParams: [] };
  }

  const segments = normalized.split("/").filter(Boolean);
  const outSegments: string[] = [];
  const implicitParams: OpenAPIParameter[] = [];

  for (const segment of segments) {
    if (!segment.startsWith(":")) {
      outSegments.push(segment);
      continue;
    }

    const parsed = parseParamSegment(segment);
    if (!parsed) {
      outSegments.push(segment);
      continue;
    }

    outSegments.push(`{${parsed.name}}`);
    implicitParams.push({
      name: parsed.name,
      in: "path",
      required: !parsed.optional,
      schema: parsed.pattern ? { type: "string", pattern: parsed.pattern } : { type: "string" },
    });
  }

  return {
    openAPIPath: `/${outSegments.join("/")}`,
    implicitParams,
  };
}

interface ParsedParamSegment {
  name: string;
  pattern?: string;
  optional: boolean;
}

function parseParamSegment(segment: string): ParsedParamSegment | null {
  // Strip leading ":"
  const body = segment.slice(1);
  if (body.length === 0) {
    return null;
  }

  const optional = body.endsWith("?");
  const withoutOpt = optional ? body.slice(0, -1) : body;

  const braceStart = withoutOpt.indexOf("{");
  if (braceStart === -1) {
    return { name: withoutOpt, optional };
  }

  const name = withoutOpt.slice(0, braceStart);
  if (!name || !withoutOpt.endsWith("}")) {
    return null;
  }

  const pattern = withoutOpt.slice(braceStart + 1, -1);
  return {
    name,
    pattern: pattern.length > 0 ? pattern : undefined,
    optional,
  };
}

/**
 * Returns true if the Hono route path contains a wildcard `*` segment.
 */
export function isWildcardRoutePath(path: string): boolean {
  return path.includes("*");
}

/**
 * Normalize a path to always start with `/` and have no trailing slash (except `/`).
 */
export function normalizePath(path: string): string {
  if (!path || path === "/") {
    return "/";
  }
  const withLeading = path.startsWith("/") ? path : `/${path}`;
  return withLeading.length > 1 && withLeading.endsWith("/")
    ? withLeading.slice(0, -1)
    : withLeading;
}

/**
 * Match a Hono middleware path pattern (e.g. `/*`, `/system/*`, `/api/:version/*`)
 * against a concrete route path (e.g. `/system`, `/system/health`).
 */
export function matchesMiddlewareScope(middlewarePath: string, routePath: string): boolean {
  if (middlewarePath === "*" || middlewarePath === "/*") {
    return true;
  }

  const mwSegments = normalizePath(middlewarePath).split("/").filter(Boolean);
  const routeSegments = normalizePath(routePath).split("/").filter(Boolean);

  for (let i = 0; i < mwSegments.length; i++) {
    const mwSeg = mwSegments[i];
    if (mwSeg === undefined) {
      break;
    }

    // Trailing wildcard `/prefix/*` matches `/prefix` (0 remaining) and `/prefix/a/b` (N remaining)
    if (mwSeg === "*") {
      return true;
    }

    const routeSeg = routeSegments[i];
    if (routeSeg === undefined) {
      return false;
    }

    if (mwSeg.startsWith(":")) {
      continue;
    }

    if (mwSeg !== routeSeg) {
      return false;
    }
  }

  return mwSegments.length === routeSegments.length;
}
