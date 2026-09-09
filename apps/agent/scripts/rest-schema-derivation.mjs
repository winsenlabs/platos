// DERIVING THE V1 REST REQUEST AND RESPONSE SCHEMAS FROM THE TYPES THEMSELVES.
//
// WIN-267 W2. Until this module landed, `generate-control-plane.mjs` emitted a
// document with method and path and a single bodyless `200`, and said so in its
// own `info.description`: "It intentionally does not invent request or response
// schemas." That was an honest refusal to hand-write a table, and it left ADR
// M0.4 D7 — "the new contexts should be born with schemas so the breaking-change
// guard actually guards fields" — with nothing to guard. A consumer generating a
// client from that document got URLs and no types.
//
// -----------------------------------------------------------------------------
// THE JOIN IS THE TYPESCRIPT TYPE CHECKER, WHICH THIS FILE DOES NOT CONTROL
//
// The schemas are read off the RESOLVED TYPE of each handler: the awaited return
// type for the response, the `@Body()` parameter's type for the request, the
// `@Param()` parameter's type for a path variable. Not a table beside the
// controllers, not a decorator this repository invented, not a list a human
// keeps in step — `ts.TypeChecker`, asked what the method actually returns.
//
// That distinction is the whole point. A parallel list is exactly the trap this
// project has hit: a gate that wrote `count: 18` and asserted against its own
// constant could not be fired by any repository change. Delete `readonly email`
// from `OperatorSessionResource` and the checker stops reporting the property,
// the emitted schema loses it, and `scripts/openapi-compat.mjs` classifies the
// loss as BREAKING. `scripts/openapi-schema-derivation.test.mjs` performs that
// exact deletion against the real file, in memory, and asserts the property
// disappears — so the join is proven by execution rather than asserted in prose.
//
// -----------------------------------------------------------------------------
// IT FAILS RATHER THAN EMITS `{}`
//
// Every unconvertible type raises. A permissive `{}` would make the document
// LOOK complete while guaranteeing nothing, and a schema that admits everything
// cannot be narrowed later without breaking clients that trusted it. `any`,
// `unknown`, an unresolved type parameter, an index signature, a `Date` that
// escaped `instant()`, a function property — each one stops generation and names
// the property path it stopped on. The routes whose shape genuinely cannot be
// derived are listed as data in `UNDERIVABLE_QUERY_HANDLERS` with the reason,
// and reach the document as an explicit `not-derived` marker rather than as a
// silent absence.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/** The Nest route decorators this derivation understands. */
const HTTP_VERB_DECORATORS = new Set(["Get", "Post", "Put", "Patch", "Delete", "Head", "Options"]);

/**
 * Nest's own default success status, per verb, as `@nestjs/common` documents it:
 * everything answers 200 except POST, which answers 201 unless a handler says
 * otherwise with `@HttpCode`.
 */
const DEFAULT_STATUS_BY_VERB = { post: 201 };

/**
 * `HttpStatus` members, for the case where `@nestjs/common` is not resolvable in
 * the derivation program (a checkout with no install, which is how the generator
 * runs in some sweeps).
 *
 * THIS IS A FALLBACK, NOT THE SOURCE. When the program resolves the enum the
 * CONSTANT is used and this map is never read; the map exists so the emitted
 * document is byte-identical either way. `scripts/openapi-schema-derivation.test.mjs`
 * joins every entry to the real `HttpStatus` enum from `@nestjs/common`, so an
 * entry that disagrees with Nest fails a named case rather than silently
 * mis-stating a status.
 */
const HTTP_STATUS_FALLBACK = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
};

/**
 * Handlers whose QUERY STRING cannot be derived, and why.
 *
 * DECLARED RATHER THAN GUESSED. `EnvironmentEndUsersController.list` types its
 * `@Query` parameter as `EndUserQuery`, which is the POST-PARSE shape — it
 * carries `offset`, a number the caller never sends, and it does NOT carry
 * `cursor`, the parameter the caller actually sends and which
 * `offsetInCursor` decodes into that offset. Emitting `EndUserQuery` as the query
 * schema would publish a parameter that does not exist and omit two that do.
 *
 * The remedy is a declared wire-query DTO that the validator itself consumes, so
 * that one declaration decides both what is parsed and what is published. That is
 * a change to `apps/core-api/src/transports/rest`, it is not this tranche's, and
 * naming it here is the difference between a known gap and a silent one.
 */
