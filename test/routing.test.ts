import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { createDoc, defineTag, doc, docGroup, generateSpec, hideDoc, ref } from "../src/index.ts";
import { convertHonoPath, matchesMiddlewareScope } from "../src/path.ts";

describe("Hono path conversion & middleware scope matching", () => {
  test("converts Hono path params, regex constraints, and optional params", () => {
    expect(convertHonoPath("/users/:id")).toEqual({
      openAPIPath: "/users/{id}",
      implicitParams: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    });

    expect(convertHonoPath("/orders/:orderId{[0-9]+}/items/:slug?")).toEqual({
      openAPIPath: "/orders/{orderId}/items/{slug}",
      implicitParams: [
        {
          name: "orderId",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "[0-9]+" },
        },
        {
          name: "slug",
          in: "path",
          required: false,
          schema: { type: "string" },
        },
      ],
    });
  });

  test("matches middleware scopes without bleeding across sibling prefixes", () => {
    expect(matchesMiddlewareScope("/*", "/anything")).toBe(true);
    expect(matchesMiddlewareScope("/system/*", "/system")).toBe(true);
    expect(matchesMiddlewareScope("/system/*", "/system/health")).toBe(true);
    expect(matchesMiddlewareScope("/system/*", "/system-other")).toBe(false);
    expect(matchesMiddlewareScope("/api/:version/*", "/api/v1/users")).toBe(true);
  });
});

