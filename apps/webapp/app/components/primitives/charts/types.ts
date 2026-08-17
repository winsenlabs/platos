export type AggregationType = "sum" | "avg" | "count" | "min" | "max";

export type BigNumberAggregationType = AggregationType | "first" | "last";

export type BigNumberConfiguration = {
  column: string;
  aggregation: BigNumberAggregationType;
  sortDirection?: "asc" | "desc";
  abbreviate?: boolean;
  prefix?: string;
  suffix?: string;
};
