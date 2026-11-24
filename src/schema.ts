import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import { getStatusPhrase } from "./constants.ts";
import { getRefName } from "./helpers.ts";
import type {
  JSONSchemaObject,
  OpenAPIParameter,
  OpenAPIResponseObject,
  SchemaInput,
} from "./types.ts";

const JSON_SCHEMA_TARGETS: readonly StandardJSONSchemaV1.Target[] = [
  "draft-2020-12",
  "draft-07",
  "openapi-3.0",
];

const COMPONENT_NAME_RE = /^[A-Za-z0-9._-]+$/;
const STATUS_KEY_RE = /^(?:[1-5]\d{2}|default)$/;

export class SchemaRegistry {
  readonly schemas: Record<string, JSONSchemaObject> = {};

  /**
   * Convert a Standard JSON Schema (or `ref(name, schema)`) into a normalized OpenAPI JSON Schema.
   * Hoists `$defs`/`definitions` and named schemas into `components.schemas`.
   */
  convert(input: SchemaInput, io: "input" | "output", hoist = true): JSONSchemaObject {
    const explicitName = getRefName(input);
    const raw = convertStandardToJSON(input, io);
    const normalized = this.normalizeSchema(raw);

    if (!hoist) {
      return normalized;
    }

    const schemaId = extractComponentId(normalized);
    const componentName = explicitName ?? schemaId;
    if (componentName) {
      const body = { ...normalized };
      delete body.$id;
      delete body.id;
      if (!(componentName in this.schemas)) {
        this.schemas[componentName] = body;
      }
      return { $ref: `#/components/schemas/${componentName}` };
    }

    return normalized;
  }

  /**
   * Register a static named schema directly into `components.schemas`.
   */
  register(name: string, input: SchemaInput, io: "input" | "output" = "output"): void {
    const raw = convertStandardToJSON(input, io);
    const normalized = this.normalizeSchema(raw);
    delete normalized.$id;
    delete normalized.id;
    this.schemas[name] = normalized;
  }

  /**
   * Resolve a schema's `description`, following `$ref` into `components.schemas` if needed.
   */
  getDescription(schema: JSONSchemaObject): string | undefined {
    if (typeof schema.description === "string" && schema.description.length > 0) {
      return schema.description;
    }
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/components/schemas/")) {
      const refName = schema.$ref.slice("#/components/schemas/".length);
      const target = this.schemas[refName];
      if (target && typeof target.description === "string" && target.description.length > 0) {
        return target.description;
      }
    }
    return undefined;
  }

  private normalizeSchema(raw: JSONSchemaObject): JSONSchemaObject {
    const cloned = structuredClone(raw);
    delete cloned.$schema;

    this.hoistDefs(cloned, "$defs");
    this.hoistDefs(cloned, "definitions");
    rewriteLocalRefs(cloned);

    return cloned;
  }

  private hoistDefs(obj: JSONSchemaObject, key: "$defs" | "definitions"): void {
    const defs = obj[key];
    if (typeof defs !== "object" || defs === null || Array.isArray(defs)) {
      return;
    }
    for (const [defName, defSchema] of Object.entries(defs as Record<string, unknown>)) {
      if (typeof defSchema === "object" && defSchema !== null && !Array.isArray(defSchema)) {
        const normalizedDef = this.normalizeSchema(defSchema as JSONSchemaObject);
        if (!(defName in this.schemas)) {
          this.schemas[defName] = normalizedDef;
        }
      }
    }
    delete obj[key];
  }
}

