import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import { CONTENT_SPEC_SYMBOL } from "./constants.ts";
import type { ContentSpec, OpenAPIHeader, SchemaInput, TagDefinition } from "./types.ts";

const refNameMap = new WeakMap<object, string>();

export interface ContentOptions {
  description?: string;
  required?: boolean;
  example?: unknown;
  examples?: Record<string, unknown>;
  headers?: Record<string, OpenAPIHeader>;
}

/**
 * Create a content specification for any media type.
 */
export function content(
  contentType: string,
  schema?: SchemaInput,
  options?: string | ContentOptions,
): ContentSpec {
  const opts: ContentOptions =
    typeof options === "string" ? { description: options } : (options ?? {});
  return {
    [CONTENT_SPEC_SYMBOL]: true,
    contentType,
    schema,
    description: opts.description,
    required: opts.required,
    example: opts.example,
    examples: opts.examples,
    headers: opts.headers,
  };
}

/**
 * Create an `application/json` response or request body spec.
 */
export function json(schema: SchemaInput, options?: string | ContentOptions): ContentSpec {
  return content("application/json", schema, options);
}

/**
 * Create a `text/plain` response or request body spec.
 */
export function text(schema?: SchemaInput, options?: string | ContentOptions): ContentSpec {
  return content("text/plain", schema, options);
}

/**
 * Create a `text/html` response spec.
 */
export function html(schema?: SchemaInput, options?: string | ContentOptions): ContentSpec {
  return content("text/html", schema, options);
}

/**
 * Create a binary (`application/octet-stream` by default) response or request body spec.
 */
export function binary(
  contentType = "application/octet-stream",
  options?: string | ContentOptions,
): ContentSpec {
  const opts: ContentOptions =
    typeof options === "string" ? { description: options } : (options ?? {});
  return {
    [CONTENT_SPEC_SYMBOL]: true,
    contentType,
    description: opts.description,
    required: opts.required,
    example: opts.example,
    examples: opts.examples,
    headers: opts.headers,
  };
}

/**
 * Mark a schema to be hoisted into `components.schemas[name]` and referenced via `$ref`.
 * Returns the original schema transparently so it can still be composed (e.g. `z.array(CakeSchema)`)
 * or passed to `validate()`.
 */
export function ref<S extends StandardJSONSchemaV1>(name: string, schema: S): S {
  refNameMap.set(schema, name);
  return schema;
}

export function getRefName(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) {
    return undefined;
  }
  return refNameMap.get(schema);
}

/**
 * Define a reusable OpenAPI 3.2 tag with optional `summary`, `description`, `kind`, and `parent`.
 * Supports `/`-separated hierarchy paths in `name` (e.g. `"products/cakes"` -> `name: "cakes", parent: "products"`).
 */
export function defineTag(definition: TagDefinition): TagDefinition {
  return { ...definition };
}

export function isContentSpec(value: unknown): value is ContentSpec {
  return typeof value === "object" && value !== null && CONTENT_SPEC_SYMBOL in value;
}

export function isStandardJSONSchema(value: unknown): value is StandardJSONSchemaV1 {
  if (typeof value !== "object" || value === null || !("~standard" in value)) {
    return false;
  }
  const std = (value as { "~standard"?: unknown })["~standard"];
  return (
    typeof std === "object" &&
    std !== null &&
    "jsonSchema" in std &&
    typeof (std as { jsonSchema?: unknown }).jsonSchema === "object" &&
    (std as { jsonSchema?: unknown }).jsonSchema !== null
  );
}
