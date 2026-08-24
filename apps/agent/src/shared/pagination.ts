import { BadRequestException } from "@nestjs/common";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

export type PageRequest = {
  page: number;
  pageSize: number;
  offset: number;
  search: string | null;
};

export type PageMetadata = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  from: number;
  to: number;
  hasPrevious: boolean;
  hasNext: boolean;
  isFirstPage: boolean;
  isLastPage: boolean;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function parseEnumFilter<const T extends string>(
  value: string | undefined,
  name: string,
  allowed: readonly T[],
): T | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (!allowed.includes(normalized as T)) {
    throw new BadRequestException({
      code: "INVALID_FILTER",
      message: `${name} must be one of: ${allowed.join(", ")}`,
    });
  }
  return normalized as T;
}

export function parsePositiveIntegerFilter(
  value: string | undefined,
  name: string,
  options: { defaultValue?: number; maximum?: number } = {},
): number | undefined {
  if (value === undefined || value === "") return options.defaultValue;
  const parsed = integer(value, name, 1);
  if (parsed !== undefined && options.maximum !== undefined && parsed > options.maximum) {
    throw new BadRequestException({
      code: "INVALID_FILTER",
      message: `${name} must be less than or equal to ${options.maximum}`,
    });
  }
  return parsed;
}

export function parseBooleanFilter(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new BadRequestException({
    code: "INVALID_FILTER",
    message: `${name} must be true or false`,
  });
}

export function parseTextFilter(
  value: string | undefined,
  name: string,
  maximumLength = 200,
): string | null {
  const normalized = value?.trim() || null;
  if (normalized && normalized.length > maximumLength) {
    throw new BadRequestException({
      code: "INVALID_FILTER",
      message: `${name} must be at most ${maximumLength} characters`,
    });
  }
  return normalized;
}

function integer(value: string | undefined, name: string, minimum: number): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) {
    throw new BadRequestException({
      code: "INVALID_PAGINATION",
      message: `${name} must be an integer greater than or equal to ${minimum}`,
    });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new BadRequestException({
      code: "INVALID_PAGINATION",
      message: `${name} must be an integer greater than or equal to ${minimum}`,
    });
  }
  return parsed;
}

export function parsePageRequest(
  raw: { page?: string; limit?: string; offset?: string; search?: string },
  options: { defaultPageSize?: number; maxPageSize?: number; maxSearchLength?: number } = {},
): PageRequest {
  const maxPageSize = options.maxPageSize ?? MAX_PAGE_SIZE;
  const requestedPageSize = integer(raw.limit, "limit", 1) ?? options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  if (requestedPageSize > maxPageSize) {
    throw new BadRequestException({
      code: "INVALID_PAGINATION",
      message: `limit must be less than or equal to ${maxPageSize}`,
    });
  }
  const page = integer(raw.page, "page", 1);
  const requestedOffset = integer(raw.offset, "offset", 0);
  const offset = page !== undefined ? (page - 1) * requestedPageSize : requestedOffset ?? 0;
  const search = raw.search?.trim() || null;
  if (search && search.length > (options.maxSearchLength ?? 200)) {
    throw new BadRequestException({
      code: "INVALID_FILTER",
      message: `search must be at most ${options.maxSearchLength ?? 200} characters`,
    });
  }
  return {
    page: Math.floor(offset / requestedPageSize) + 1,
    pageSize: requestedPageSize,
    offset,
    search,
  };
}

export function pageMetadata(total: number, request: Pick<PageRequest, "pageSize" | "offset">): PageMetadata {
  const safeTotal = Math.max(0, Math.floor(total));
  const totalPages = safeTotal === 0 ? 0 : Math.ceil(safeTotal / request.pageSize);
  const page = Math.floor(request.offset / request.pageSize) + 1;
  const from = safeTotal === 0 || request.offset >= safeTotal ? 0 : request.offset + 1;
  const to = from === 0 ? 0 : Math.min(request.offset + request.pageSize, safeTotal);
  const hasPrevious = request.offset > 0;
  const hasNext = request.offset + request.pageSize < safeTotal;
  return {
    page,
    pageSize: request.pageSize,
    total: safeTotal,
    totalPages,
    from,
    to,
    hasPrevious,
    hasNext,
    isFirstPage: !hasPrevious,
    isLastPage: !hasNext,
  };
}
