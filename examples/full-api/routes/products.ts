import { Hono } from "hono";
import { z } from "zod";
import { doc, docGroup, validate } from "../../../src/index.ts";
import { betaTag, CakeSchema, CreateCakeSchema, ErrorSchema, PastrySchema } from "../schemas.ts";

const cakesRoutes = new Hono()
  .use(
    docGroup({
      // Mounted under `productsRoutes`, so `parent: "products"` is inferred automatically!
      tag: {
        name: "cakes",
        summary: "Cakes",
        description: "Custom cakes and layer cakes",
        kind: "nav",
      },
    }),
  )
  .get(
    "/",
    validate(
      "query",
      z.object({
        flavor: z.string().optional().describe("Filter cakes by flavor"),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    ),
    doc({
      summary: "List cakes",
      responses: {
        200: z.array(CakeSchema),
      },
    }),
    (c) => {
      const { flavor, limit } = c.req.valid("query");
      return c.json(
        [
          {
            id: "cake_1",
            name: `${flavor ?? "Chocolate"} Layer Cake`,
            flavor: flavor ?? "chocolate",
            priceCents: 3200,
            seasonal: false,
          },
        ].slice(0, limit),
      );
    },
  )
  .get(
    "/seasonal",
    doc({
      summary: "List seasonal cakes",
      // Slash-separated nested tag: creates `seasonal` with `parent: "cakes"` (under `products`)
      tag: {
        name: "products/cakes/seasonal",
        summary: "Seasonal",
        description: "Limited-time seasonal cake offerings",
        kind: "nav",
      },
      responses: {
        200: z.array(CakeSchema),
      },
    }),
    (c) =>
      c.json([
        {
          id: "cake_pumpkin",
          name: "Spiced Pumpkin Cake",
          flavor: "pumpkin",
          priceCents: 3600,
          seasonal: true,
        },
      ]),
  )
  .post(
    "/",
    validate("json", CreateCakeSchema),
    doc({
      summary: "Create a cake",
      tags: [betaTag],
      responses: {
        201: [CakeSchema, "Cake created"],
        400: ErrorSchema,
      },
    }),
    (c) => {
      const body = c.req.valid("json");
      return c.json(
        {
          id: "cake_new",
          seasonal: false,
          ...body,
        },
        201,
      );
    },
  );

const pastriesRoutes = new Hono()
  .use(
    docGroup({
      tag: {
        name: "pastries",
        summary: "Pastries",
        description: "Croissants, danishes, and small baked goods",
        kind: "nav",
      },
    }),
  )
  .get(
    "/",
    doc({
      summary: "List pastries",
      responses: {
        200: z.array(PastrySchema),
      },
    }),
    (c) =>
      c.json([
        {
          id: "pastry_1",
          name: "Butter Croissant",
          flaky: true,
          priceCents: 450,
        },
      ]),
  );

export const productsRoutes = new Hono()
  .use(
    docGroup({
      tag: {
        name: "products",
        summary: "Products",
        description: "All bakery catalog operations",
        kind: "nav",
      },
      responses: {
        401: ErrorSchema,
        500: ErrorSchema,
      },
    }),
  )
  .route("/cakes", cakesRoutes)
  .route("/pastries", pastriesRoutes);
