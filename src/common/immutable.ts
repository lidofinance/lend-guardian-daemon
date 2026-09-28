import { isRecord } from './validation.ts';

/** Copy plain data and freeze its nested objects and arrays without changing the caller's values. */
export function frozenCopy<const Value>(value: Value): Readonly<Value> {
  const copy = structuredClone(value);
  freeze(copy, new WeakSet());
  return copy;
}

function freeze(value: unknown, seen: WeakSet<object>): void {
  if (!isRecord(value) || seen.has(value)) {
    return;
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Frozen copies support only plain objects and arrays');
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    freeze(child, seen);
  }
  Object.freeze(value);
}
