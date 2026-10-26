import assert from 'node:assert/strict';
import test from 'node:test';
import { Recorder, stdoutSink } from '../../monitoring/logger.ts';
import type { LogRecord } from '../../monitoring/logger.ts';

test('local and received records share a run sequence and retain independent source timestamps', () => {
  const records: LogRecord[] = [];
  const recorder = new Recorder({ sink: (record) => records.push(record), clock: () => 2000, runId: 'receiver-1' });
  recorder.record('info', 'monitor-started', { version: 'test' });
  recorder.received({
    event: 'cycle.started',
    level: 'info',
    cycleId: 'sdk-1',
    timestamp: 1000,
    details: { count: 7n },
  });
  recorder.received({ event: 'report.started', level: 'info', cycleId: 'sdk-1', details: { operationId: 'report-1' } });
  assert.deepEqual(records, [
    {
      schemaVersion: 1,
      timestamp: '1970-01-01T00:00:02.000Z',
      level: 'info',
      event: 'monitor-started',
      runId: 'receiver-1',
      sequence: 1,
      details: { version: 'test' },
    },
    {
      schemaVersion: 1,
      timestamp: '1970-01-01T00:00:01.000Z',
      level: 'info',
      event: 'cycle.started',
      runId: 'receiver-1',
      sequence: 2,
      source: 'sdk',
      cycleId: 'sdk-1',
      details: { count: '7' },
    },
    {
      schemaVersion: 1,
      timestamp: '1970-01-01T00:00:02.000Z',
      level: 'info',
      event: 'report.started',
      runId: 'receiver-1',
      sequence: 3,
      source: 'sdk',
      cycleId: 'sdk-1',
      details: { operationId: 'report-1' },
    },
  ]);
});

test('fatal startup records bound error fields and remove URLs without retaining a stack', () => {
  const records: LogRecord[] = [];
  const recorder = new Recorder({ sink: (record) => records.push(record) });
  const error = new Error(`https://private.example/key ${'x'.repeat(1000)}`);
  error.name = 'E'.repeat(200);
  recorder.monitorFailed(error);
  const record = records[0];
  assert.ok(record !== undefined);
  assert.equal(record.level, 'fatal');
  assert.equal(record.event, 'monitor-failed');
  assert.deepEqual(record.details.error, {
    name: `${'E'.repeat(99)}…`,
    message: `[url] ${'x'.repeat(493)}…`,
  });
  assert.ok(!JSON.stringify(record).includes('private.example'));
});

test('startup records print unknown failures and tolerate values whose string conversion fails', () => {
  const records: LogRecord[] = [];
  const recorder = new Recorder({ sink: (record) => records.push(record) });
  recorder.monitorFailed('listen failed');
  recorder.monitorFailed({
    toString: () => {
      throw new Error('conversion failed');
    },
  });
  assert.deepEqual(
    records.map((record) => record.details.error),
    [
      { name: 'Error', message: 'listen failed' },
      { name: 'Error', message: '[unprintable]' },
    ],
  );
});

test('stdout receives exactly one JSON line with the complete record', (context) => {
  const write = context.mock.method(process.stdout, 'write', () => true);
  const recorder = new Recorder({ sink: stdoutSink, clock: () => 0, runId: 'receiver-1' });
  recorder.record('info', 'monitor-started', {});
  assert.equal(write.mock.callCount(), 1);
  const line = write.mock.calls[0]?.arguments[0];
  assert.ok(typeof line === 'string');
  assert.equal(line.split('\n').length, 2);
  assert.ok(line.endsWith('\n'));
  const record: unknown = JSON.parse(line);
  assert.deepEqual(record, {
    schemaVersion: 1,
    timestamp: '1970-01-01T00:00:00.000Z',
    level: 'info',
    event: 'monitor-started',
    runId: 'receiver-1',
    sequence: 1,
    details: {},
  });
});
