// The OLD binaries' own data-access layers, rebuilt from frozen schemas.
//
// WIN-258 T7. WIN-258's acceptance says "old and V1 binaries are expand/contract
// compatible during rollout". Every tranche so far has discharged that with an
// ARGUMENT — "the migrations add and never remove, so by construction nothing
// old can break" — and an argument is exactly what the acceptance does not ask
// for. A rehearsal needs the old binary, and the part of an old binary that
// touches the database is its generated client: the client is what names the
// physical columns, decodes the enums, and refuses a row whose shape it does not
// recognise. Rebuild that from the release's own schema and the old binary's
// read path is present in the suite rather than reasoned about.
//
// TWO RELEASES, BECAUSE "OLD" MEANS TWO DIFFERENT THINGS HERE.
//
//   oracle-head  — origin/main at 89c12b8a, the frozen oracle. This is the
//                  ROLLOUT PARTNER: the binary that is still serving traffic
//                  while the V1 binary rolls out over the same database.
//
//   origin-main  — c25432c5, the release whose 00000000000000_initial migration
//                  is BYTE-IDENTICAL to the frozen baseline SQL sitting beside
//                  its schema in prisma/upgrade-baselines/origin-main/. This is
//                  the LEGACY UPGRADE PATH: a database provisioned by that
//                  release, which has never run a post-initial migration, and
//                  the binary that provisioned it. Its schema is the only writer
//                  that physically cannot set a column added since the baseline,
//                  which is what makes it the honest producer of the rows the
//                  V1 stores have to be able to read.
//
// THE SCHEMAS ARE COMMITTED BYTE-FOR-BYTE and pinned by sha256 below, the same
// discipline the baseline SQL beside them already uses. A schema regenerated
// from history at run time would make the suite depend on git, and a schema
// re-typed by hand would be a schema this suite agreed with because the same
// person wrote both.
//
// THE GENERATOR OUTPUT IS REWRITTEN, AND ONLY THAT LINE. Both frozen schemas say
// `output = "../generated/control"`, which is where the LIVE client goes; left
// alone the second generate would overwrite the first and both would overwrite
// the client the rest of the package imports. The copy is written under
// generated/upgrade/<release>/ with the output redirected beside it, and the
// rewrite FAILS LOUD if the line it expects is not there, because a silent
// no-match would generate over the live client.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(__dirname, "..");

/** Refused when a frozen schema no longer hashes to its pin. */
export const UPGRADE_BASELINE_SCHEMA_DRIFT = "tenancy.upgrade_baseline.schema_drift";

/** Refused when the generator output line is not where the rewrite expects it. */
export const UPGRADE_BASELINE_OUTPUT_UNPINNED = "tenancy.upgrade_baseline.output_unpinned";

export class UpgradeBaselineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UpgradeBaselineError";
    this.code = code;
  }
}

export interface UpgradeBaselineRelease {
  /** Directory under prisma/upgrade-baselines/ that holds the frozen schema. */
  readonly name: string;
  /** The commit the schema was frozen from. */
  readonly commit: string;
  /** sha256 of the committed schema file. */
  readonly schemaSha256: string;
  /** What this release is, in one line, for a failure message. */
  readonly role: string;
}

export const UPGRADE_BASELINE_RELEASES: Readonly<Record<string, UpgradeBaselineRelease>> =
  Object.freeze({
    "oracle-head": {
      name: "oracle-head",
      commit: "89c12b8aa8da75c561dc879f370aaefb6e3359bc",
      schemaSha256: "a14129d38ae09c46a200ecc7ce804862e36ee58e3884081e90c61d1d14bd3021",
      role: "origin/main HEAD, the binary the V1 binary rolls out alongside",
    },
    "origin-main": {
      name: "origin-main",
      commit: "c25432c5da0627ae7312bcd64329341d2335e540",
      schemaSha256: "90febf41289f5167425930f494c751471cd331b9148b06f723cd66024ea0da4f",
      role: "the release whose initial migration is the frozen upgrade baseline",
    },
  });

