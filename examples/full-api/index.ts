import { Hono } from "hono";
import { docsUI, openAPI } from "../../src/index.ts";
import { ordersRoutes } from "./routes/orders.ts";
import { productsRoutes } from "./routes/products.ts";
import { systemRoutes } from "./routes/system.ts";

// Notice: ZERO tag definitions needed in index.ts!
// Every tag and nested parent hierarchy is automatically collected from the routers.
export const app = new Hono()
  .route("/system", systemRoutes)
  .route("/products", productsRoutes)
  .route("/orders", ordersRoutes);

app.get(
  "/openapi.json",
  openAPI(app, {
    info: {
      title: "Bakery API",
      version: "2.0.0",
      description: "Full example showcasing OpenAPI 3.2, nested tags, docGroup, and validate.",
    },
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
    defaultSecurity: ["bearerAuth"],
  }),
);

app.get("/docs", docsUI("/openapi.json", { title: "Bakery API Docs" }));

export default app;