export const UNDERIVABLE_QUERY_HANDLERS = {
  "EnvironmentEndUsersController.list": {
    reason: "post-parse-dto",
    detail:
      "The @Query parameter is typed EndUserQuery, the shape AFTER endUserQueryValidator has " +
      "decoded ?cursor= into an offset. It declares `offset`, which no caller sends, and omits " +
      "`cursor` and `limit`, which every caller does. Publishing it would describe a query string " +
      "this route does not accept. Deriving the real one needs a declared wire-query DTO that the " +
      "validator consumes; until then this route's query parameters are undocumented, not guessed.",
  },
};

class DerivationError extends Error {}

function fail(message) {
  throw new DerivationError(message);
}

/**
 * Build the program over `apps/core-api`.
 *
 * `overrides` replaces a file's text without touching the disk, which is how the
 * mutation cases prove the derivation is joined to the source: they hand back
 * `resources.ts` with one property deleted and re-derive.
 */
function createProgram(repoDir, overrides) {
  const projectDir = join(repoDir, "apps", "core-api");
  const configPath = join(projectDir, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) fail(`cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, projectDir);
  const options = {
    ...parsed.options,
    noEmit: true,
    composite: false,
    declaration: false,
    declarationMap: false,
    incremental: false,
    tsBuildInfoFile: undefined,
  };
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  const overriddenText = (fileName) => overrides.get(resolve(fileName));
  host.readFile = (fileName) => overriddenText(fileName) ?? readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = overriddenText(fileName);
    if (text === undefined) return getSourceFile(fileName, languageVersion, onError, shouldCreate);
    return ts.createSourceFile(fileName, text, languageVersion, true);
  };
  return ts.createProgram({ rootNames: parsed.fileNames, options, host });
}

function decoratorCalls(node) {
  return (ts.getDecorators(node) ?? [])
    .map((decorator) => decorator.expression)
    .filter((expression) => ts.isCallExpression(expression));
}

function decoratorName(call, sourceFile) {
  return call.expression.getText(sourceFile);
}

function statusFromHttpCode(call, sourceFile, checker) {
  const argument = call.arguments[0];
  if (argument === undefined) fail(`@HttpCode() with no argument in ${sourceFile.fileName}`);
  if (ts.isNumericLiteral(argument)) return Number(argument.text);
  const constant = checker.getConstantValue(argument);
  if (typeof constant === "number") return constant;
  const text = argument.getText(sourceFile);
  const match = /^HttpStatus\.([A-Z_]+)$/.exec(text);
  if (match !== null) {
    const fallback = HTTP_STATUS_FALLBACK[match[1]];
    if (fallback !== undefined) return fallback;
    fail(
      `@HttpCode(${text}) uses an HttpStatus member with no entry in HTTP_STATUS_FALLBACK; ` +
        `add it there and to the named join in scripts/openapi-schema-derivation.test.mjs`,
    );
  }
  return fail(`@HttpCode(${text}) is not a numeric literal or a known HttpStatus member`);
}

/* ---------------------------------------------------------------------------
 * TYPE -> JSON SCHEMA
 * ------------------------------------------------------------------------- */

function isUnderCoreApi(symbol, coreApiSrc) {
  const declarations = symbol.declarations ?? [];
  return declarations.some((declaration) =>
    declaration.getSourceFile().fileName.startsWith(`${coreApiSrc}${sep}`),
  );
}

/**
 * The component name for a named, repository-declared type.
 *
 * A generic instantiation is named for its target and its arguments, so
 * `ItemEnvelope<OrganizationResource>` becomes `ItemEnvelope_OrganizationResource`
 * — one component per distinct wire shape, and a name a client generator can
 * turn into an identifier.
 */
function componentNameFor(type, context) {
  const symbol = type.aliasSymbol ?? type.symbol;
  if (symbol === undefined) return null;
  const name = symbol.getName();
  if (name === "__type" || name === "__object") return null;
  if (!isUnderCoreApi(symbol, context.coreApiSrc)) return null;
  const args = type.aliasSymbol
    ? (type.aliasTypeArguments ?? [])
    : (context.checker.getTypeArguments(type) ?? []);
  if (args.length === 0) return name;
  const argNames = args.map((argument) => {
    const argumentName = componentNameFor(argument, context);
    if (argumentName === null) {
      fail(`generic argument of ${name} is not a named repository type: ${context.checker.typeToString(argument)}`);
    }
    return argumentName;
  });
  return `${name}_${argNames.join("_")}`;
}

function literalSchema(type) {
  if (type.isStringLiteral()) return { const: type.value };
  if (type.isNumberLiteral()) return { const: type.value };
  return null;
}

function mergeNullable(schema) {
  if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] };
  if (Array.isArray(schema.type)) return { ...schema, type: [...schema.type, "null"] };
  return { anyOf: [schema, { type: "null" }] };
}

function objectSchema(type, context, pointer) {
  const properties = {};
  const required = [];
  for (const property of context.checker.getPropertiesOfType(type)) {
    const name = property.getName();
    const declaration = property.valueDeclaration ?? (property.declarations ?? [])[0];
    if (declaration === undefined) fail(`${pointer}.${name} has no declaration`);
    const propertyType = context.checker.getTypeOfSymbolAtLocation(property, declaration);
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
    properties[name] = schemaForType(propertyType, context, `${pointer}.${name}`);
    if (!optional) required.push(name);
  }
  if (Object.keys(properties).length === 0) fail(`${pointer} resolved to an object type with no properties`);
  const schema = { type: "object", properties };
  if (required.length > 0) schema.required = required.sort();
  // `additionalProperties` is DELIBERATELY ABSENT. ADR M0.4 section 1 promises
  // "unknown-tolerance + additive-only": a client must survive a field it has
  // not seen, and `BodyReader` ignores body keys it was not asked for. Writing
  // `additionalProperties: false` would publish the opposite promise on both
  // sides and make every additive release a breaking one for generated clients.
  return schema;
}

function schemaForType(type, context, pointer) {
  const { checker } = context;
  const flags = type.flags;
  if ((flags & ts.TypeFlags.Any) !== 0) fail(`${pointer} is \`any\``);
  if ((flags & ts.TypeFlags.Unknown) !== 0) fail(`${pointer} is \`unknown\``);
  if ((flags & ts.TypeFlags.Never) !== 0) fail(`${pointer} is \`never\``);
  if ((flags & ts.TypeFlags.TypeParameter) !== 0) fail(`${pointer} is an unresolved type parameter`);
  if ((flags & (ts.TypeFlags.ESSymbolLike | ts.TypeFlags.BigIntLike)) !== 0) {
    fail(`${pointer} is ${checker.typeToString(type)}, which has no JSON form`);
  }

  if (type.isUnion()) {
    const members = type.types.filter((member) => (member.flags & ts.TypeFlags.Undefined) === 0);
    const nullable = members.some((member) => (member.flags & ts.TypeFlags.Null) !== 0);
    const rest = members.filter((member) => (member.flags & ts.TypeFlags.Null) === 0);
    if (rest.length === 0) return { type: "null" };
    // A boolean is a union of `true | false` in the checker; collapse it back.
    if (rest.length === 2 && rest.every((member) => (member.flags & ts.TypeFlags.BooleanLiteral) !== 0)) {
      const schema = { type: "boolean" };
      return nullable ? mergeNullable(schema) : schema;
    }
    const literals = rest.map(literalSchema);
    if (literals.every((entry) => entry !== null)) {
      const values = literals.map((entry) => entry.const);
      const kinds = new Set(rest.map((member) => (member.isStringLiteral() ? "string" : "number")));
      if (kinds.size !== 1) fail(`${pointer} mixes literal kinds`);
      const schema = { type: [...kinds][0], enum: values };
      return nullable ? mergeNullable(schema) : schema;
    }
    if (rest.length === 1) {
      const schema = schemaForType(rest[0], context, pointer);
      return nullable ? mergeNullable(schema) : schema;
    }
    const branches = rest.map((member, index) => schemaForType(member, context, `${pointer}|${String(index)}`));
    return nullable ? { anyOf: [...branches, { type: "null" }] } : { anyOf: branches };
  }

  if ((flags & ts.TypeFlags.StringLike) !== 0) {
    const literal = literalSchema(type);
    return literal === null ? { type: "string" } : { type: "string", enum: [literal.const] };
  }
  if ((flags & ts.TypeFlags.NumberLike) !== 0) {
    const literal = literalSchema(type);
    return literal === null ? { type: "number" } : { type: "number", enum: [literal.const] };
  }
  if ((flags & ts.TypeFlags.BooleanLike) !== 0) return { type: "boolean" };
  if ((flags & ts.TypeFlags.Null) !== 0) return { type: "null" };

  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const [element] = checker.getTypeArguments(type);
    if (element === undefined) fail(`${pointer} is an array with no element type`);
    return { type: "array", items: schemaForType(element, context, `${pointer}[]`) };
  }

  if ((flags & ts.TypeFlags.Object) === 0) {
    fail(`${pointer} is ${checker.typeToString(type)}, which this derivation does not convert`);
  }
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) {
    fail(`${pointer} is callable (${checker.typeToString(type)}) and has no JSON form`);
  }
  if (checker.getIndexInfosOfType(type).length > 0) {
    fail(`${pointer} carries an index signature (${checker.typeToString(type)}); declare its keys`);
  }
  const symbolName = type.symbol?.getName();
  if (symbolName === "Date") fail(`${pointer} is a Date; wire types use instant()/nullableInstant()`);

  const componentName = componentNameFor(type, context);
  if (componentName === null) return objectSchema(type, context, pointer);
  if (!context.components.has(componentName)) {
    // Reserve the name BEFORE recursing so a self-referential type terminates.
    context.components.set(componentName, null);
    context.components.set(componentName, objectSchema(type, context, componentName));
  }
  return { $ref: `#/components/schemas/${componentName}` };
}