/** One model delegate on a rebuilt client, narrowed to what a rehearsal uses. */
export interface UpgradeBaselineDelegate {
  findMany(args?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  findUnique(args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  create(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface UpgradeBaselineClient {
  $queryRawUnsafe<Row>(sql: string, ...values: unknown[]): Promise<Row[]>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $disconnect(): Promise<void>;
}

export interface UpgradeBaselineField {
  readonly name: string;
  readonly dbName?: string | null;
  readonly kind: string;
  readonly type: string;
  readonly isList: boolean;
  readonly isRequired: boolean;
  readonly hasDefaultValue: boolean;
  readonly isId: boolean;
  readonly isUpdatedAt?: boolean;
  readonly relationFromFields?: readonly string[];
}

export interface UpgradeBaselineModel {
  readonly name: string;
  readonly dbName?: string | null;
  readonly fields: readonly UpgradeBaselineField[];
}

/** A rebuilt old binary: its client constructor and its datamodel. */
export interface UpgradeBaseline {
  readonly release: UpgradeBaselineRelease;
  readonly models: readonly UpgradeBaselineModel[];
  connect(databaseUrl: string): UpgradeBaselineClient;
}

interface GeneratedModule {
  readonly PrismaClient: new (options: {
    datasources: { db: { url: string } };
  }) => UpgradeBaselineClient;
  readonly Prisma: {
    readonly dmmf: { readonly datamodel: { readonly models: UpgradeBaselineModel[] } };
  };
}

/** The physical table a model lands on. `dbName` wins when `@@map` is present. */
export function tableOf(model: UpgradeBaselineModel): string {
  return model.dbName ?? model.name;
}

/** The physical column a field lands on. `dbName` wins when `@map` is present. */
export function columnOf(field: UpgradeBaselineField): string {
  return field.dbName ?? field.name;
}

/** Every scalar-or-enum field of a model — the columns its SELECT names. */
export function storedFields(model: UpgradeBaselineModel): readonly UpgradeBaselineField[] {
  return model.fields.filter((field) => field.kind === "scalar" || field.kind === "enum");
}

/** One delegate off a rebuilt client, by model name, with a loud miss. */
export function delegateOf(
  client: UpgradeBaselineClient,
  modelName: string,
): UpgradeBaselineDelegate {
  const key = `${modelName.charAt(0).toLowerCase()}${modelName.slice(1)}`;
  const delegate = (client as unknown as Record<string, unknown>)[key];
  if (delegate === undefined || delegate === null) {
    throw new UpgradeBaselineError(
      UPGRADE_BASELINE_SCHEMA_DRIFT,
      `rebuilt client exposes no delegate for model ${modelName} (looked for ${key})`,
    );
  }
  return delegate as UpgradeBaselineDelegate;
}

/** One model of a rebuilt datamodel, by name, with a loud miss. */
export function findBaselineModel(
  baseline: UpgradeBaseline,
  modelName: string,
): UpgradeBaselineModel {
  const model = baseline.models.find((candidate) => candidate.name === modelName);
  if (model === undefined) {
    throw new UpgradeBaselineError(
      UPGRADE_BASELINE_SCHEMA_DRIFT,
      `${baseline.release.name} has no model named ${modelName}`,
    );
  }
  return model;
}

/**
 * The ONE stored field a model has in `left` and not in `right`.
 *
 * How a rehearsal addresses a renamed column without spelling either name. A
 * literal would keep passing if a different column had been renamed instead, and
 * would keep passing if the rename were reverted and something else removed. The
 * "exactly one" is the whole assertion: two would mean the difference is not a
 * rename, and none would mean there is nothing to rehearse.
 */
export function soleStoredFieldOnlyIn(
  left: UpgradeBaseline,
  right: UpgradeBaseline,
  modelName: string,
): UpgradeBaselineField {
  const rightColumns = new Set(
    storedFields(findBaselineModel(right, modelName)).map((field) => columnOf(field)),
  );
  const only = storedFields(findBaselineModel(left, modelName)).filter(
    (field) => !rightColumns.has(columnOf(field)),
  );
  if (only.length !== 1) {
    throw new UpgradeBaselineError(
      UPGRADE_BASELINE_SCHEMA_DRIFT,
      `${modelName} differs by ${only.length} stored field(s) between ${left.release.name} ` +
        `and ${right.release.name}; a rename rehearsal needs exactly one`,
    );
  }
  return only[0] as UpgradeBaselineField;
}

const OUTPUT_LINE = /^(\s*output\s*=\s*)"[^"]*"/m;

/**
 * Check a frozen release schema and hand back the copy that may be generated.
 *
 * PURE, AND EXPORTED, so both refusals have a NAMED case that can reach them. A
 * digest check whose only input is the file it guards can never be seen to do
 * anything: the file is correct, so the branch is never taken, and a sweep that
 * removed the branch would find nothing red.
 *
 * The redirect is the second half rather than a separate step because the two
 * are one decision. Both frozen schemas say `output = "../generated/control"`,
 * which is where the LIVE client goes; generating either one unchanged would
 * overwrite the client the rest of the package imports, and generating the
 * second would overwrite the first. A rewrite that silently matched nothing
 * would do exactly that, so a miss is a refusal and not a fallback.
 */
export function verifyFrozenSchema(source: string, release: UpgradeBaselineRelease): string {
  const digest = createHash("sha256").update(source).digest("hex");
  if (digest !== release.schemaSha256) {
    throw new UpgradeBaselineError(
      UPGRADE_BASELINE_SCHEMA_DRIFT,
      `the frozen ${release.name} schema hashes to ${digest}, not the pinned ` +
        `${release.schemaSha256}; it is ${release.commit} verbatim and may not be edited`,
    );
  }
  if (!OUTPUT_LINE.test(source)) {
    throw new UpgradeBaselineError(
      UPGRADE_BASELINE_OUTPUT_UNPINNED,
      `the frozen ${release.name} schema has no generator output line to redirect; ` +
        "generating it unchanged would overwrite the live client",
    );
  }
  return source.replace(OUTPUT_LINE, '$1"./client"');
}

/**
 * Rebuild one old binary's client.
 *
 * Generation happens on demand rather than in `pnpm generate`, because these two
 * clients exist for the upgrade rehearsals alone and every build in the
 * workspace would otherwise pay for two extra schema generations it never
 * imports.
 */
export async function rebuildUpgradeBaseline(name: string): Promise<UpgradeBaseline> {
  const release = UPGRADE_BASELINE_RELEASES[name];
  if (release === undefined) {
    throw new UpgradeBaselineError(
      UPGRADE_BASELINE_SCHEMA_DRIFT,
      `no frozen release named ${name}; known releases are ` +
        Object.keys(UPGRADE_BASELINE_RELEASES).join(", "),
    );
  }

  const frozenPath = resolve(packageRoot, `prisma/upgrade-baselines/${release.name}/schema.prisma`);
  const redirected = verifyFrozenSchema(readFileSync(frozenPath, "utf8"), release);

  const workspace = resolve(packageRoot, "generated/upgrade", release.name);
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  const schemaPath = resolve(workspace, "schema.prisma");
  writeFileSync(schemaPath, redirected);

  execFileSync(
    resolve(packageRoot, "node_modules/.bin/prisma"),
    ["generate", "--schema", schemaPath],
    {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: "postgresql://generate:generate@localhost:5432/generate" },
      stdio: "pipe",
    },
  );

  const loaded = (await import(pathToFileURL(resolve(workspace, "client/index.js")).href)) as
    GeneratedModule & { default?: GeneratedModule };
  const generated =
    loaded.PrismaClient === undefined && loaded.default !== undefined ? loaded.default : loaded;

  return {
    release,
    models: generated.Prisma.dmmf.datamodel.models,
    connect: (databaseUrl: string): UpgradeBaselineClient =>
      new generated.PrismaClient({ datasources: { db: { url: databaseUrl } } }),
  };
}
