export type CollectionConfig = {
  defaultPageSize?: number;
  maxPageSize?: number;
  limitParam?: "limit" | "take";
  search?: boolean;
  filters?: string[];
  pageParam?: string;
  pageSizeParam?: string;
  searchParam?: string;
};

export type CollectionQuery = {
  page: number;
  pageSize: number;
  offset: number;
  search: string;
  filters: Record<string, string>;
};

function integer(value: string | null, name: string, fallback: number, minimum: number) {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Response(`${name} must be an integer`, { status: 400, statusText: "Malformed pagination" });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Response(`${name} is out of range`, { status: 400, statusText: "Malformed pagination" });
  return parsed;
}

export function parseCollectionQuery(url: URL, config: CollectionConfig): CollectionQuery {
  const maxPageSize = config.maxPageSize ?? 100;
  const pageParam = config.pageParam ?? "page";
  const pageSizeParam = config.pageSizeParam ?? "pageSize";
  const searchParam = config.searchParam ?? "search";
  const page = integer(url.searchParams.get(pageParam), pageParam, 1, 1);
  const pageSize = integer(url.searchParams.get(pageSizeParam), pageSizeParam, config.defaultPageSize ?? 25, 1);
  if (pageSize > maxPageSize) throw new Response(`pageSize must be at most ${maxPageSize}`, { status: 400, statusText: "Malformed pagination" });
  const search = config.search ? (url.searchParams.get(searchParam)?.trim() ?? "") : "";
  if (search.length > 200) throw new Response("search must be at most 200 characters", { status: 400, statusText: "Malformed filter" });
  const filters = Object.fromEntries((config.filters ?? []).flatMap((name) => {
    const value = url.searchParams.get(name)?.trim();
    return value ? [[name, value]] : [];
  }));
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw new Response(`${pageParam} is out of range`, { status: 400, statusText: "Malformed pagination" });
  return { page, pageSize, offset, search, filters };
}

export function withCollectionQuery(path: string, query: CollectionQuery, config: CollectionConfig) {
  const url = new URL(path, "http://platos.local");
  url.searchParams.set(config.limitParam ?? "limit", String(query.pageSize));
  url.searchParams.set("offset", String(query.offset));
  if (query.search) url.searchParams.set("search", query.search);
  for (const [name, value] of Object.entries(query.filters)) url.searchParams.set(name, value);
  return `${url.pathname}${url.search}`;
}

export function collectionMetadata(total: number, query: Pick<CollectionQuery, "pageSize" | "offset">) {
  const safeTotal = Math.max(0, Math.floor(total));
  const totalPages = safeTotal === 0 ? 0 : Math.ceil(safeTotal / query.pageSize);
  const page = Math.floor(query.offset / query.pageSize) + 1;
  const from = safeTotal === 0 || query.offset >= safeTotal ? 0 : query.offset + 1;
  const to = from === 0 ? 0 : Math.min(query.offset + query.pageSize, safeTotal);
  const hasPrevious = query.offset > 0;
  const hasNext = query.offset + query.pageSize < safeTotal;
  return { page, pageSize: query.pageSize, total: safeTotal, totalPages, from, to, hasPrevious, hasNext, isFirstPage: !hasPrevious, isLastPage: !hasNext };
}
