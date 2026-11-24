import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import type { Hono } from "hono";
import { getStatusPhrase, OPENAPI_HTTP_METHODS } from "./constants.ts";
import { isContentSpec, isStandardJSONSchema } from "./helpers.ts";
import { getRouteMetadata } from "./middleware.ts";
import {
  convertHonoPath,
  isWildcardRoutePath,
  matchesMiddlewareScope,
  normalizePath,
} from "./path.ts";
import { expandParameters, SchemaRegistry, unpackStatusMapSchema } from "./schema.ts";
import type {
  ContentSpec,
  DocGroupOptions,
  DocOptions,
  DocRequestOptions,
  OpenAPIComponents,
  OpenAPIConfig,
  OpenAPIDocument,
  OpenAPIExternalDocs,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPIPathItem,
  OpenAPIRequestBody,
  OpenAPIResponseObject,
  OpenAPITag,
  OpenAPIVersion,
  ResponseMap,
  ResponseShorthand,
  SchemaInput,
  SecurityRequirement,
  SecurityShorthand,
  TagDefinition,
  TagInput,
  TagKind,
  ValidateTarget,
} from "./types.ts";

interface GroupEntry {
  readonly index: number;
  readonly method: string;
  readonly path: string;
  readonly options: DocGroupOptions;
}

interface CollectedRoute {
  readonly firstIndex: number;
  readonly method: string;
  readonly path: string;
  readonly docs: DocOptions[];
  readonly inheritedGroups: DocGroupOptions[];
  readonly validators: Array<{ target: ValidateTarget; schema: StandardJSONSchemaV1 }>;
  hidden: boolean;
}

interface InternalTag {
  name: string;
  summary?: string;
  description?: string;
  externalDocs?: OpenAPIExternalDocs;
  parent?: string;
  explicitNoParent?: boolean;
  kind?: TagKind;
  extensions: Record<`x-${string}`, unknown>;
}

function splitTagPath(rawName: string): string[] {
  const parts = rawName
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return parts.length > 0 ? parts : [rawName];
}

class TagRegistry {
  private readonly tags = new Map<string, InternalTag>();

  register(input: TagInput, inferredParent?: string): InternalTag {
    if (typeof input === "string") {
      const segments = splitTagPath(input);
      let currentParent = inferredParent;
      let leaf!: InternalTag;
      for (const seg of segments) {
        leaf = this.upsertSimple(seg, currentParent);
        currentParent = leaf.name;
      }
      return leaf;
    }

    const segments = splitTagPath(input.name);
    let rootParent: string | undefined;
    let explicitNoParent = false;

    if (input.parent === null) {
      explicitNoParent = true;
    } else if (typeof input.parent === "string") {
      const parentTag = this.register(input.parent);
      rootParent = parentTag.name;
    } else if (typeof input.parent === "object" && input.parent !== null) {
      const parentTag = this.register(input.parent);
      rootParent = parentTag.name;
    } else {
      rootParent = inferredParent;
    }

    // Register any intermediate ancestor segments implied by "/"
    let currentParent = explicitNoParent ? undefined : rootParent;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const ancestor = this.upsertSimple(seg, currentParent);
      currentParent = ancestor.name;
    }

    const leafName = segments[segments.length - 1]!;
    const resolvedLeafParent =
      segments.length > 1
        ? currentParent
        : explicitNoParent
          ? undefined
          : currentParent !== leafName
            ? currentParent
            : undefined;

    const existing = this.tags.get(leafName);
    const extensions = extractExtensions(input);
    const leafExplicitNoParent = segments.length === 1 && explicitNoParent;

    if (existing) {
      if (input.summary !== undefined) existing.summary = input.summary;
      if (input.description !== undefined) existing.description = input.description;
      if (input.externalDocs !== undefined) existing.externalDocs = input.externalDocs;
      if (input.kind !== undefined) existing.kind = input.kind;
      if (leafExplicitNoParent) {
        existing.parent = undefined;
        existing.explicitNoParent = true;
      } else if (
        resolvedLeafParent !== undefined &&
        resolvedLeafParent !== leafName &&
        !existing.explicitNoParent
      ) {
        existing.parent = resolvedLeafParent;
      }
      Object.assign(existing.extensions, extensions);
      return existing;
    }

