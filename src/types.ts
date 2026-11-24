import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import type { ValidationTargets } from "hono";
import type { CONTENT_SPEC_SYMBOL } from "./constants.ts";

export type JSONSchemaObject = Record<string, unknown>;

export type OpenAPIVersion = "3.2.0" | "3.1.0";

export type TagKind = "nav" | "badge" | "audience" | (string & {});

export type StandardSchemaWithJSON<Input = unknown, Output = Input> = StandardSchemaV1<
  Input,
  Output
> &
  StandardJSONSchemaV1<Input, Output>;

export type SchemaInput = StandardJSONSchemaV1;

export interface OpenAPIExternalDocs {
  description?: string;
  url: string;
}

export interface OpenAPIContact {
  name?: string;
  url?: string;
  email?: string;
}

export interface OpenAPILicense {
  name: string;
  identifier?: string;
  url?: string;
}

export interface OpenAPIInfo {
  title: string;
  version: string;
  summary?: string;
  description?: string;
  termsOfService?: string;
  contact?: OpenAPIContact;
  license?: OpenAPILicense;
}

export interface OpenAPIServerVariable {
  enum?: string[];
  default: string;
  description?: string;
}

export interface OpenAPIServer {
  url: string;
  description?: string;
  name?: string;
  variables?: Record<string, OpenAPIServerVariable>;
}

export interface OpenAPITag {
  name: string;
  summary?: string;
  description?: string;
  externalDocs?: OpenAPIExternalDocs;
  parent?: string;
  kind?: TagKind;
  [extension: `x-${string}`]: unknown;
}

export interface TagDefinition {
  /** Tag name, or `/`-separated hierarchy path (e.g. `"products/cakes"` sets `name: "cakes"` with `parent: "products"`). */
  name: string;
  summary?: string;
  description?: string;
  externalDocs?: OpenAPIExternalDocs;
  /** Optional explicit parent override, or `null` to opt out of inherited group parent. */
  parent?: string | TagDefinition | null;
  kind?: TagKind;
  [extension: `x-${string}`]: unknown;
}

export type TagInput = string | TagDefinition;

export type SecurityRequirement = Record<string, string[]>;

export type SecurityShorthand =
  | "public"
  | false
  | string
  | readonly string[]
  | readonly SecurityRequirement[];

export interface OpenAPISecurityScheme {
  type: "apiKey" | "http" | "mutualTLS" | "oauth2" | "openIdConnect";
  description?: string;
  name?: string;
  in?: "query" | "header" | "cookie";
  scheme?: string;
  bearerFormat?: string;
  flows?: Record<string, unknown>;
  openIdConnectUrl?: string;
  oauth2MetadataUrl?: string;
  deprecated?: boolean;
}

export interface OpenAPIMediaType {
  schema?: JSONSchemaObject;
  example?: unknown;
  examples?: Record<string, unknown>;
  encoding?: Record<string, unknown>;
}

export interface OpenAPIHeader {
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: JSONSchemaObject;
  example?: unknown;
}

export interface OpenAPIResponseObject {
  description: string;
  summary?: string;
  headers?: Record<string, OpenAPIHeader>;
  content?: Record<string, OpenAPIMediaType>;
  links?: Record<string, unknown>;
}

export interface OpenAPIParameter {
  name: string;
  in: "query" | "header" | "path" | "cookie";
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  allowEmptyValue?: boolean;
  schema?: JSONSchemaObject;
  example?: unknown;
}

export interface OpenAPIRequestBody {
  description?: string;
  content: Record<string, OpenAPIMediaType>;
  required?: boolean;
}

export interface OpenAPIOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  externalDocs?: OpenAPIExternalDocs;
  operationId?: string;
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses: Record<string, OpenAPIResponseObject>;
  deprecated?: boolean;
  security?: SecurityRequirement[];
  servers?: OpenAPIServer[];
  [extension: `x-${string}`]: unknown;
}

export interface OpenAPIPathItem {
  summary?: string;
  description?: string;
  get?: OpenAPIOperation;
  put?: OpenAPIOperation;
  post?: OpenAPIOperation;
  delete?: OpenAPIOperation;
  options?: OpenAPIOperation;
  head?: OpenAPIOperation;
  patch?: OpenAPIOperation;
  trace?: OpenAPIOperation;
  query?: OpenAPIOperation;
  parameters?: OpenAPIParameter[];
}

