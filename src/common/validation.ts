/** Whether a value is a non-null object whose fields can be inspected. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Resolve an optional value that is required by the selected mode or operation. */
export function requireDefined<Value>(field: string, value: Value | undefined): Value {
  if (value === undefined) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

/** Require a safe integer within the inclusive bounds. */
export function requireInteger(field: string, value: number, range: { min: number; max?: number }): void {
  const max = range.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${field} must be a safe integer`);
  }
  if (value < range.min || value > max) {
    throw new RangeError(`${field} must be between ${range.min} and ${max}`);
  }
}
