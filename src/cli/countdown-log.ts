import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Local diagnostics deliberately exclude argv, environment, credentials and error messages. */
export function countdownLog(home: string, universeId: string) {
  const directory = join(home, 'icon-countdown', 'logs');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${universeId}-${Date.now()}-${randomUUID()}.diagnostic.ndjson`);
  const started = Date.now();
  let phase = 'starting';
  const write = (event: string, data: Record<string, unknown> = {}) => {
    appendFileSync(path, JSON.stringify({ schemaVersion: 1, ...data, event, at: new Date().toISOString(), pid: process.pid, uptimeMs: Date.now() - started }) + '\n', { mode: 0o600 });
  };
  write('process-start', { universeId, parentPid: process.ppid, nodeVersion: process.version });
  const timer = setInterval(() => write('heartbeat', { phase, rssBytes: process.memoryUsage().rss }), 60_000);
  timer.unref();
  const onExit = (code: number) => { clearInterval(timer); write('process-exit', { exitCode: code, phase }); };
  const onInt = () => write('signal', { signal: 'SIGINT' });
  const onTerm = () => write('signal', { signal: 'SIGTERM' });
  const onException = () => write('uncaught-exception', { phase });
  process.once('exit', onExit);
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  process.on('uncaughtExceptionMonitor', onException);
  return {
    path,
    event(data: { event: string }) { phase = data.event; write('countdown-event', { details: data }); },
    error(code: string, httpStatus?: number) { phase = 'failed'; write('command-error', { code, httpStatus }); },
  };
}
