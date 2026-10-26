import { readBuildInfo } from './build-info.ts';
import { monitorConfig } from './config.ts';
import { EventReceiver } from './receiver.ts';
import { Recorder, stdoutSink } from './logger.ts';
import { Metrics, runtimeMetrics } from './metrics.ts';
import { startReceiverServer } from './server.ts';

async function main(): Promise<void> {
  const metrics = new Metrics({ environment: process.env.NODE_ENV });
  const recorder = new Recorder({
    sink: (record) => {
      stdoutSink(record);
      metrics.observe(record);
    },
  });
  try {
    const config = monitorConfig(process.env);
    const build = readBuildInfo(new URL('../build-info.json', import.meta.url));
    metrics.monitorStarted(build);
    recorder.record('info', 'monitor-started', { build, config });
    const receiver = new EventReceiver({ recorder, metrics });
    const server = await startReceiverServer(config.port, {
      receiver,
      metrics,
      version: build.version,
      progressTimeoutSeconds: config.progressTimeoutSeconds,
      runtime: runtimeMetrics(),
    });
    const stop = (): void => {
      server.close();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (error) {
    recorder.monitorFailed(error);
    process.exitCode = 1;
  }
}

await main();
