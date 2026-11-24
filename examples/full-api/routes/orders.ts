import { Hono } from "hono";
import { z } from "zod";
import { createDoc, validate } from "../../../src/index.ts";
import { CreateWholesaleOrderSchema, ErrorSchema, OrderSchema } from "../schemas.ts";

const ordersDoc = createDoc({
  tag: {
    name: "orders",
    summary: "Orders",
    description: "Order management and tracking",
    kind: "nav",
  },
  responses: {
    401: ErrorSchema,
    404: ErrorSchema,
  },
});

export const ordersRoutes = new Hono()
  .get(
    "/:id",
    validate("param", z.object({ id: z.string().describe("Order ID") })),
    ordersDoc({
      summary: "Get order by ID",
      responses: {
        200: OrderSchema,
      },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      return c.json({ id, status: "pending" as const, itemCount: 3 });
    },
  )
  .post(
    "/wholesale",
    validate("json", CreateWholesaleOrderSchema),
    ordersDoc({
      summary: "Create wholesale order",
      // Slash-separated nested tag: `wholesale` gets `parent: "orders"` and replaces `orders` on this operation
      tag: {
        name: "orders/wholesale",
        summary: "Wholesale",
        description: "B2B bulk bakery orders",
        kind: "nav",
      },
      security: [{ bearerAuth: ["orders:wholesale"] }],
      responses: {
        201: [OrderSchema, "Wholesale order accepted"],
        400: ErrorSchema,
      },
    }),
    (c) => {
      const body = c.req.valid("json");
      return c.json(
        { id: "ord_wholesale_1", status: "pending" as const, itemCount: body.itemCount },
        201,
      );
    },
  )
  .delete(
    "/:id",
    ordersDoc({
      summary: "Cancel order",
      responses: {
        204: "Order cancelled",
      },
    }),
    (c) => c.body(null, 204),
  );