export interface OpenAPIComponents {
  schemas?: Record<string, JSONSchemaObject>;
  securitySchemes?: Record<string, OpenAPISecurityScheme>;
  responses?: Record<string, OpenAPIResponseObject>;
  parameters?: Record<string, OpenAPIParameter>;
  headers?: Record<string, OpenAPIHeader>;
}

export interface OpenAPIDocument {
  openapi: OpenAPIVersion;
  $self?: string;
  info: OpenAPIInfo;
  jsonSchemaDialect?: string;
  servers?: OpenAPIServer[];
  paths: Record<string, OpenAPIPathItem>;
  components?: OpenAPIComponents;
  security?: SecurityRequirement[];
  tags?: OpenAPITag[];
  externalDocs?: OpenAPIExternalDocs;
}

export interface ContentSpec {
  readonly [CONTENT_SPEC_SYMBOL]: true;
  readonly contentType: string;
  readonly schema?: SchemaInput;
  readonly description?: string;
  readonly required?: boolean;
  readonly example?: unknown;
  readonly examples?: Record<string, unknown>;
  readonly headers?: Record<string, OpenAPIHeader>;
}

export type ResponseShorthand =
  | SchemaInput
  | readonly [SchemaInput, string]
  | string
  | null
  | ContentSpec
  | OpenAPIResponseObject;

export type StatusKey = number | `${number}` | "default";

export type ResponseMap = Partial<Record<StatusKey, ResponseShorthand | false>>;

export type ResponsesInput = ResponseMap | StandardJSONSchemaV1;

export interface DocRequestOptions {
  params?: SchemaInput;
  query?: SchemaInput;
  headers?: SchemaInput;
  cookies?: SchemaInput;
  json?: SchemaInput;
  form?: SchemaInput;
  body?: SchemaInput | ContentSpec | OpenAPIRequestBody;
}

export interface DocGroupOptions {
  tag?: TagInput;
  tags?: TagInput[];
  security?: SecurityShorthand;
  responses?: ResponseMap;
  deprecated?: boolean;
  hide?: boolean;
}

export interface DocOptions {
  summary?: string;
  description?: string;
  operationId?: string;
  tag?: TagInput;
  tags?: TagInput[];
  security?: SecurityShorthand;
  deprecated?: boolean;
  externalDocs?: OpenAPIExternalDocs;
  request?: DocRequestOptions;
  responses?: ResponsesInput;
  hide?: boolean;
  extensions?: Record<`x-${string}`, unknown>;
}

export type ValidateTarget = keyof ValidationTargets;

export type RouteMetadata =
  | {
      readonly kind: "route";
      readonly options: DocOptions;
      readonly inheritedGroups?: readonly DocGroupOptions[];
    }
  | {
      readonly kind: "group";
      readonly options: DocGroupOptions;
    }
  | {
      readonly kind: "validator";
      readonly target: ValidateTarget;
      readonly schema: StandardJSONSchemaV1;
    }
  | {
      readonly kind: "hide";
    };

export interface OpenAPIConfig {
  /** OpenAPI version to emit. Defaults to `"3.2.0"`. */
  openapi?: OpenAPIVersion;
  /** OpenAPI 3.2 `$self` URI identifying this document. */
  $self?: string;
  info: OpenAPIInfo;
  servers?: OpenAPIServer[];
  externalDocs?: OpenAPIExternalDocs;
  /** Security schemes to register under `components.securitySchemes`. */
  securitySchemes?: Record<string, OpenAPISecurityScheme>;
  /** Default document-level security (can be overridden per group/route via `security: "public"` or custom requirements). */
  defaultSecurity?: SecurityShorthand;
  /** Optional extra or pre-ordered tags. Tags from routes and groups are always auto-collected. */
  tags?: TagInput[];
  /** Include routes that have no `doc()`, `validate()`, or `docGroup()` attached. Defaults to `false`. */
  includeUndocumented?: boolean;
  /** Additional static schemas to include in `components.schemas`. */
  schemas?: Record<string, SchemaInput>;
  /** Cache the generated spec after the first request in `openAPI()`. Defaults to `true`. */
  cache?: boolean;
}

export interface DocsUIOptions {
  /** Documentation UI renderer. Defaults to `"scalar"`. */
  ui?: "scalar" | "swagger";
  /** Page `<title>`. Defaults to `"API Documentation"`. */
  title?: string;
  /** Optional custom CDN script URL. */
  cdnUrl?: string;
  /** Additional Scalar configuration object serialized into `data-configuration`. */
  scalarConfig?: Record<string, unknown>;
}
