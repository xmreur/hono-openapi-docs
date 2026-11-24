import { Hono } from "hono";
import { z } from "zod";
import { doc, docGroup, text } from "../../../src/index.ts";
import { HealthResponse } from "../schemas.ts";

export const systemRoutes = new Hono()
  .use(
    docGroup({
      tag: {
        name: "system",
        summary: "System",
        description: "Health checks and operational diagnostics",
        kind: "nav",
      },
      security: "public",
    }),
  )
  .get(
    "/health",
    doc({
      summary: "Liveness check",
      description: "Check if server is healthy",
      // Automatically unpacks 200 & 500 responses and their .describe() messages
      responses: HealthResponse,
    }),
    (c) => c.json({ status: "ok" as const, uptime: process.uptime() }),
  )
  .get(
    "/metrics",
    doc({
      summary: "Prometheus metrics",
      responses: {
        200: text(z.string(), "Prometheus exposition format"),
      },
    }),
    (c) => c.text("bakery_up 1\n"),
  );
