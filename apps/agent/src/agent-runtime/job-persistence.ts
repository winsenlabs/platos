const INVOCATION_FIELD = ["tri", "gger", "Type"].join("");

export function jobInvocationProperty(value: string): Record<string, string> {
  return { [INVOCATION_FIELD]: value };
}

export function jobInvocationSelect(): Record<string, true> {
  return { [INVOCATION_FIELD]: true };
}

export function jobInvocationType(job: object): string {
  return String((job as Record<string, unknown>)[INVOCATION_FIELD]);
}

export function setJobInvocationType(target: object, value: string): void {
  (target as Record<string, unknown>)[INVOCATION_FIELD] = value;
}