/* ---------------------------------------------------------------------------
 * HANDLERS
 * ------------------------------------------------------------------------- */

function awaited(type, checker) {
  return checker.getAwaitedType(type) ?? type;
}

function deriveHandler(method, sourceFile, className, context) {
  const { checker } = context;
  const calls = decoratorCalls(method);
  const verbCall = calls.find((call) => HTTP_VERB_DECORATORS.has(decoratorName(call, sourceFile)));
  if (verbCall === undefined) return null;
  const verb = decoratorName(verbCall, sourceFile).toLowerCase();
  const handlerName = method.name.getText(sourceFile);
  const key = `${className}.${handlerName}`;

  const httpCodeCall = calls.find((call) => decoratorName(call, sourceFile) === "HttpCode");
  const status =
    httpCodeCall === undefined
      ? (DEFAULT_STATUS_BY_VERB[verb] ?? 200)
      : statusFromHttpCode(httpCodeCall, sourceFile, checker);

  let requestBody = null;
  let queryParameters = { source: "none-declared", parameters: [] };
  const pathParameters = [];
  for (const parameter of method.parameters) {
    const parameterCalls = decoratorCalls(parameter);
    for (const call of parameterCalls) {
      const name = decoratorName(call, sourceFile);
      const parameterType = checker.getTypeAtLocation(parameter);
      if (name === "Body") {
        requestBody = schemaForType(parameterType, context, `${key}.body`);
      } else if (name === "Param") {
        const first = call.arguments[0];
        if (first === undefined || !ts.isStringLiteral(first)) {
          fail(`${key}: @Param() must name its path variable with a string literal`);
        }
        pathParameters.push({
          name: first.text,
          schema: schemaForType(parameterType, context, `${key}.param.${first.text}`),
        });
      } else if (name === "Query") {
        const declared = UNDERIVABLE_QUERY_HANDLERS[key];
        if (declared !== undefined) {
          queryParameters = { source: "not-derived", ...declared, parameters: [] };
        } else if ((parameterType.flags & ts.TypeFlags.Null) !== 0) {
          // `@Query(UNPAGED_QUERY_PIPE) _page: null` — the pipe REFUSES every
          // query parameter, and `null` is the type that says so. No parameters
          // is a derivation, not an omission.
          queryParameters = { source: "refused", parameters: [] };
        } else {
          fail(
            `${key}: @Query parameter is typed ${checker.typeToString(parameterType)}. Either it is a ` +
              `declared wire-query DTO this derivation should learn, or it is a post-parse shape that ` +
              `must be listed in UNDERIVABLE_QUERY_HANDLERS with a reason.`,
          );
        }
      }
    }
  }

  const returnType = awaited(checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(method)), checker);
  const returnsNothing = (returnType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0;
  const responseSchema = returnsNothing ? null : schemaForType(returnType, context, `${key}.response`);
  if (!returnsNothing && status === 204) {
    fail(`${key} answers 204 but returns ${checker.typeToString(returnType)}`);
  }

  return {
    key,
    verb,
    successStatus: status,
    requestBody,
    responseSchema,
    pathParameters,
    queryParameters,
  };
}