    const created: InternalTag = {
      name: leafName,
      summary: input.summary,
      description: input.description,
      externalDocs: input.externalDocs,
      parent:
        leafExplicitNoParent || resolvedLeafParent === leafName ? undefined : resolvedLeafParent,
      explicitNoParent: leafExplicitNoParent,
      kind: input.kind,
      extensions,
    };
    this.tags.set(leafName, created);
    return created;
  }

  /**
   * Returns true if `tagName` has `ancestorName` anywhere in its `parent` chain.
   */
  isDescendantOf(tagName: string, ancestorName: string): boolean {
    const visited = new Set<string>();
    let current = this.tags.get(tagName)?.parent;
    while (current && !visited.has(current)) {
      if (current === ancestorName) {
        return true;
      }
      visited.add(current);
      current = this.tags.get(current)?.parent;
    }
    return false;
  }

  private upsertSimple(name: string, parent?: string): InternalTag {
    const validParent = parent && parent !== name ? parent : undefined;
    const existing = this.tags.get(name);
    if (existing) {
      if (!existing.parent && !existing.explicitNoParent && validParent) {
        existing.parent = validParent;
      }
      return existing;
    }
    const created: InternalTag = {
      name,
      parent: validParent,
      extensions: {},
    };
    this.tags.set(name, created);
    return created;
  }

  build(version: OpenAPIVersion): OpenAPITag[] {
    // Ensure any parent referenced only by name exists as a tag entry
    for (const tag of [...this.tags.values()]) {
      if (tag.parent && !this.tags.has(tag.parent)) {
        this.tags.set(tag.parent, {
          name: tag.parent,
          extensions: {},
        });
      }
    }

    // Validate no cycles and topologically sort parents before children
    const ordered: InternalTag[] = [];
    const state = new Map<string, "visiting" | "visited">();

    const visit = (name: string, stack: string[]): void => {
      const currentState = state.get(name);
      if (currentState === "visited") {
        return;
      }
      if (currentState === "visiting") {
        const cycleStart = stack.indexOf(name);
        const cycle = [...stack.slice(cycleStart), name].join(" -> ");
        throw new Error(`Circular tag parent hierarchy detected: ${cycle}`);
      }

      const tag = this.tags.get(name);
      if (!tag) {
        return;
      }

      state.set(name, "visiting");
      if (tag.parent) {
        visit(tag.parent, [...stack, name]);
      }
      state.set(name, "visited");
      ordered.push(tag);
    };

    for (const name of this.tags.keys()) {
      visit(name, []);
    }

    return ordered.map((tag) => formatTag(tag, version));
  }
}

function formatTag(tag: InternalTag, version: OpenAPIVersion): OpenAPITag {
  const out: OpenAPITag = {
    name: tag.name,
  };
  if (version === "3.2.0" && tag.summary !== undefined) {
    out.summary = tag.summary;
  }
  if (tag.description !== undefined) {
    out.description = tag.description;
  }
  if (tag.externalDocs !== undefined) {
    out.externalDocs = tag.externalDocs;
  }
  if (version === "3.2.0" && tag.parent !== undefined) {
    out.parent = tag.parent;
  }
  if (version === "3.2.0" && tag.kind !== undefined) {
    out.kind = tag.kind;
  }
  for (const [key, value] of Object.entries(tag.extensions)) {
    out[key as `x-${string}`] = value;
  }
  return out;
}

function extractExtensions(obj: TagDefinition): Record<`x-${string}`, unknown> {
  const extensions: Record<`x-${string}`, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("x-") && value !== undefined) {
      extensions[key as `x-${string}`] = value;
    }
  }
  return extensions;
}

