import { describe, expect, test } from "bun:test";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { Hono } from "hono";
import * as v from "valibot";
import { z } from "zod";
import { doc, generateSpec, ref } from "../src/index.ts";
import { expandParameters, SchemaRegistry, unpackStatusMapSchema } from "../src/schema.ts";

/**
 * Helper showing how any Standard Schema library (like Valibot) with a Standard JSON Schema
 * adapter works seamlessly without any vendor-specific code in `hono-openapi-docs`.
 */
function withJsonSchema<S extends StandardSchemaV1>(
  schema: S,
  jsonSchema: Record<string, unknown>,
): S & StandardJSONSchemaV1 {
  return {
    ...schema,
    "~standard": {
      ...schema["~standard"],
      jsonSchema: {
        input: () => ({ $schema: "https://json-schema.org/draft/2020-12/schema", ...jsonSchema }),
        output: () => ({ $schema: "https://json-schema.org/draft/2020-12/schema", ...jsonSchema }),
      },
    },
  };
}

describe("SchemaRegistry & Standard JSON Schema conversion", () => {
  test("converts Zod v4 schemas and strips $schema", () => {
    const registry = new SchemaRegistry();
    const UserSchema = z.object({
      id: z.string(),
      email: z.email(),
      age: z.number().int().optional(),
    });

    const result = registry.convert(UserSchema, "output");
    expect(result.$schema).toBeUndefined();
    expect(result.type).toBe("object");
    expect(result.required).toEqual(["id", "email"]);
    expect((result.properties as Record<string, unknown>).id).toEqual({ type: "string" });
  });

  test("hoists ref(name, schema) into components.schemas and deduplicates", () => {
    const registry = new SchemaRegistry();
    const ErrorSchema = ref(
      "ApiError",
      z.object({ code: z.string(), message: z.string() }).describe("API error payload"),
    );

    const first = registry.convert(ErrorSchema, "output");
    const second = registry.convert(ErrorSchema, "output");

    expect(first).toEqual({ $ref: "#/components/schemas/ApiError" });
    expect(second).toEqual({ $ref: "#/components/schemas/ApiError" });
    expect(registry.schemas.ApiError).toBeDefined();
    expect(registry.getDescription(first)).toBe("API error payload");
  });

  test("hoists Zod v4 .meta({ id }) schemas automatically", () => {
    const registry = new SchemaRegistry();
    const ItemSchema = z.object({ name: z.string() }).meta({ id: "InventoryItem" });

    const result = registry.convert(ItemSchema, "output");
    expect(result).toEqual({ $ref: "#/components/schemas/InventoryItem" });
    expect(registry.schemas.InventoryItem).toBeDefined();
    expect(registry.schemas.InventoryItem?.$id).toBeUndefined();
    expect(registry.schemas.InventoryItem?.id).toBeUndefined();
  });

  test("extracts $defs and rewrites local #/$defs/ references to #/components/schemas/", () => {
    const registry = new SchemaRegistry();
    const schemaWithDefs: StandardJSONSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "custom",
        jsonSchema: {
          input: () => ({
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              node: { $ref: "#/$defs/TreeNode" },
            },
            $defs: {
              TreeNode: {
                type: "object",
                properties: {
                  value: { type: "string" },
                  next: { $ref: "#/$defs/TreeNode" },
                },
              },
            },
          }),
          output: () => ({
            type: "object",
            properties: {
              node: { $ref: "#/$defs/TreeNode" },
            },
            $defs: {
              TreeNode: {
                type: "object",
                properties: {
                  value: { type: "string" },
                  next: { $ref: "#/$defs/TreeNode" },
                },
              },
            },
          }),
        },
      },
    };

    const result = registry.convert(schemaWithDefs, "output");
    expect(result.$defs).toBeUndefined();
    expect((result.properties as Record<string, unknown>).node).toEqual({
      $ref: "#/components/schemas/TreeNode",
    });
    expect(registry.schemas.TreeNode).toEqual({
      type: "object",
      properties: {
        value: { type: "string" },
        next: { $ref: "#/components/schemas/TreeNode" },
      },
    });
  });

  test("works with Valibot via StandardJSONSchemaV1", () => {
    const ValibotUser = withJsonSchema(
      v.object({
        id: v.string(),
        role: v.picklist(["admin", "member"]),
      }),
      {
        type: "object",
        properties: {
          id: { type: "string" },
          role: { type: "string", enum: ["admin", "member"] },
        },
        required: ["id", "role"],
      },
    );

    const app = new Hono().get(
      "/me",
      doc({
        summary: "Current user",
        responses: { 200: ValibotUser },
      }),
      (c) => c.json({ id: "1", role: "admin" }),
    );

    const spec = generateSpec(app, { info: { title: "Valibot API", version: "1.0.0" } });
    const schema = spec.paths["/me"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    expect(schema).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        role: { type: "string", enum: ["admin", "member"] },
      },
      required: ["id", "role"],
    });
  });

  test("expands object schemas into OpenAPI parameters", () => {
    const registry = new SchemaRegistry();
    const QuerySchema = z.object({
      q: z.string().describe("Search query"),
      page: z.coerce.number().optional(),
    });

    const params = expandParameters(QuerySchema, "query", registry);
    expect(params).toHaveLength(2);
    expect(params[0]).toMatchObject({
      name: "q",
      in: "query",
      required: true,
      description: "Search query",
      schema: { type: "string", description: "Search query" },
    });
    expect(params[1]).toMatchObject({
      name: "page",
      in: "query",
    });
    expect(params[1]?.required).toBeUndefined();
  });

  test("unpacks status-map schema (HealthResponse) with per-status descriptions", () => {
    const registry = new SchemaRegistry();
    const HealthResponse = z.object({
      200: z.object({ status: z.literal("ok") }).describe("Server is healthy"),
      500: z.object({ error: z.string() }).describe("Internal server error"),
    });

    const responses = unpackStatusMapSchema(HealthResponse, registry);
    expect(Object.keys(responses).sort()).toEqual(["200", "500"]);
    expect(responses["200"]?.description).toBe("Server is healthy");
    expect(responses["500"]?.description).toBe("Internal server error");
    expect(responses["200"]?.content?.["application/json"]?.schema).toMatchObject({
      type: "object",
      required: ["status"],
    });
  });

  test("hoists ref() schemas used inside composed z.object / z.array / status-map schemas", () => {
    const ErrorSchema = ref(
      "Error",
      z.object({ error: z.string(), message: z.optional(z.string()) }),
    );
    const PastrySchema = ref("Pastry", z.object({ id: z.string(), name: z.string() }));
    const HealthResponse = z.object({
      200: z.object({ ok: z.boolean() }).describe("Healthy"),
      500: ErrorSchema,
    });

    const app = new Hono()
      .get("/health", doc({ responses: HealthResponse }), (c) => c.json({ ok: true }))
      .get("/pastries", doc({ responses: { 200: z.array(PastrySchema) } }), (c) => c.json([]));

    const spec = generateSpec(app, {
      info: { title: "Composed Ref API", version: "1.0.0" },
      schemas: { Error: ErrorSchema },
    });

    // Both Error (inside HealthResponse) and Pastry (inside z.array) appear in components.schemas
    expect(spec.components?.schemas?.Error).toMatchObject({
      type: "object",
      required: ["error"],
    });
    expect(spec.components?.schemas?.Pastry).toMatchObject({
      type: "object",
      required: ["id", "name"],
    });
    expect(
      spec.paths["/health"]?.get?.responses["500"]?.content?.["application/json"]?.schema,
    ).toEqual({
      $ref: "#/components/schemas/Error",
    });
    expect(
      spec.paths["/pastries"]?.get?.responses["200"]?.content?.["application/json"]?.schema,
    ).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Pastry" },
    });
  });
});
