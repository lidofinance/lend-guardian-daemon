import test from 'node:test';
import assert from 'node:assert/strict';
import { frozenCopy } from '../../src/common/immutable.ts';

test('frozenCopy owns nested plain data without freezing the original', () => {
  const entry = { amount: 12n, evidence: undefined, coverage: null };
  const original = { entries: [entry] };
  const copy = frozenCopy(original);
  assert.deepEqual(copy, original);
  assert.notEqual(copy, original);
  assert.notEqual(copy.entries, original.entries);
  assert.notEqual(copy.entries[0], original.entries[0]);
  for (const value of [copy, copy.entries, copy.entries[0]]) {
    assert.ok(value !== undefined);
    assert.equal(Object.isFrozen(value), true);
    assert.throws(() => Object.assign(value, { changed: true }), TypeError);
  }
  entry.amount = 24n;
  original.entries.length = 0;
  assert.deepEqual(copy, { entries: [{ amount: 12n, evidence: undefined, coverage: null }] });
});

test('frozenCopy preserves shared references and cycles within its own copy', () => {
  interface Link {
    value: number;
    next?: Link;
  }
  const link: Link = { value: 1 };
  link.next = link;
  const copy = frozenCopy([link, link]);
  const copied = copy[0];
  assert.equal(copied, copy[1]);
  assert.equal(copied.next, copied);
  assert.notEqual(copied, link);
  assert.equal(Object.isFrozen(copied), true);
  link.value = 2;
  assert.equal(copied.value, 1);
});

test('frozenCopy rejects mutable built-ins that Object.freeze cannot make immutable', () => {
  for (const value of [new Map([['key', 1]]), new Set([1]), new Date(0), new Uint8Array([1])]) {
    assert.throws(() => frozenCopy({ value }), {
      name: 'TypeError',
      message: 'Frozen copies support only plain objects and arrays',
    });
    assert.equal(Object.isFrozen(value), false);
  }
});