describe("OpenAPI 3.2 nested tags, slash-separated tags, and router groups", () => {
  test("splits slash-separated tag strings into parent -> child hierarchy", () => {
    const app = new Hono().get(
      "/seasonal",
      doc({
        summary: "Seasonal cakes",
        tag: "products/cakes/seasonal",
        responses: { 200: z.array(z.string()) },
      }),
      (c) => c.json([]),
    );

    const spec = generateSpec(app, { info: { title: "Bakery", version: "1.0.0" } });
    expect(spec.openapi).toBe("3.2.0");
    expect(spec.paths["/seasonal"]?.get?.tags).toEqual(["seasonal"]);
    expect(spec.tags).toEqual([
      { name: "products" },
      { name: "cakes", parent: "products" },
      { name: "seasonal", parent: "cakes" },
    ]);
  });

  test("splits slash-separated TagDefinition objects and attaches metadata to the leaf tag", () => {
    const app = new Hono()
      .use(
        docGroup({
          tag: {
            name: "products",
            summary: "Products",
            description: "All products",
            kind: "nav",
          },
        }),
      )
      .get(
        "/cakes",
        doc({
          summary: "List cakes",
          tag: {
            name: "products/cakes",
            summary: "Cakes",
            description: "Custom cakes",
            kind: "nav",
          },
          responses: { 200: z.array(z.string()) },
        }),
        (c) => c.json([]),
      );

    const spec = generateSpec(app, { info: { title: "Bakery", version: "1.0.0" } });
    // Operation gets leaf tag "cakes" (replacing parent "products")
    expect(spec.paths["/cakes"]?.get?.tags).toEqual(["cakes"]);
    // Top-level tags preserve both parent metadata and child metadata, parent-first
    expect(spec.tags).toEqual([
      { name: "products", summary: "Products", description: "All products", kind: "nav" },
      {
        name: "cakes",
        summary: "Cakes",
        description: "Custom cakes",
        parent: "products",
        kind: "nav",
      },
    ]);
  });

  test("automatically infers parent tags across nested docGroup sub-routers", () => {
    const ErrorSchema = ref("Error", z.object({ message: z.string() }));
    const betaTag = defineTag({ name: "beta", summary: "Beta", kind: "badge" });

    const cakes = new Hono()
      .use(
        docGroup({
          tag: { name: "cakes", summary: "Cakes", kind: "nav" },
        }),
      )
      .get(
        "/",
        doc({
          summary: "List cakes",
          tags: [betaTag],
          responses: { 200: z.array(z.string()) },
        }),
        (c) => c.json([]),
      );

    const products = new Hono()
      .use(
        docGroup({
          tag: { name: "products", summary: "Products", kind: "nav" },
          responses: { 500: ErrorSchema },
        }),
      )
      .route("/cakes", cakes);

    const app = new Hono().route("/products", products);
    const spec = generateSpec(app, { info: { title: "Bakery", version: "1.0.0" } });

    const op = spec.paths["/products/cakes"]?.get;
    // Leaf nav tag + additive badge tag
    expect(op?.tags).toEqual(["cakes", "beta"]);
    // Inherited 500 error from outer group
    expect(op?.responses["500"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/Error",
    });
    // Tags ordered parent-before-child
    expect(spec.tags).toEqual([
      { name: "products", summary: "Products", kind: "nav" },
      { name: "cakes", summary: "Cakes", parent: "products", kind: "nav" },
      { name: "beta", summary: "Beta", kind: "badge" },
    ]);
  });

  test("isolates sibling sub-routers mounted at '/' using createDoc", () => {
    const usersDoc = createDoc({
      tag: { name: "users", summary: "Users", kind: "nav" },
      security: "public",
    });
    const postsDoc = createDoc({
      tag: { name: "posts", summary: "Posts", kind: "nav" },
    });

    const users = new Hono().get("/users", usersDoc({ summary: "List users" }), (c) => c.json([]));
    const posts = new Hono().get("/posts", postsDoc({ summary: "List posts" }), (c) => c.json([]));

    const app = new Hono().route("/", users).route("/", posts);
    const spec = generateSpec(app, { info: { title: "Blog", version: "1.0.0" } });

    expect(spec.paths["/users"]?.get?.tags).toEqual(["users"]);
    expect(spec.paths["/users"]?.get?.security).toEqual([]);
    expect(spec.paths["/posts"]?.get?.tags).toEqual(["posts"]);
    expect(spec.paths["/posts"]?.get?.security).toBeUndefined();
  });

  test("supports basePath, hideDoc, and parent: null opt-out", () => {
    const app = new Hono()
      .basePath("/api/v1")
      .use(docGroup({ tag: "core" }))
      .get(
        "/standalone",
        doc({
          tag: { name: "standalone", parent: null },
          summary: "Standalone",
        }),
        (c) => c.text("ok"),
      )
      .get("/internal", hideDoc(), doc({ summary: "Secret" }), (c) => c.text("hidden"));

    const spec = generateSpec(app, { info: { title: "API", version: "1.0.0" } });
    expect(spec.paths["/api/v1/standalone"]).toBeDefined();
    expect(spec.paths["/api/v1/internal"]).toBeUndefined();
    const standaloneTag = spec.tags?.find((t) => t.name === "standalone");
    expect(standaloneTag?.parent).toBeUndefined();
  });

  test("detects circular tag parent hierarchies", () => {
    const app = new Hono()
      .get("/a", doc({ tag: { name: "a", parent: "b" } }), (c) => c.text("a"))
      .get("/b", doc({ tag: { name: "b", parent: "a" } }), (c) => c.text("b"));

    expect(() => generateSpec(app, { info: { title: "Cycle", version: "1.0.0" } })).toThrow(
      /Circular tag parent hierarchy/,
    );
  });

  test("downgrades 3.2-only tag fields cleanly when openapi: '3.1.0'", () => {
    const app = new Hono().get(
      "/cakes",
      doc({
        tag: {
          name: "products/cakes",
          summary: "Cakes",
          description: "Custom cakes",
          kind: "nav",
        },
      }),
      (c) => c.json([]),
    );

    const spec = generateSpec(app, {
      openapi: "3.1.0",
      info: { title: "Bakery", version: "1.0.0" },
    });

    expect(spec.openapi).toBe("3.1.0");
    expect(spec.tags).toEqual([
      { name: "products" },
      { name: "cakes", description: "Custom cakes" },
    ]);
  });
});
