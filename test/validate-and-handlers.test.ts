import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { app as bakeryApp } from "../examples/full-api/index.ts";
import {
  binary,
  doc,
  docGroup,
  docsUI,
  generateSpec,
  html,
  openAPI,
  text,
  validate,
} from "../src/index.ts";

describe("validate() middleware, response & security shorthands, and handlers", () => {
  test("validates requests at runtime and documents params, query, and json body", async () => {
    const app = new Hono().post(
      "/users/:id",
      validate("param", z.object({ id: z.string().min(2) })),
      validate("query", z.object({ notify: z.enum(["true", "false"]).optional() })),
      validate("json", z.object({ name: z.string().min(2), email: z.email() })),
      doc({
        summary: "Update user",
        responses: {
          200: [z.object({ id: z.string(), name: z.string() }), "Updated user"],
          204: "No changes",
          400: null,
        },
      }),
      (c) => {
        const { id } = c.req.valid("param");
        const { name } = c.req.valid("json");
        return c.json({ id, name });
      },
    );

    // Valid request
    const okRes = await app.request("/users/u1?notify=true", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", email: "ada@example.com" }),
    });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ id: "u1", name: "Ada" });

    // Invalid JSON body -> 400 with issues
    const badRes = await app.request("/users/u1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "A", email: "not-an-email" }),
    });
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as { error: string; target: string; issues: unknown[] };
    expect(badBody.error).toBe("Validation failed");
    expect(badBody.target).toBe("json");
    expect(badBody.issues.length).toBeGreaterThan(0);

    // Generated OpenAPI spec
    const spec = generateSpec(app, { info: { title: "Users", version: "1.0.0" } });
    const op = spec.paths["/users/{id}"]?.post;
    expect(op?.parameters?.map((p) => `${p.in}:${p.name}`)).toEqual(["path:id", "query:notify"]);
    expect(op?.requestBody?.required).toBe(true);
    expect(op?.requestBody?.content["application/json"]?.schema).toMatchObject({
      type: "object",
      required: ["name", "email"],
    });
    expect(op?.responses["200"]?.description).toBe("Updated user");
    expect(op?.responses["204"]).toEqual({ description: "No changes" });
    expect(op?.responses["400"]).toEqual({ description: "Bad Request" });
  });

  test("supports content helpers (text, html, binary) and response removal (false)", () => {
    const app = new Hono()
      .use(docGroup({ tag: "files", responses: { 500: z.object({ error: z.string() }) } }))
      .get(
        "/export",
        doc({
          responses: {
            200: binary("image/png", "Generated chart"),
            202: text(z.string(), "Plaintext status"),
            206: html(z.string(), "HTML preview"),
            500: false, // opt out of inherited 500 response
          },
        }),
        (c) => c.text("ok"),
      );

    const spec = generateSpec(app, { info: { title: "Files", version: "1.0.0" } });
    const responses = spec.paths["/export"]?.get?.responses;
    expect(responses?.["200"]).toEqual({
      description: "Generated chart",
      content: {
        "image/png": {
          schema: { type: "string", contentEncoding: "binary" },
        },
      },
    });
    expect(responses?.["202"]?.content?.["text/plain"]).toBeDefined();
    expect(responses?.["206"]?.content?.["text/html"]).toBeDefined();
    expect(responses?.["500"]).toBeUndefined();
  });

  test("serves openAPI() and docsUI() while automatically hiding them from the spec", async () => {
    const app = new Hono().get(
      "/ping",
      doc({
        summary: "Ping",
        security: "public",
        responses: { 200: z.object({ pong: z.boolean() }) },
      }),
      (c) => c.json({ pong: true }),
    );
    app.get(
      "/openapi.json",
      openAPI(app, {
        info: { title: "Ping API", version: "1.0.0" },
        defaultSecurity: ["bearerAuth"],
      }),
    );
    app.get("/docs", docsUI("/openapi.json", { title: "Ping Docs" }));
    app.get("/swagger", docsUI("/openapi.json", { ui: "swagger", title: "Swagger Docs" }));

    const specRes = await app.request("/openapi.json");
    expect(specRes.status).toBe(200);
    const spec = (await specRes.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      security: unknown[];
    };
    expect(spec.openapi).toBe("3.2.0");
    expect(Object.keys(spec.paths)).toEqual(["/ping"]);
    expect(spec.security).toEqual([{ bearerAuth: [] }]);

    const scalarRes = await app.request("/docs");
    expect(scalarRes.status).toBe(200);
    const scalarHtml = await scalarRes.text();
    expect(scalarHtml).toContain("@scalar/api-reference");
    expect(scalarHtml).toContain('data-url="/openapi.json"');

    const swaggerRes = await app.request("/swagger");
    expect(swaggerRes.status).toBe(200);
    const swaggerHtml = await swaggerRes.text();
    expect(swaggerHtml).toContain("SwaggerUIBundle");
  });

  test("full-api example generates a valid OpenAPI 3.2 spec with nested tags and zero tags in index.ts", async () => {
    const res = await bakeryApp.request("/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      openapi: string;
      info: { title: string; version: string };
      tags: Array<{ name: string; parent?: string; kind?: string; summary?: string }>;
      paths: Record<string, Record<string, { tags?: string[]; security?: unknown[] }>>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };

    expect(spec.openapi).toBe("3.2.0");
    expect(spec.info.title).toBe("Bakery API");
    expect(spec.paths["/openapi.json"]).toBeUndefined();
    expect(spec.paths["/docs"]).toBeUndefined();

    // Check nested tags collected automatically across all routers
    const byName = new Map(spec.tags.map((t) => [t.name, t]));
    expect(byName.get("system")?.kind).toBe("nav");
    expect(byName.get("products")?.parent).toBeUndefined();
    expect(byName.get("cakes")?.parent).toBe("products");
    expect(byName.get("seasonal")?.parent).toBe("cakes");
    expect(byName.get("pastries")?.parent).toBe("products");
    expect(byName.get("orders")?.parent).toBeUndefined();
    expect(byName.get("wholesale")?.parent).toBe("orders");
    expect(byName.get("beta")?.kind).toBe("badge");

    // Verify operation tags & security
    expect(spec.paths["/system/health"]?.get?.security).toEqual([]);
    expect(spec.paths["/products/cakes"]?.post?.tags).toEqual(["cakes", "beta"]);
    expect(spec.paths["/products/cakes/seasonal"]?.get?.tags).toEqual(["seasonal"]);
    expect(spec.paths["/orders/wholesale"]?.post?.tags).toEqual(["wholesale"]);
    expect(spec.paths["/orders/wholesale"]?.post?.security).toEqual([
      { bearerAuth: ["orders:wholesale"] },
    ]);

    // Verify hoisted reusable component schemas
    expect(spec.components.schemas.Error).toBeDefined();
    expect(spec.components.schemas.Cake).toBeDefined();
    expect(spec.components.schemas.Order).toBeDefined();
  });
});