function isNavTag(tag: InternalTag): boolean {
  return tag.kind === undefined || tag.kind === "nav";
}

function collectInputTags(tag?: TagInput, tags?: TagInput[]): TagInput[] {
  const result: TagInput[] = [];
  if (tag !== undefined) {
    result.push(tag);
  }
  if (tags !== undefined) {
    result.push(...tags);
  }
  return result;
}

/**
 * Generate an OpenAPI 3.2 (or 3.1) specification object from a Hono app.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function generateSpec(app: Hono<any, any, any>, config: OpenAPIConfig): OpenAPIDocument {
  const version: OpenAPIVersion = config.openapi ?? "3.2.0";
  const schemaRegistry = new SchemaRegistry();
  const tagRegistry = new TagRegistry();

  if (config.tags) {
    for (const tag of config.tags) {
      tagRegistry.register(tag);
    }
  }

  if (config.schemas) {
    for (const [name, schema] of Object.entries(config.schemas)) {
      schemaRegistry.register(name, schema);
    }
  }

  const groupEntries: GroupEntry[] = [];
  const routeMap = new Map<string, CollectedRoute>();

  for (let i = 0; i < app.routes.length; i++) {
    const route = app.routes[i];
    if (!route) continue;

    const meta = getRouteMetadata(route.handler);
    const methodUpper = route.method.toUpperCase();
    const methodLower = route.method.toLowerCase();

    if (meta) {
      switch (meta.kind) {
        case "group": {
          groupEntries.push({
            index: i,
            method: methodUpper,
            path: route.path,
            options: meta.options,
          });
          continue;
        }
        case "route": {
          if (!OPENAPI_HTTP_METHODS.has(methodLower) || isWildcardRoutePath(route.path)) {
            continue;
          }
          const collected = getOrCreateRoute(routeMap, i, methodLower, route.path);
          collected.docs.push(meta.options);
          if (meta.inheritedGroups) {
            collected.inheritedGroups.push(...meta.inheritedGroups);
          }
          continue;
        }
        case "validator": {
          if (!OPENAPI_HTTP_METHODS.has(methodLower) || isWildcardRoutePath(route.path)) {
            continue;
          }
          const collected = getOrCreateRoute(routeMap, i, methodLower, route.path);
          collected.validators.push({ target: meta.target, schema: meta.schema });
          continue;
        }
        case "hide": {
          if (!OPENAPI_HTTP_METHODS.has(methodLower) || isWildcardRoutePath(route.path)) {
            continue;
          }
          const collected = getOrCreateRoute(routeMap, i, methodLower, route.path);
          collected.hidden = true;
          continue;
        }
        default: {
          const _exhaustive: never = meta;
          void _exhaustive;
          continue;
        }
      }
    }

    // Plain handler without metadata (may still be documented via docGroup or includeUndocumented)
    if (!OPENAPI_HTTP_METHODS.has(methodLower) || isWildcardRoutePath(route.path)) {
      continue;
    }
    getOrCreateRoute(routeMap, i, methodLower, route.path);
  }

  const paths: Record<string, OpenAPIPathItem> = {};

  for (const collected of routeMap.values()) {
    if (collected.hidden) {
      continue;
    }

    const matchedGroups = groupEntries
      .filter(
        (g) =>
          g.index < collected.firstIndex &&
          (g.method === "ALL" || g.method.toLowerCase() === collected.method) &&
          matchesMiddlewareScope(g.path, collected.path),
      )
      .map((g) => g.options);

    const allGroups = [...matchedGroups, ...collected.inheritedGroups];

    const isHiddenByGroup = allGroups.some((g) => g.hide === true);
    const isHiddenByDoc = collected.docs.some((d) => d.hide === true);
    if (isHiddenByGroup || isHiddenByDoc) {
      continue;
    }

    const hasMetadata =
      collected.docs.length > 0 || collected.validators.length > 0 || allGroups.length > 0;
    if (!hasMetadata && !config.includeUndocumented) {
      continue;
    }

    const { openAPIPath, implicitParams } = convertHonoPath(collected.path);
    const operation = buildOperation(
      collected,
      allGroups,
      implicitParams,
      schemaRegistry,
      tagRegistry,
    );

    let pathItem = paths[openAPIPath];
    if (!pathItem) {
      pathItem = {};
      paths[openAPIPath] = pathItem;
    }
    (pathItem as Record<string, unknown>)[collected.method] = operation;
  }

  const document: OpenAPIDocument = {
    openapi: version,
    info: config.info,
    paths,
  };

  if (version === "3.2.0" && config.$self) {
    document.$self = config.$self;
  }
  if (config.servers && config.servers.length > 0) {
    document.servers = config.servers;
  }
  if (config.externalDocs) {
    document.externalDocs = config.externalDocs;
  }

  const docSecurity = resolveSecurity(config.defaultSecurity);
  if (docSecurity !== undefined) {
    document.security = docSecurity;
  }

  const builtTags = tagRegistry.build(version);
  if (builtTags.length > 0) {
    document.tags = builtTags;
  }

  const components: OpenAPIComponents = {};
  if (Object.keys(schemaRegistry.schemas).length > 0) {
    components.schemas = schemaRegistry.schemas;
  }
  if (config.securitySchemes && Object.keys(config.securitySchemes).length > 0) {
    components.securitySchemes = config.securitySchemes;
  }
  if (Object.keys(components).length > 0) {
    document.components = components;
  }

  return document;
}

function getOrCreateRoute(
  map: Map<string, CollectedRoute>,
  index: number,
  method: string,
  path: string,
): CollectedRoute {
  const normalized = normalizePath(path);
  const key = `${method} ${normalized}`;
  let entry = map.get(key);
  if (!entry) {
    entry = {
      firstIndex: index,
      method,
      path: normalized,
      docs: [],
      inheritedGroups: [],
      validators: [],
      hidden: false,
    };
    map.set(key, entry);
  }
  return entry;
}

function buildOperation(
  collected: CollectedRoute,
  groups: readonly DocGroupOptions[],
  implicitParams: readonly OpenAPIParameter[],
  schemaRegistry: SchemaRegistry,
  tagRegistry: TagRegistry,
): OpenAPIOperation {
  const mergedDoc = mergeDocOptions(collected.docs);

  // 1. Resolve nested group tags and route tags
  const operationTags = resolveOperationTags(groups, mergedDoc, tagRegistry);

  // 2. Resolve security (route > inner group > outer group)
  let securityShorthand: SecurityShorthand | undefined;
  for (const group of groups) {
    if (group.security !== undefined) {
      securityShorthand = group.security;
    }
  }
  if (mergedDoc.security !== undefined) {
    securityShorthand = mergedDoc.security;
  }
  const security = resolveSecurity(securityShorthand);

  // 3. Resolve deprecated
  let deprecated = false;
  for (const group of groups) {
    if (group.deprecated !== undefined) {
      deprecated = group.deprecated;
    }
  }
  if (mergedDoc.deprecated !== undefined) {
    deprecated = mergedDoc.deprecated;
  }

  // 4. Resolve parameters & requestBody from validate() + doc.request
  const { parameters, requestBody } = resolveRequest(
    implicitParams,
    collected.validators,
    mergedDoc.request,
    schemaRegistry,
  );

  // 5. Resolve responses (group defaults merged outer -> inner, then route overrides)
  const responses = resolveResponses(groups, mergedDoc.responses, schemaRegistry);

  const operation: OpenAPIOperation = {
    responses,
  };

  if (operationTags.length > 0) {
    operation.tags = operationTags;
  }
  if (mergedDoc.summary !== undefined) {
    operation.summary = mergedDoc.summary;
  }
  if (mergedDoc.description !== undefined) {
    operation.description = mergedDoc.description;
  }
  if (mergedDoc.operationId !== undefined) {
    operation.operationId = mergedDoc.operationId;
  }
  if (mergedDoc.externalDocs !== undefined) {
    operation.externalDocs = mergedDoc.externalDocs;
  }
  if (parameters.length > 0) {
    operation.parameters = parameters;
  }
  if (requestBody !== undefined) {
    operation.requestBody = requestBody;
  }
  if (deprecated) {
    operation.deprecated = true;
  }
  if (security !== undefined) {
    operation.security = security;
  }
  if (mergedDoc.extensions) {
    for (const [key, value] of Object.entries(mergedDoc.extensions)) {
      operation[key as `x-${string}`] = value;
    }
  }

  return operation;
}

function mergeDocOptions(docs: readonly DocOptions[]): DocOptions {
  if (docs.length === 0) {
    return {};
  }
  if (docs.length === 1) {
    return docs[0] ?? {};
  }

  const merged: DocOptions = {};
  const allTags: TagInput[] = [];
  for (const d of docs) {
    if (d.summary !== undefined) merged.summary = d.summary;
    if (d.description !== undefined) merged.description = d.description;
    if (d.operationId !== undefined) merged.operationId = d.operationId;
    if (d.security !== undefined) merged.security = d.security;
    if (d.deprecated !== undefined) merged.deprecated = d.deprecated;
    if (d.externalDocs !== undefined) merged.externalDocs = d.externalDocs;
    if (d.hide !== undefined) merged.hide = d.hide;
    if (d.request) {
      merged.request = { ...merged.request, ...d.request };
    }
    if (d.responses !== undefined) {
      merged.responses = d.responses;
    }
    if (d.extensions) {
      merged.extensions = { ...merged.extensions, ...d.extensions };
    }
    allTags.push(...collectInputTags(d.tag, d.tags));
  }
  if (allTags.length > 0) {
    merged.tags = allTags;
  }
  return merged;
}

function resolveOperationTags(
  groups: readonly DocGroupOptions[],
  routeDoc: DocOptions,
  tagRegistry: TagRegistry,
): string[] {
  let currentNavParent: string | undefined;
  let activeNavTags: string[] = [];
  const additiveTags: string[] = [];

  for (const group of groups) {
    const inputs = collectInputTags(group.tag, group.tags);
    const layerNavTags: string[] = [];

    for (const input of inputs) {
      const registered = tagRegistry.register(input, currentNavParent);
      if (isNavTag(registered)) {
        layerNavTags.push(registered.name);
      } else {
        additiveTags.push(registered.name);
      }
    }

    if (layerNavTags.length > 0) {
      activeNavTags = layerNavTags;
      currentNavParent = layerNavTags[0];
    }
  }

  const routeInputs = collectInputTags(routeDoc.tag, routeDoc.tags);
  const finalNavTags = [...activeNavTags];

  for (const input of routeInputs) {
    const registered = tagRegistry.register(input);
    if (isNavTag(registered)) {
      // If route tag is a descendant of an active group nav tag (e.g. "orders/wholesale" inside "orders"),
      // replace that ancestor on the operation with the leaf tag.
      const ancestorIdx = finalNavTags.findIndex((activeTag) =>
        tagRegistry.isDescendantOf(registered.name, activeTag),
      );
      if (ancestorIdx !== -1) {
        finalNavTags.splice(ancestorIdx, 1, registered.name);
      } else {
        finalNavTags.push(registered.name);
      }
    } else {
      additiveTags.push(registered.name);
    }
  }

  return Array.from(new Set([...finalNavTags, ...additiveTags]));
}

function resolveSecurity(input: SecurityShorthand | undefined): SecurityRequirement[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input === "public" || input === false) {
    return [];
  }
  if (typeof input === "string") {
    return [{ [input]: [] }];
  }
  if (Array.isArray(input)) {
    if (input.length === 0) {
      return [];
    }
    return input.map((item) => {
      if (typeof item === "string") {
        return { [item]: [] };
      }
      return item as SecurityRequirement;
    });
  }
  return undefined;
}

function resolveRequest(
  implicitParams: readonly OpenAPIParameter[],
  validators: readonly { target: ValidateTarget; schema: StandardJSONSchemaV1 }[],
  requestDoc: DocRequestOptions | undefined,
  schemaRegistry: SchemaRegistry,
): { parameters: OpenAPIParameter[]; requestBody?: OpenAPIRequestBody } {
  const paramMap = new Map<string, OpenAPIParameter>();
  for (const param of implicitParams) {
    paramMap.set(`${param.in}:${param.name}`, { ...param });
  }

  let requestBody: OpenAPIRequestBody | undefined;

  const mergeParams = (params: OpenAPIParameter[]): void => {
    for (const p of params) {
      const key = `${p.in}:${p.name}`;
      const existing = paramMap.get(key);
      if (existing) {
        paramMap.set(key, {
          ...existing,
          ...p,
          required: p.in === "path" ? (existing.required ?? true) : p.required,
        });
      } else {
        paramMap.set(key, p);
      }
    }
  };

  for (const v of validators) {
    switch (v.target) {
      case "param":
        mergeParams(expandParameters(v.schema, "path", schemaRegistry));
        break;
      case "query":
        mergeParams(expandParameters(v.schema, "query", schemaRegistry));
        break;
      case "header":
        mergeParams(expandParameters(v.schema, "header", schemaRegistry));
        break;
      case "cookie":
        mergeParams(expandParameters(v.schema, "cookie", schemaRegistry));
        break;
      case "json":
        requestBody = buildJsonRequestBody(v.schema, schemaRegistry);
        break;
      case "form":
        requestBody = buildFormRequestBody(v.schema, schemaRegistry);
        break;
      default: {
        const _exhaustive: never = v.target;
        void _exhaustive;
      }
    }
  }

  if (requestDoc) {
    if (requestDoc.params) {
      mergeParams(expandParameters(requestDoc.params, "path", schemaRegistry));
    }
    if (requestDoc.query) {
      mergeParams(expandParameters(requestDoc.query, "query", schemaRegistry));
    }
    if (requestDoc.headers) {
      mergeParams(expandParameters(requestDoc.headers, "header", schemaRegistry));
    }
    if (requestDoc.cookies) {
      mergeParams(expandParameters(requestDoc.cookies, "cookie", schemaRegistry));
    }
    if (requestDoc.json) {
      requestBody = buildJsonRequestBody(requestDoc.json, schemaRegistry);
    }
    if (requestDoc.form) {
      requestBody = buildFormRequestBody(requestDoc.form, schemaRegistry);
    }
    if (requestDoc.body) {
      requestBody = buildGenericRequestBody(requestDoc.body, schemaRegistry);
    }
  }

  return {
    parameters: Array.from(paramMap.values()),
    requestBody,
  };
}

function buildJsonRequestBody(schema: SchemaInput, registry: SchemaRegistry): OpenAPIRequestBody {
  const jsonSchema = registry.convert(schema, "input");
  const description = registry.getDescription(jsonSchema);
  return {
    required: true,
    ...(description ? { description } : {}),
    content: {
      "application/json": { schema: jsonSchema },
    },
  };
}

function buildFormRequestBody(schema: SchemaInput, registry: SchemaRegistry): OpenAPIRequestBody {
  const jsonSchema = registry.convert(schema, "input");
  const description = registry.getDescription(jsonSchema);
  return {
    required: true,
    ...(description ? { description } : {}),
    content: {
      "application/x-www-form-urlencoded": { schema: jsonSchema },
    },
  };
}

function buildGenericRequestBody(
  body: SchemaInput | ContentSpec | OpenAPIRequestBody,
  registry: SchemaRegistry,
): OpenAPIRequestBody {
  if (isContentSpec(body)) {
    const schema = body.schema ? registry.convert(body.schema, "input") : undefined;
    return {
      required: body.required ?? true,
      ...(body.description ? { description: body.description } : {}),
      content: {
        [body.contentType]: {
          ...(schema ? { schema } : {}),
          ...(body.example !== undefined ? { example: body.example } : {}),
          ...(body.examples !== undefined ? { examples: body.examples } : {}),
        },
      },
    };
  }
  if (isStandardJSONSchema(body)) {
    return buildJsonRequestBody(body, registry);
  }
  return body;
}

function resolveResponses(
  groups: readonly DocGroupOptions[],
  routeResponses: DocOptions["responses"],
  registry: SchemaRegistry,
): Record<string, OpenAPIResponseObject> {
  const merged: Record<string, OpenAPIResponseObject> = {};

  for (const group of groups) {
    if (group.responses) {
      applyResponseMap(merged, group.responses, registry);
    }
  }

  if (routeResponses !== undefined) {
    if (isStandardJSONSchema(routeResponses)) {
      const unpacked = unpackStatusMapSchema(routeResponses, registry);
      Object.assign(merged, unpacked);
    } else {
      applyResponseMap(merged, routeResponses, registry);
    }
  }

  if (Object.keys(merged).length === 0) {
    merged["200"] = { description: getStatusPhrase("200") };
  }

  return merged;
}

function applyResponseMap(
  target: Record<string, OpenAPIResponseObject>,
  map: ResponseMap,
  registry: SchemaRegistry,
): void {
  for (const [rawStatus, value] of Object.entries(map)) {
    if (value === undefined) continue;
    if (value === false) {
      delete target[rawStatus];
      continue;
    }
    target[rawStatus] = normalizeResponseShorthand(rawStatus, value, registry);
  }
}

function normalizeResponseShorthand(
  status: string,
  shorthand: ResponseShorthand,
  registry: SchemaRegistry,
): OpenAPIResponseObject {
  // 1. Empty response with default status phrase
  if (shorthand === null) {
    return { description: getStatusPhrase(status) };
  }

  // 2. Description-only response (e.g. 204: "Deleted successfully")
  if (typeof shorthand === "string") {
    return { description: shorthand };
  }

  // 3. Tuple [schema, description]
  if (Array.isArray(shorthand)) {
    const [schema, description] = shorthand as readonly [SchemaInput, string];
    const jsonSchema = registry.convert(schema, "output");
    return {
      description,
      content: {
        "application/json": { schema: jsonSchema },
      },
    };
  }

  // 4. Content helper: json(), text(), html(), binary(), content()
  if (isContentSpec(shorthand)) {
    const schema = shorthand.schema
      ? registry.convert(shorthand.schema, "output")
      : shorthand.contentType.startsWith("application/octet-stream") ||
          shorthand.contentType.startsWith("image/") ||
          shorthand.contentType.startsWith("audio/") ||
          shorthand.contentType.startsWith("video/")
        ? { type: "string", contentEncoding: "binary" }
        : undefined;
    const description =
      shorthand.description ??
      (schema ? registry.getDescription(schema) : undefined) ??
      getStatusPhrase(status);
    const out: OpenAPIResponseObject = {
      description,
      content: {
        [shorthand.contentType]: {
          ...(schema ? { schema } : {}),
          ...(shorthand.example !== undefined ? { example: shorthand.example } : {}),
          ...(shorthand.examples !== undefined ? { examples: shorthand.examples } : {}),
        },
      },
    };
    if (shorthand.headers) {
      out.headers = shorthand.headers;
    }
    return out;
  }

  // 5. Direct Standard Schema or ref(name, schema)
  if (isStandardJSONSchema(shorthand)) {
    const jsonSchema = registry.convert(shorthand, "output");
    const description = registry.getDescription(jsonSchema) ?? getStatusPhrase(status);
    return {
      description,
      content: {
        "application/json": { schema: jsonSchema },
      },
    };
  }

  // 6. Raw OpenAPIResponseObject passthrough
  return shorthand as OpenAPIResponseObject;
}
