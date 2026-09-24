import { SCHEDULE_MIN_INTERVAL_MINUTES } from '@jian/contracts';
import { CronExpressionParser } from 'cron-parser';
import { GatewayError } from '../core/errors.js';

type Timing = { at?: string | undefined; cron?: string | undefined; timeZone: string };

/** The next time after `after`: a single time only while it is still ahead. */
export function nextRun(timing: Timing, after: Date): Date | undefined {
  if (timing.at) {
    const at = new Date(timing.at);

    return at > after ? at : undefined;
  }

  if (!timing.cron) return undefined;

  return CronExpressionParser.parse(timing.cron, { currentDate: after, tz: timing.timeZone })
    .next()
    .toDate();
}

/**
 * Refuses a repetition that cannot be read, or one that would run more often than the bound:
 * a model run every minute is a cost nobody meant, whoever typed the expression.
 */
export function assertCron(cron: string, timeZone: string) {
  let times: Date[];

  try {
    const expression = CronExpressionParser.parse(cron, { tz: timeZone, strict: false });

    times = Array.from({ length: 4 }, () => expression.next().toDate());
  } catch (error) {
    throw new GatewayError(
      400,
      `Cannot read the cron expression: ${error instanceof Error ? error.message : 'invalid'}`,
    );
  }

  if (cron.trim().split(/\s+/).length !== 5) {
    throw new GatewayError(400, 'A cron expression has five fields: minute hour day month weekday');
  }

  for (let index = 1; index < times.length; index += 1) {
    const gap = ((times[index]?.getTime() ?? 0) - (times[index - 1]?.getTime() ?? 0)) / 60_000;

    if (gap < SCHEDULE_MIN_INTERVAL_MINUTES) {
      throw new GatewayError(
        400,
        `A schedule runs at most every ${SCHEDULE_MIN_INTERVAL_MINUTES} minutes`,
      );
    }
  }
}
