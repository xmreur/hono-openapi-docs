import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Context, Env, MiddlewareHandler, ValidationTargets } from "hono";
import { validator } from "hono/validator";
import { META_SYMBOL } from "./constants.ts";
import type {
  DocGroupOptions,
  DocOptions,
  RouteMetadata,
  StandardSchemaWithJSON,
  ValidateTarget,
} from "./types.ts";

export function attachMeta<T extends object>(target: T, meta: RouteMetadata): T {
  Object.defineProperty(target, META_SYMBOL, {
    value: meta,
    enumerable: false,
    configurable: true,
  });
  return target;
}

export function getRouteMetadata(fn: unknown): RouteMetadata | undefined {
  if (typeof fn !== "function" && (typeof fn !== "object" || fn === null)) {
    return undefined;
  }
  return (fn as Record<symbol, RouteMetadata | undefined>)[META_SYMBOL];
}

/**
 * Document a Hono route with concise OpenAPI 3.2 metadata.
 * No-op at runtime; metadata is read statically by `generateSpec()` / `openAPI()`.
 */
export function doc(options: DocOptions): MiddlewareHandler {
  const mw: MiddlewareHandler = async (_c, next) => {
    await next();
  };
  return attachMeta(mw, { kind: "route", options });
}

/**
 * Apply shared OpenAPI documentation defaults (tags, nested parent tags, security,
 * common responses) to all routes mounted under this middleware's path scope.
 */
export function docGroup(options: DocGroupOptions): MiddlewareHandler {
  const mw: MiddlewareHandler = async (_c, next) => {
    await next();
  };
  return attachMeta(mw, { kind: "group", options });
}

export interface DocFactory {
  (options?: DocOptions): MiddlewareHandler;
  /** Convenience middleware form for `.use(groupDoc.middleware)` when path-scoping is desired. */
  readonly middleware: MiddlewareHandler;
}

/**
 * Create a pre-bound `doc(...)` helper with shared tag, security, and response defaults.
 * Ideal when multiple sub-routers mount at the same prefix (e.g. `/`).
 */
export function createDoc(defaults: DocGroupOptions): DocFactory {
  const factory = ((options: DocOptions = {}): MiddlewareHandler => {
    const mw: MiddlewareHandler = async (_c, next) => {
      await next();
    };
    return attachMeta(mw, {
      kind: "route",
      options,
      inheritedGroups: [defaults],
    });
  }) as DocFactory;

  Object.defineProperty(factory, "middleware", {
    get(): MiddlewareHandler {
      return docGroup(defaults);
    },
    enumerable: true,
  });

  return factory;
}

/**
 * Exclude a route from the generated OpenAPI specification.
 */
export function hideDoc(): MiddlewareHandler {
  const mw: MiddlewareHandler = async (_c, next) => {
    await next();
  };
  return attachMeta(mw, { kind: "hide" });
}

export type ValidationHookResult<Out, Target extends ValidateTarget> =
  | {
      readonly success: true;
      readonly data: Out;
      readonly target: Target;
    }
  | {
      readonly success: false;
      readonly issues: readonly StandardSchemaV1.Issue[];
      readonly target: Target;
    };

export type ValidationHook<
  Out,
  Target extends ValidateTarget,
  E extends Env = Env,
  P extends string = string,
> = (
  result: ValidationHookResult<Out, Target>,
  c: Context<E, P>,
) => Response | undefined | Promise<Response | undefined>;

type HasUndefined<T> = undefined extends T ? true : false;

type TargetInputMap<Target extends ValidateTarget, In> = Target extends "json" | "form"
  ? Record<Target, In>
  : Target extends keyof ValidationTargets
    ? Record<
        Target,
        HasUndefined<In> extends true
          ? Partial<Record<string, string | string[]>>
          : Record<string, string | string[]>
      >
    : Record<Target, In>;

/**
 * Validate a Hono request target (`json`, `query`, `param`, `header`, `cookie`, `form`)
 * using any Standard Schema library (Zod v4, Valibot, ArkType, etc.), providing full
 * `c.req.valid(target)` typing AND automatic OpenAPI request documentation.
 */
export function validate<
  Target extends ValidateTarget,
  Schema extends StandardSchemaWithJSON,
  E extends Env = Env,
  P extends string = string,
  In = StandardSchemaV1.InferInput<Schema>,
  Out = StandardSchemaV1.InferOutput<Schema>,
>(
  target: Target,
  schema: Schema,
  hook?: ValidationHook<Out, Target, E, P>,
): MiddlewareHandler<
  E,
  P,
  {
    in: TargetInputMap<Target, In>;
    out: Record<Target, Out>;
  }
> {
  const mw = validator(target, async (value, c) => {
    const result = await schema["~standard"].validate(value);

    if ("issues" in result && result.issues) {
      if (hook) {
        const hookRes = await hook(
          { success: false, issues: result.issues, target },
          c as unknown as Context<E, P>,
        );
        if (hookRes instanceof Response) {
          return hookRes;
        }
      }
      return c.json(
        {
          error: "Validation failed",
          target,
          issues: result.issues,
        },
        400,
      );
    }

    const data = result.value as Out;
    if (hook) {
      const hookRes = await hook({ success: true, data, target }, c as unknown as Context<E, P>);
      if (hookRes instanceof Response) {
        return hookRes;
      }
    }
    return data;
  }) as unknown as MiddlewareHandler<
    E,
    P,
    {
      in: TargetInputMap<Target, In>;
      out: Record<Target, Out>;
    }
  >;

  return attachMeta(mw, {
    kind: "validator",
    target,
    schema,
  });
}
