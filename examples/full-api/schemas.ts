import { z } from "zod";
import { defineTag, ref } from "../../src/index.ts";

export const ErrorSchema = ref(
  "Error",
  z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .describe("Standard API error"),
);

export const HealthResponse = z.object({
  200: z
    .object({
      status: z.literal("ok"),
      uptime: z.number(),
    })
    .describe("Server is healthy"),
  500: z
    .object({
      status: z.literal("unhealthy"),
      reason: z.string(),
    })
    .describe("Internal server error"),
});

export const CakeSchema = ref(
  "Cake",
  z.object({
    id: z.string(),
    name: z.string(),
    flavor: z.string(),
    priceCents: z.number().int().positive(),
    seasonal: z.boolean().default(false),
  }),
);

export const CreateCakeSchema = z.object({
  name: z.string().min(2),
  flavor: z.string().min(2),
  priceCents: z.number().int().positive(),
  seasonal: z.boolean().optional(),
});

export const PastrySchema = ref(
  "Pastry",
  z.object({
    id: z.string(),
    name: z.string(),
    flaky: z.boolean(),
    priceCents: z.number().int().positive(),
  }),
);

export const OrderSchema = ref(
  "Order",
  z.object({
    id: z.string(),
    status: z.enum(["pending", "baking", "ready", "cancelled"]),
    itemCount: z.number().int().positive(),
  }),
);

export const CreateWholesaleOrderSchema = z.object({
  companyName: z.string().min(2),
  itemCount: z.number().int().min(10),
  deliveryDate: z.string(),
});

/** Cross-cutting badge tag usable on any route alongside its navigation tag. */
export const betaTag = defineTag({
  name: "beta",
  summary: "Beta",
  description: "Experimental endpoints subject to change",
  kind: "badge",
});
