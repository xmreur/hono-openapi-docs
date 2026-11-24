import type { Handler, Hono } from "hono";
import { generateSpec } from "./generator.ts";
import { attachMeta } from "./middleware.ts";
import type { DocsUIOptions, OpenAPIConfig, OpenAPIDocument } from "./types.ts";

const DEFAULT_SCALAR_CDN = "https://cdn.jsdelivr.net/npm/@scalar/api-reference";
const DEFAULT_SWAGGER_CSS = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css";
const DEFAULT_SWAGGER_JS = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js";

/**
 * Hono route handler that serves the generated OpenAPI specification as JSON.
 * Automatically excluded from the generated spec.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function openAPI(app: Hono<any, any, any>, config: OpenAPIConfig): Handler {
  const shouldCache = config.cache !== false;
  let cached: OpenAPIDocument | undefined;

  const handler: Handler = (c) => {
    if (!shouldCache || !cached) {
      cached = generateSpec(app, config);
    }
    return c.json(cached);
  };

  return attachMeta(handler, { kind: "hide" });
}

/**
 * Hono route handler that serves an interactive API documentation UI (Scalar or Swagger UI).
 * Automatically excluded from the generated spec.
 */
export function docsUI(specUrl: string, options: DocsUIOptions = {}): Handler {
  const ui = options.ui ?? "scalar";
  const title = escapeHtml(options.title ?? "API Documentation");
  const safeUrl = escapeHtml(specUrl);

  let html: string;
  switch (ui) {
    case "scalar": {
      const cdn = escapeHtml(options.cdnUrl ?? DEFAULT_SCALAR_CDN);
      const configAttr = options.scalarConfig
        ? ` data-configuration="${escapeHtml(JSON.stringify(options.scalarConfig))}"`
        : "";
      html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
</head>
<body>
  <script id="api-reference" data-url="${safeUrl}"${configAttr}></script>
  <script src="${cdn}"></script>
</body>
</html>`;
      break;
    }
    case "swagger": {
      const jsUrl = escapeHtml(options.cdnUrl ?? DEFAULT_SWAGGER_JS);
      const cssUrl = escapeHtml(DEFAULT_SWAGGER_CSS);
      const specUrlJson = JSON.stringify(specUrl);
      html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="stylesheet" href="${cssUrl}" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${jsUrl}"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: ${specUrlJson},
      dom_id: "#swagger-ui",
    });
  </script>
</body>
</html>`;
      break;
    }
    default: {
      const _exhaustive: never = ui;
      throw new Error(`Unsupported docs UI: ${String(_exhaustive)}`);
    }
  }

  const handler: Handler = (c) => c.html(html);
  return attachMeta(handler, { kind: "hide" });
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