function convertStandardToJSON(
  schema: StandardJSONSchemaV1,
  io: "input" | "output",
): JSONSchemaObject {
  const converter = schema["~standard"].jsonSchema;
  const ioOrder: readonly ("input" | "output")[] =
    io === "output" ? ["output", "input"] : ["input", "output"];

  let lastError: unknown;
  for (const direction of ioOrder) {
    for (const target of JSON_SCHEMA_TARGETS) {
      try {
        return converter[direction]({ target });
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw new Error(
    `Failed to convert Standard JSON Schema (vendor: "${schema["~standard"].vendor}") to JSON Schema: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function extractComponentId(schema: JSONSchemaObject): string | undefined {
  const candidate =
    typeof schema.$id === "string"
      ? schema.$id
      : typeof schema.id === "string"
        ? schema.id
        : undefined;
  if (candidate && COMPONENT_NAME_RE.test(candidate)) {
    return candidate;
  }
  return undefined;
}

function rewriteLocalRefs(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      rewriteLocalRefs(item);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    if (record.$ref.startsWith("#/$defs/")) {
      record.$ref = `#/components/schemas/${record.$ref.slice("#/$defs/".length)}`;
    } else if (record.$ref.startsWith("#/definitions/")) {
      record.$ref = `#/components/schemas/${record.$ref.slice("#/definitions/".length)}`;
    }
  }
  for (const value of Object.values(record)) {
    rewriteLocalRefs(value);
  }
}

/**
 * Expand an object schema into OpenAPI Parameter objects for `param`, `query`, `header`, or `cookie`.
 */
export function expandParameters(
  input: SchemaInput,
  location: "query" | "header" | "path" | "cookie",
  registry: SchemaRegistry,
): OpenAPIParameter[] {
  const converted = registry.convert(input, "input", false);
  const properties = converted.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return [];
  }

  const requiredSet = new Set(
    Array.isArray(converted.required)
      ? converted.required.filter((item): item is string => typeof item === "string")
      : [],
  );

  const params: OpenAPIParameter[] = [];
  for (const [name, propValue] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof propValue !== "object" || propValue === null || Array.isArray(propValue)) {
      continue;
    }
    const propSchema = propValue as JSONSchemaObject;
    const isRequired = location === "path" ? true : requiredSet.has(name);
    const param: OpenAPIParameter = {
      name,
      in: location,
      schema: propSchema,
    };
    if (isRequired) {
      param.required = true;
    }
    if (typeof propSchema.description === "string" && propSchema.description.length > 0) {
      param.description = propSchema.description;
    }
    if (propSchema.deprecated === true) {
      param.deprecated = true;
    }
    if ("example" in propSchema) {
      param.example = propSchema.example;
    }
    params.push(param);
  }

  return params;
}

/**
 * Unpack a status-code keyed schema (e.g. `z.object({ 200: OkSchema, 500: ErrSchema })`)
 * into a map of OpenAPI Response objects.
 */
export function unpackStatusMapSchema(
  schema: StandardJSONSchemaV1,
  registry: SchemaRegistry,
): Record<string, OpenAPIResponseObject> {
  const converted = registry.convert(schema, "output", false);
  const properties = converted.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new Error(
      "A schema passed directly to `responses` must be an object schema with HTTP status code keys (e.g. 200, 404, 500).",
    );
  }

  const responses: Record<string, OpenAPIResponseObject> = {};
  for (const [key, propValue] of Object.entries(properties as Record<string, unknown>)) {
    if (!STATUS_KEY_RE.test(key)) {
      continue;
    }
    if (typeof propValue !== "object" || propValue === null || Array.isArray(propValue)) {
      continue;
    }
    const subSchema = propValue as JSONSchemaObject;
    const description = registry.getDescription(subSchema) ?? getStatusPhrase(key);

    // If a status branch has an id/$id, hoist it cleanly into components.schemas
    const subId = extractComponentId(subSchema);
    let finalSchema: JSONSchemaObject = subSchema;
    if (subId) {
      const body = { ...subSchema };
      delete body.$id;
      delete body.id;
      if (!(subId in registry.schemas)) {
        registry.schemas[subId] = body;
      }
      finalSchema = { $ref: `#/components/schemas/${subId}` };
    }

    if (key === "204" && subSchema.type === "null") {
      responses[key] = { description };
    } else {
      responses[key] = {
        description,
        content: {
          "application/json": {
            schema: finalSchema,
          },
        },
      };
    }
  }

  return responses;
}
