// The shipped monitoring process accepts SDK events without contacting an RPC or a screening service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

async function ready(output: readonly string[], exited: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (exited()) {
      assert.fail(`monitoring exited before listening: ${output.join('')}`);
    }
    try {
      if ((await fetch('http://127.0.0.1:9464/health')).status === 200) {
        return;
      }
    } catch {
      // Startup can take several polls; the child output explains a failed start.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`monitoring did not start: ${output.join('')}`);
}

test(
  'the shipped entrypoint receives SDK events and exposes metrics without outbound requests',
  { timeout: 15000 },
  async () => {
    let outbound = 0;
    const trap = createServer((_request, response) => {
      outbound += 1;
      response.writeHead(500).end();
    });
    trap.listen(0, '127.0.0.1');
    await once(trap, 'listening');
    const address = trap.address();
    assert.ok(address !== null && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const child = spawn(process.execPath, [new URL('../../monitoring/main.ts', import.meta.url).pathname], {
      env: {
        MONITOR_PORT: '9464',
        CHAIN_ID: 'synthetic-invalid-chain',
        GUARDIAN: 'synthetic-invalid-address',
        MODE: 'synthetic-invalid-mode',
        NODE_ENV: 'test',
        RPC_URLS: endpoint,
        SCREENING_SERVICE_URL: endpoint,
        GUARDIAN_SIGNER_PRIVATE_KEY: 'synthetic-invalid-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: string[] = [];
    child.stdout.on('data', (value: Buffer) => output.push(value.toString()));
    child.stderr.on('data', (value: Buffer) => output.push(value.toString()));
    try {
      await ready(output, () => child.exitCode !== null);
      assert.equal((await fetch('http://127.0.0.1:9464/ready')).status, 503);
      const response = await fetch('http://127.0.0.1:9464/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'cycle.failed',
          cycleId: 'external-sdk-cycle',
          startedAt: 1000,
          finishedAt: 2000,
          error: { name: 'Error', message: 'synthetic RPC failure' },
        }),
      });
      assert.equal(response.status, 204);
      assert.equal((await fetch('http://127.0.0.1:9464/ready')).status, 200);
      const metrics = await (await fetch('http://127.0.0.1:9464/metrics')).text();
      assert.ok(metrics.includes('lido_lend_guardian_daemon_cycles_total{outcome="failed"} 1'));
      assert.ok(metrics.includes('nodejs_heap_size_used_bytes'));
      assert.match(
        metrics,
        /lido_lend_guardian_monitor_build_info\{name="lido-lend-guardian-monitoring",env="test",version="[^"\n]+",branch="[^"\n]+",commit="[^"\n]+"\} 1/,
      );
      assert.doesNotMatch(metrics, /chain_id=/);
      assert.equal(outbound, 0);
      assert.ok(output.join('').includes('external-sdk-cycle'));
      assert.ok(!output.join('').includes('synthetic-invalid-key'));
      assert.match(output.join(''), /"config":\{"port":9464,"progressTimeoutSeconds":1800\}/);
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
      await new Promise<void>((resolve) => trap.close(() => resolve()));
    }
  },
);
