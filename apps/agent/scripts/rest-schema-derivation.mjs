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
 * Handlers whose QUERY STRING cannot be derived, and why. IT IS NOW EMPTY.
 *
 * THE LIST IS EMPTY BECAUSE THE MECHANISM LANDED AND THEN WAS USED, and both
 * halves of that sentence are the history worth keeping. Until M4 finish there
 * was no code path in this derivation that emitted a `@Query` type at all: the
 * branch that would have was the branch that raised, so a route with a query
 * string was either listed here as a gap or a generation failure, and the OpenAPI
 * ratchet could not guard a field it never saw. M4 finish added the mechanism — a
 * pipe declares the WIRE shape it accepts as `DomainValidationPipe<Parsed, Wire>`,
 * `declaredWireQueryType` reads it off the decorator through the checker — and
 * adopted it on the three MCP token lifecycle routes, including the REQUIRED
 * `environmentId` without which a generated client cannot call them. That left
 * ONE entry, `EnvironmentEndUsersController.list`, whose note said in as many
 * words that the remedy was "a change to `apps/core-api/src/transports/rest`, it
 * is not this tranche's".
 *
 * IT IS THIS ONE'S. `environment-end-users.controller.ts` now declares
 * `EndUserWireQuery` — `status?`/`search?`/`limit?`/`cursor?`, every one a string
 * — and `END_USER_QUERY_PIPE` passes it as the `Wire` argument, so the route
 * publishes the four parameters a caller actually sends instead of the
 * post-parse `EndUserQuery` that carried an `offset` nobody sends and no `cursor`
 * everybody does.
 *
 * WHY THE REGISTER STAYS RATHER THAN BEING DELETED WITH ITS LAST ENTRY. It is the
 * declared escape hatch for a route whose query string genuinely cannot be
 * described — and the `fail()` at the end of the `@Query` branch names it as the
 * alternative to a generation failure, so removing it would leave that message
 * pointing at nothing. An empty register also means something the gate can read:
 * `scripts/openapi-schema-derivation.test.mjs` asserts the document's
 * `queryParametersNotDerived` equals these keys exactly, so the empty object is
 * the assertion that NO route is currently undescribed. A future entry costs a
 * reason string of more than eighty characters and the same test demands it.
 *
 * EVERY ENTRY MUST CARRY `reason` AND `detail`. `detail` is prose a reader can act
 * on; the test refuses one under eighty characters, because "post-parse DTO" is a
 * label and not an explanation.
 */
export const UNDERIVABLE_QUERY_HANDLERS = {};

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

/**
 * The `Wire` type argument a `@Query(PIPE)` declares, or null when it declares none.
 *
 * ONE HOP THROUGH THE TYPE CHECKER, and that is why it is the pipe's type argument
 * rather than a naming convention or a second table. `@Query(LIST_QUERY_PIPE)` is
 * an expression whose type is `DomainValidationPipe<TokenListQuery,
 * TokenListWireQuery>`; asking the checker for that type's arguments answers "what
 * must a caller send" from the same declaration the parser is typed by. A rule
 * that matched `SomethingWireQuery` by NAME, or that kept a map of route to DTO,
 * would be the parallel list this file's own header refuses.
 *
 * `never` IS "NOT DECLARED" and the default on the class. It is distinguishable
 * from every real shape, which is what lets the caller below refuse rather than
 * invent — a pipe with no wire argument reaches the same failure a post-parse DTO
 * does.
 */
function declaredWireQueryType(call, context) {
  const argument = call.arguments[0];
  if (argument === undefined) return null;
  const type = context.checker.getTypeAtLocation(argument);
  if ((type.flags & ts.TypeFlags.Object) === 0) return null;
  if ((((type).objectFlags ?? 0) & ts.ObjectFlags.Reference) === 0) return null;
  const args = context.checker.getTypeArguments(type) ?? [];
  const wire = args[1];
  if (wire === undefined) return null;
  if ((wire.flags & (ts.TypeFlags.Never | ts.TypeFlags.Unknown)) !== 0) return null;
  return wire;
}

/**
 * A declared wire query as OpenAPI `parameters`, or a failure naming the property.
 *
 * EVERY VALUE IS A STRING, AND THAT IS ENFORCED RATHER THAN ASSUMED. Express hands
 * a query string's values across as strings — `page.ts` says so in its own
 * `QueryInput` — so a wire property typed `number` describes a request no caller
 * can send. Refusing it is what makes publishing a POST-PARSE shape by accident
 * impossible instead of merely documented: `TokenListQuery` carries `offset:
 * number`, so the mistake the old `UNDERIVABLE_QUERY_HANDLERS` entries warned
 * about now stops generation.
 *
 * A repeated parameter (`?a=1&a=2`) is `string[]` on the wire and every validator
 * in this tree REFUSES one by name, so an array is refused here too: publishing it
 * would document a shape the parser rejects.
 */
function wireQueryParameters(type, context, pointer) {
  const parameters = [];
  for (const property of context.checker.getPropertiesOfType(type)) {
    const name = property.getName();
    const declaration = property.valueDeclaration ?? (property.declarations ?? [])[0];
    if (declaration === undefined) fail(`${pointer}.${name} has no declaration`);
    const propertyType = context.checker.getTypeOfSymbolAtLocation(property, declaration);
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
    const schema = schemaForType(propertyType, context, `${pointer}.${name}`);
    if (schema.type !== "string") {
      fail(
        `${pointer}.${name} is ${context.checker.typeToString(propertyType)}; a wire query ` +
          `parameter is a string, because that is what Express hands a @Query() across as. A ` +
          `non-string here means the declared Wire type is a POST-PARSE shape rather than the ` +
          `wire one.`,
      );
    }
    parameters.push({ name, required: !optional, schema });
  }
  if (parameters.length === 0) fail(`${pointer} declares a wire query with no parameters`);
  return parameters.sort((left, right) => left.name.localeCompare(right.name));
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
        const wire = declaredWireQueryType(call, context);
        if (declared !== undefined) {
          queryParameters = { source: "not-derived", ...declared, parameters: [] };
        } else if (wire !== null) {
          // THE DERIVED PATH, and the one this derivation had no code for at all
          // until M4 finish. The branch that would have emitted a query type was
          // the branch that raised, so every route with a query string was either
          // listed as a gap or a generation failure — and the OpenAPI ratchet
          // cannot guard a field it never sees.
          queryParameters = {
            source: "derived",
            parameters: wireQueryParameters(wire, context, `${key}.query`),
          };
        } else if ((parameterType.flags & ts.TypeFlags.Null) !== 0) {
          // `@Query(UNPAGED_QUERY_PIPE) _page: null` — the pipe REFUSES every
          // query parameter, and `null` is the type that says so. No parameters
          // is a derivation, not an omission.
          queryParameters = { source: "refused", parameters: [] };
        } else {
          fail(
            `${key}: @Query parameter is typed ${checker.typeToString(parameterType)} and its pipe ` +
              `declares no wire shape. Give the pipe its Wire type argument — ` +
              `new DomainValidationPipe<Parsed, WireQuery>(validator) — so the document publishes ` +
              `what a caller sends, or list the route in UNDERIVABLE_QUERY_HANDLERS with a reason.`,
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
