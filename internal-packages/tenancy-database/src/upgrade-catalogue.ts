// The physical shape of a live database, read back from PostgreSQL's own
// catalogue, and the difference between two of them.
//
// WIN-258 T7. The expand/contract question is not "what did we mean to change";
// it is "what did the database actually end up with". Reading `schema.prisma`
// or the migration text answers the first. Reading `information_schema` and
// `pg_catalog` on a container that has just run the ordered migration set
// answers the second, and only the second can be compared against what an old
// binary is able to issue.
//
// FOUR DIMENSIONS, AND WHY EXACTLY THESE. A column that disappeared, was renamed
// or changed type breaks an old binary's SELECT. A column that became NOT NULL
// without a DEFAULT breaks its INSERT. A CHECK or a foreign key that appeared
// breaks its INSERT for a different reason. An index that appeared breaks
// nothing but changes what a plan costs, so it is measured and reported rather
// than judged. Routines are captured by NAME because the row-level rules the
// migrations install are functions, and a rule that appeared is a write the old
// binary may no longer make — demonstrated behaviourally by the write probes
// rather than inferred from a function body.
//
// `_prisma_migrations` IS EXCLUDED. It is the migration runner's bookkeeping and
// belongs to neither binary's data contract; leaving it in would put a row-count
// change in a schema delta.

export interface CatalogueColumn {
  readonly table: string;
  readonly column: string;
  readonly dataType: string;
  readonly udtName: string;
  readonly isNullable: boolean;
  readonly columnDefault: string | null;
}

export interface CatalogueNamedItem {
  readonly table: string;
  readonly name: string;
  readonly definition: string;
}

export interface Catalogue {
  readonly columns: readonly CatalogueColumn[];
  readonly constraints: readonly CatalogueNamedItem[];
  readonly indexes: readonly CatalogueNamedItem[];
  readonly routines: readonly string[];
}

/** What one dimension of a catalogue difference looks like. */
export interface CatalogueDelta<Item> {
  readonly added: readonly Item[];
  readonly removed: readonly Item[];
  readonly changed: readonly { readonly before: Item; readonly after: Item }[];
}

export interface CatalogueDifference {
  readonly columns: CatalogueDelta<CatalogueColumn>;
  readonly constraints: CatalogueDelta<CatalogueNamedItem>;
  readonly indexes: CatalogueDelta<CatalogueNamedItem>;
  readonly routines: CatalogueDelta<string>;
}

/** Anything able to answer a raw query — the live client or a rebuilt one. */
export interface CatalogueReader {
  $queryRawUnsafe<Row>(sql: string, ...values: unknown[]): Promise<Row[]>;
}

const COLUMN_SQL = `
  SELECT table_name  AS "table",
         column_name AS "column",
         data_type   AS "dataType",
         udt_name    AS "udtName",
         is_nullable AS "isNullable",
         column_default AS "columnDefault"
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
  ORDER BY table_name, column_name
`;

const CONSTRAINT_SQL = `
  SELECT rel.relname AS "table",
         con.conname AS "name",
         pg_get_constraintdef(con.oid) AS "definition"
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
  JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE ns.nspname = 'public' AND rel.relname <> '_prisma_migrations'
  ORDER BY rel.relname, con.conname
`;

const INDEX_SQL = `
  SELECT tablename AS "table",
         indexname AS "name",
         indexdef  AS "definition"
  FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  ORDER BY tablename, indexname
`;

const ROUTINE_SQL = `
  SELECT proc.proname AS "name"
  FROM pg_catalog.pg_proc proc
  JOIN pg_catalog.pg_namespace ns ON ns.oid = proc.pronamespace
  WHERE ns.nspname = 'public'
  ORDER BY proc.proname
`;

interface RawColumn {
  table: string;
  column: string;
  dataType: string;
  udtName: string;
  isNullable: string;
  columnDefault: string | null;
}

/** Read the whole physical shape of the `public` schema. */
export async function readCatalogue(reader: CatalogueReader): Promise<Catalogue> {
  const rawColumns = await reader.$queryRawUnsafe<RawColumn>(COLUMN_SQL);
  const constraints = await reader.$queryRawUnsafe<CatalogueNamedItem>(CONSTRAINT_SQL);
  const indexes = await reader.$queryRawUnsafe<CatalogueNamedItem>(INDEX_SQL);
  const routines = await reader.$queryRawUnsafe<{ name: string }>(ROUTINE_SQL);
  return {
    columns: rawColumns.map((row) => ({
      table: row.table,
      column: row.column,
      dataType: row.dataType,
      udtName: row.udtName,
      isNullable: row.isNullable === "YES",
      columnDefault: row.columnDefault,
    })),
    constraints,
    indexes,
    routines: routines.map((row) => row.name),
  };
}

function diff<Item>(
  before: readonly Item[],
  after: readonly Item[],
  key: (item: Item) => string,
  same: (left: Item, right: Item) => boolean,
): CatalogueDelta<Item> {
  const beforeByKey = new Map(before.map((item) => [key(item), item]));
  const afterByKey = new Map(after.map((item) => [key(item), item]));
  const added: Item[] = [];
  const removed: Item[] = [];
  const changed: { before: Item; after: Item }[] = [];
  for (const [id, item] of afterByKey) {
    const previous = beforeByKey.get(id);
    if (previous === undefined) added.push(item);
    else if (!same(previous, item)) changed.push({ before: previous, after: item });
  }
  for (const [id, item] of beforeByKey) {
    if (!afterByKey.has(id)) removed.push(item);
  }
  return { added, removed, changed };
}

const sameColumn = (left: CatalogueColumn, right: CatalogueColumn): boolean =>
  left.dataType === right.dataType &&
  left.udtName === right.udtName &&
  left.isNullable === right.isNullable &&
  left.columnDefault === right.columnDefault;

const sameNamed = (left: CatalogueNamedItem, right: CatalogueNamedItem): boolean =>
  left.definition === right.definition;

/** What the ordered migration set did to a database, measured on both sides. */
export function compareCatalogues(before: Catalogue, after: Catalogue): CatalogueDifference {
  return {
    columns: diff(
      before.columns,
      after.columns,
      (item) => `${item.table}.${item.column}`,
      sameColumn,
    ),
    constraints: diff(
      before.constraints,
      after.constraints,
      (item) => `${item.table}.${item.name}`,
      sameNamed,
    ),
    indexes: diff(before.indexes, after.indexes, (item) => `${item.table}.${item.name}`, sameNamed),
    routines: diff(
      before.routines,
      after.routines,
      (name) => name,
      (left, right) => left === right,
    ),
  };
}

/**
 * A column an old binary can no longer INSERT without naming.
 *
 * NOT NULL with no DEFAULT is the whole test. A NOT NULL column WITH a default
 * is invisible to a writer that never mentions it; a nullable one is invisible
 * too. This is the shape that turns an old binary's INSERT into SQLSTATE 23502.
 */
export function isMandatoryWithoutDefault(column: CatalogueColumn): boolean {
  return !column.isNullable && column.columnDefault === null;
}