/**
 * The M0.4 section 2 failure envelope, derived from `WireError`.
 *
 * The envelope on the wire is `{ error: WireError }` — `http/failure.ts` writes
 * `JSON.stringify({ error: envelope })` — and `WireError` is the interface that
 * names every field `toWireError` copies. Deriving it from that declaration is
 * what stops the document and the transport disagreeing about, for instance,
 * whether `details` reaches a caller: it does not, because it is not on the
 * interface.
 */
function deriveErrorEnvelope(program, context) {
  const fileName = join(context.coreApiSrc, "transports", "error-status.ts");
  const sourceFile = program.getSourceFile(fileName);
  if (sourceFile === undefined) fail(`cannot find ${fileName}`);
  const declaration = sourceFile.statements.find(
    (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === "WireError",
  );
  if (declaration === undefined) fail(`transports/error-status.ts no longer declares WireError`);
  const type = context.checker.getTypeAtLocation(declaration.name);
  const reference = schemaForType(type, context, "WireError");
  context.components.set("ErrorEnvelope", {
    type: "object",
    properties: { error: reference },
    required: ["error"],
  });
  return "ErrorEnvelope";
}

/**
 * Derive the whole V1 REST contract.
 *
 * Returns handlers keyed by `Class.method` — the SAME key the operation manifest
 * already records in `implementations[].controller` / `.handler`, so the caller
 * joins schemas to operations without computing a route path a second time. Two
 * computations of one path is two answers that can disagree.
 */
export function deriveRestContract({ repoDir, overrides = new Map() } = {}) {
  if (typeof repoDir !== "string") fail("deriveRestContract requires repoDir");
  const normalisedOverrides = new Map(
    [...overrides.entries()].map(([path, text]) => [resolve(path), text]),
  );
  const program = createProgram(repoDir, normalisedOverrides);
  const coreApiSrc = join(repoDir, "apps", "core-api", "src");
  const context = {
    checker: program.getTypeChecker(),
    components: new Map(),
    coreApiSrc,
  };

  const handlers = new Map();
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.fileName.startsWith(`${join(coreApiSrc, "transports")}${sep}`)) continue;
    if (!sourceFile.fileName.endsWith(".controller.ts")) continue;
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
      const isController = decoratorCalls(statement).some(
        (call) => decoratorName(call, sourceFile) === "Controller",
      );
      if (!isController) continue;
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const derived = deriveHandler(member, sourceFile, statement.name.text, context);
        if (derived !== null) handlers.set(derived.key, derived);
      }
    }
  }
  if (handlers.size === 0) fail("no core-api transport handlers were found; the scan root is wrong");
  const errorComponent = deriveErrorEnvelope(program, context);

  return {
    handlers,
    components: Object.fromEntries([...context.components.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    errorComponent,
  };
}

export { DerivationError, HTTP_STATUS_FALLBACK };
