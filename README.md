# hono-openapi-docs

Ergonomic, zero-boilerplate **OpenAPI 3.2** documentation for [Hono](https://hono.dev) powered by **Standard Schema / Standard JSON Schema** (Zod v4, Valibot, ArkType, etc.).

- **Zero boilerplate responses** — pass a schema directly (`200: UserSchema`), a `[schema, description]` tuple, a status-keyed schema (`responses: HealthResponse`), or content helpers (`text`, `html`, `binary`, `json`).
- **Zero tag duplication in `index.ts`** — define tags on your sub-routers (`docGroup` / `createDoc`) or routes; all tags are collected, merged, deduplicated, and ordered automatically.
- **First-class OpenAPI 3.2 nested tags** — split hierarchies with `/` (`"products/cakes/seasonal"`), or nest Hono sub-routers with `docGroup` to infer `parent` relationships automatically.
- **Standard Schema native** — works with any library implementing `StandardJSONSchemaV1` (`~standard.jsonSchema`), with built-in `validate()` middleware that types `c.req.valid(...)` and documents requests at the same time.
- **Drop-in Hono** — works on standard `new Hono()`, `app.route()`, `app.basePath()`, and Hono RPC (`hc`).

## Installation

```bash
bun add hono-openapi-docs hono
```

Peer dependencies: `hono >= 4.0.0`, `@standard-schema/spec ^1.0.0`.

## Quick Start

```ts
import { Hono } from "hono";
import { z } from "zod";
import { doc, docGroup, docsUI, openAPI } from "hono-openapi-docs";

const HealthResponse = z.object({
  200: z.object({ status: z.literal("ok") }).describe("Server is healthy"),
  500: z.object({ error: z.string() }).describe("Internal server error"),
});

// routes/system.ts — tags and security live with the router
const system = new Hono()
  .use(
    docGroup({
      tag: { name: "system", summary: "System", description: "Health & diagnostics", kind: "nav" },
      security: "public",
    }),
  )
  .get(
    "/health",
    doc({
      summary: "Liveness check",
      description: "Check if server is healthy",
      responses: HealthResponse,
    }),
    (c) => c.json({ status: "ok" as const }),
  );

// index.ts — zero tags needed here!
const app = new Hono().route("/system", system);

app.get(
  "/openapi.json",
  openAPI(app, {
    info: { title: "My API", version: "1.0.0" },
  }),
);
app.get("/docs", docsUI("/openapi.json"));

export default app;
```

## OpenAPI 3.2 Nested Tags

### Slash-Separated Tag Hierarchies

Split tags with `/`. Every preceding segment becomes the `parent` of the next segment, and the operation receives the leaf tag:

```ts
// String shorthand:
// Emits tags:
//   { name: "products" }
//   { name: "cakes", parent: "products" }
//   { name: "seasonal", parent: "cakes" }
// Operation gets: tags: ["seasonal"]
doc({
  summary: "List seasonal cakes",
  tag: "products/cakes/seasonal",
  responses: { 200: z.array(CakeSchema) },
});

// With rich metadata on the leaf tag:
doc({
  summary: "List seasonal cakes",
  tag: {
    name: "products/cakes/seasonal",
    summary: "Seasonal",
    description: "Limited-time seasonal cake offerings",
    kind: "nav",
  },
  responses: { 200: z.array(CakeSchema) },
});
```

### Automatic Nesting Across Sub-Routers (`docGroup`)

When you mount a child Hono router with `docGroup` inside a parent router with `docGroup`, the child's navigation tag automatically inherits `parent` from the parent group:

```ts
const cakesRoutes = new Hono()
  .use(docGroup({ tag: { name: "cakes", summary: "Cakes", kind: "nav" } }))
  .get("/", doc({ summary: "List cakes", responses: { 200: z.array(CakeSchema) } }), handler);

const productsRoutes = new Hono()
  .use(
    docGroup({
      tag: { name: "products", summary: "Products", kind: "nav" },
      responses: { 401: ErrorSchema, 500: ErrorSchema },
    }),
  )
  .route("/cakes", cakesRoutes);
```

This emits `products` before `cakes` (with `parent: "products"`), gives `GET /products/cakes` `tags: ["cakes"]`, and inherits the shared `401` and `500` responses automatically.

### Cross-Cutting Tags (`kind: "badge"` / `"audience"`)

Non-nav tags (like `kind: "badge"` or `kind: "audience"`) are additive and do not replace the operation's navigation tag:

```ts
const betaTag = defineTag({
  name: "beta",
  summary: "Beta",
  description: "Experimental endpoints",
  kind: "badge",
});

doc({
  summary: "Create a cake",
  tags: [betaTag], // operation gets ["cakes", "beta"]
  responses: { 201: CakeSchema },
});
```

To opt a tag out of an inherited group parent, pass `parent: null`. Circular parent hierarchies are detected and throw a clear error during spec generation.

## Router Groups: `docGroup` vs `createDoc`

- **`docGroup(defaults)`** — Hono middleware (`.use(docGroup(...))`) that applies shared tags, security, and responses to all routes mounted under that router's path scope (e.g. `app.route("/products", productsRoutes)`).
- **`createDoc(defaults)`** — Returns a pre-bound `doc(...)` function with defaults baked in. Use this when mounting multiple sibling sub-routers at the same prefix (`app.route("/", users).route("/", posts)`) so middleware scopes don't overlap.

```ts
const ordersDoc = createDoc({
  tag: { name: "orders", summary: "Orders", kind: "nav" },
  responses: { 401: ErrorSchema, 404: ErrorSchema },
});

export const ordersRoutes = new Hono()
  .get("/:id", ordersDoc({ summary: "Get order", responses: { 200: OrderSchema } }), handler)
  .post(
    "/wholesale",
    ordersDoc({
      summary: "Create wholesale order",
      tag: { name: "orders/wholesale", summary: "Wholesale", kind: "nav" },
      responses: { 201: OrderSchema },
    }),
    handler,
  );
```

## Response Shorthands

Every status entry in `responses` accepts any of these forms:

```ts
responses: {
  // 1. Direct schema -> application/json, description from .describe() or HTTP status phrase
  200: UserSchema,

  // 2. Tuple [schema, description]
  201: [UserSchema, "User created"],

  // 3. Description-only empty response
  204: "User deleted",

  // 4. Empty response with default HTTP status phrase ("Bad Request")
  400: null,

  // 5. Content helpers for non-JSON or customized media types
  202: text(z.string(), "Plaintext status"),
  206: html(z.string(), "HTML preview"),
  200: binary("image/png", "Generated chart"),
  200: json(UserSchema, { description: "User", example: { id: "1" } }),
  200: content("application/xml", z.string(), "XML feed"),

  // 6. Opt out of a response inherited from a parent docGroup
  500: false,
}
```

Or pass a **status-keyed schema** directly (`responses: HealthResponse`) to unpack every HTTP status key (`200`, `404`, `500`, `default`) and its `.describe()` description automatically.

## Request Validation & Documentation (`validate`)

`validate(target, schema, hook?)` wraps Hono's `validator()` using Standard Schema (`~standard.validate`). It validates requests at runtime, provides full `c.req.valid(target)` TypeScript inference, and automatically documents `param`, `query`, `header`, `cookie`, `json`, and `form` schemas in OpenAPI:

```ts
app.post(
  "/users/:id",
  validate("param", z.object({ id: z.string().min(2) })),
  validate("query", z.object({ notify: z.enum(["true", "false"]).optional() })),
  validate("json", z.object({ name: z.string(), email: z.email() })),
  doc({
    summary: "Update user",
    responses: { 200: UserSchema },
  }),
  (c) => {
    const { id } = c.req.valid("param");
    const { name } = c.req.valid("json");
    return c.json({ id, name });
  },
);
```

If you use your own validator, you can document requests purely via `doc({ request: { params, query, headers, cookies, json, form, body } })`.

## Security Shorthands

Define security schemes once in `openAPI(app, ...)` and override per group or route using shorthands:

```ts
openAPI(app, {
  info: { title: "API", version: "1.0.0" },
  securitySchemes: {
    bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
  },
  defaultSecurity: ["bearerAuth"], // [{ bearerAuth: [] }]
});
```

On any `docGroup` or `doc`:
- `security: "public"` or `security: false` or `security: []` -> `[]` (explicitly public)
- `security: "bearerAuth"` -> `[{ bearerAuth: [] }]`
- `security: ["bearerAuth"]` -> `[{ bearerAuth: [] }]`
- `security: [{ bearerAuth: ["orders:write"] }]` -> raw OpenAPI `SecurityRequirement[]`

## Reusable Component Schemas (`ref`)

Wrap any schema with `ref("Name", schema)` (or use Zod v4 `.meta({ id: "Name" })`) to hoist it into `components.schemas` and reference it via `$ref`. `ref()` returns the original schema transparently so it can still be composed with `z.array(CakeSchema)` or passed to `validate()`:

```ts
export const ErrorSchema = ref(
  "Error",
  z.object({ code: z.string(), message: z.string() }).describe("Standard API error"),
);
```

Local `$defs` / `definitions` emitted by Standard JSON Schema converters are also automatically hoisted into `components.schemas`.

## Serving OpenAPI & Docs UI

```ts
// Serves the generated JSON spec (cached by default; set cache: false to regenerate per request)
app.get("/openapi.json", openAPI(app, { info: { title: "API", version: "1.0.0" } }));

// Serves Scalar (default) or Swagger UI
app.get("/docs", docsUI("/openapi.json", { title: "API Docs" }));
app.get("/swagger", docsUI("/openapi.json", { ui: "swagger", title: "Swagger UI" }));
```

Both `openAPI()` and `docsUI()` automatically hide themselves from the generated spec. To generate the spec programmatically (e.g. in tests or CI scripts), use `generateSpec(app, config)`.

To emit **OpenAPI 3.1.0** instead of **3.2.0**, pass `openapi: "3.1.0"` — 3.2-only tag fields (`summary`, `parent`, `kind`) are stripped automatically.

## Full API Example

See [`examples/full-api/`](examples/full-api/) for a complete multi-file Bun + Hono application demonstrating `docGroup`, nested routers, slash-separated tags, `createDoc`, `validate`, `ref`, status-map `responses`, `openAPI`, and `docsUI`:

```bash
bun run example
# Open http://localhost:3000/docs or http://localhost:3000/openapi.json
```

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```
