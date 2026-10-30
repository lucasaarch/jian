import type { RemoteResult } from '@jian/contracts';
import type { Logger } from './log.ts';
import { STDERR_CAP, STDOUT_CAP } from './shell.ts';

/**
 * Max JSON body for a result POST. The gateway route allows 512 KiB; leave headroom for
 * framing so a full screenshot still fits without a 413.
 */
const RESULT_BODY_BUDGET = 480_000;
/** Permanent HTTP statuses — retrying forever leaves the task stuck and the machine offline. */
const PERMANENT_RESULT_STATUS = new Set([400, 401, 403, 404, 413]);

/** Shrink stdout/stderr until the JSON body fits under budget (UTF-8 byte length). */
export function fitResult(
  result: RemoteResult,
  budget = RESULT_BODY_BUDGET,
): { result: RemoteResult; body: string } {
  let stdout = result.stdout ?? '';
  let stderr = result.stderr ?? '';
  const computer = result.computer;
  const pack = () =>
    JSON.stringify({
      taskId: result.taskId,
      exitCode: result.exitCode,
      stdout,
      stderr,
      timedOut: Boolean(result.timedOut),
      ...(computer ? { computer } : {}),
    });
  let body = pack();
  if (Buffer.byteLength(body) <= budget) {
    return {
      result: {
        ...result,
        stdout,
        stderr,
        timedOut: Boolean(result.timedOut),
        ...(computer ? { computer } : {}),
      },
      body,
    };
  }

  const note = '\n… truncated to fit the gateway size limit';
  while (Buffer.byteLength(body) > budget && stdout.length > 0) {
    const overflow = Buffer.byteLength(body) - budget + Buffer.byteLength(note);
    const cut = Math.min(stdout.length, Math.max(2048, overflow));
    stdout = stdout.slice(0, Math.max(0, stdout.length - cut));
    body = pack();
  }
  if (stdout.length < (result.stdout?.length ?? 0))
    stdout = `${stdout}${note}`.slice(0, STDOUT_CAP);

  body = pack();
  while (Buffer.byteLength(body) > budget && stderr.length > 0) {
    const overflow = Buffer.byteLength(body) - budget + Buffer.byteLength(note);
    const cut = Math.min(stderr.length, Math.max(1024, overflow));
    stderr = stderr.slice(0, Math.max(0, stderr.length - cut));
    body = pack();
  }
  if (stderr.length < (result.stderr?.length ?? 0))
    stderr = `${stderr}${note}`.slice(0, STDERR_CAP);

  body = pack();
  if (Buffer.byteLength(body) > budget) {
    // Last resort: drop payloads so the agent unblocks instead of spinning on 413.
    stdout = '';
    stderr = 'Result omitted: payload exceeded the gateway size limit after truncation.';
    body = pack();
  }

  return {
    result: { ...result, stdout, stderr, timedOut: Boolean(result.timedOut) },
    body,
  };
}

export async function postResult(
  base: string,
  headers: Record<string, string>,
  result: RemoteResult,
  log: Logger,
): Promise<void> {
  let { result: payload, body } = fitResult(result);
  let failures = 0;
  // full → half → minimal → stop. Never spin forever on 413; that left machines offline.
  let shrinkStage: 'full' | 'half' | 'minimal' = 'full';

  while (true) {
    try {
      const saved = await fetch(`${base}/tasks/${result.taskId}/result`, {
        method: 'POST',
        redirect: 'error',
        headers: { ...headers, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (saved.ok) return;

      if (saved.status === 413) {
        if (shrinkStage === 'full') {
          log.warn('result post failed: HTTP 413 (payload too large); truncating and retrying');
          shrinkStage = 'half';
          ({ result: payload, body } = fitResult(payload, Math.floor(RESULT_BODY_BUDGET / 2)));
          continue;
        }
        if (shrinkStage === 'half') {
          log.warn('result still too large after truncation; sending a minimal stub');
          shrinkStage = 'minimal';
          ({ result: payload, body } = fitResult(
            {
              ...payload,
              stdout: '',
              stderr:
                'Result omitted: gateway rejected the payload as too large (HTTP 413) after truncation.',
            },
            8_000,
          ));
          continue;
        }
        log.warn(
          'result post rejected: HTTP 413 even for a minimal stub. Not retrying. Restart the Jian Remote service or re-run install if the machine stays offline.',
        );
        return;
      }

      if (PERMANENT_RESULT_STATUS.has(saved.status)) {
        log.warn(
          `result post rejected: HTTP ${saved.status}. Not retrying. Restart the Jian Remote service or re-run install if the machine stays offline.`,
        );
        return;
      }

      throw new Error(`result post failed: HTTP ${saved.status}`);
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      log.warn(message);
      if (failures >= 40) {
        log.warn(
          'Gave up posting this result after repeated failures. The gateway task may stay open until the worker recovers; restart the Jian Remote service if Online stays red.',
        );
        return;
      }
      const ceiling = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.random() * ceiling));
    }
  }
}
