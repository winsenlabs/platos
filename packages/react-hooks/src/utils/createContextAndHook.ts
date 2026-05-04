"use client";
// LAUNCH-9 follow-up — same CJS/ESM default-export interop hazard that
// crashed PlatosArtifact in some Remix prod bundles applies here. Use a
// namespace import for type-only `React.Context` references and named
// imports for runtime hooks. Keeps both type-safety and bundle-correctness.
import * as React from "react";
import { createContext, useContext } from "react";

export function assertContextExists(
  contextVal: unknown,
  msgOrCtx: string | React.Context<any>
): asserts contextVal {
  if (!contextVal) {
    throw typeof msgOrCtx === "string"
      ? new Error(msgOrCtx)
      : new Error(`${msgOrCtx.displayName} not found`);
  }
}

type Options = { assertCtxFn?: (v: unknown, msg: string) => void };
type ContextOf<T> = React.Context<T | undefined>;
type UseCtxFn<T> = () => T;

/**
 * Creates and returns a Context and two hooks that return the context value.
 * The Context type is derived from the type passed in by the user.
 * The first hook returned guarantees that the context exists so the returned value is always CtxValue
 * The second hook makes no guarantees, so the returned value can be CtxValue | undefined
 */
export const createContextAndHook = <CtxVal>(
  displayName: string,
  options?: Options
): [ContextOf<CtxVal>, UseCtxFn<CtxVal>, UseCtxFn<CtxVal | Partial<CtxVal>>] => {
  const { assertCtxFn = assertContextExists } = options || {};
  const Ctx = createContext<CtxVal | undefined>(undefined);
  Ctx.displayName = displayName;

  const useCtx = () => {
    const ctx = useContext(Ctx);
    assertCtxFn(ctx, `${displayName} not found`);
    return ctx as CtxVal;
  };

  const useCtxWithoutGuarantee = () => {
    const ctx = useContext(Ctx);
    return ctx ? ctx : {};
  };

  return [Ctx, useCtx, useCtxWithoutGuarantee];
};
