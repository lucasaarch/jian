import { expect, it } from 'vitest';
import { cronFor, describeCron, isoToZonedLocal, readCron, zonedToIso } from './time';

it('reads a typed time in the owner’s zone, across a daylight-saving change', () => {
  expect(zonedToIso('2026-10-02T15:00', 'America/Sao_Paulo')).toBe('2026-10-02T15:00:00-03:00');
  // New York is -04:00 in summer and -05:00 in winter.
  expect(zonedToIso('2026-07-01T09:30', 'America/New_York')).toBe('2026-07-01T09:30:00-04:00');
  expect(zonedToIso('2026-12-01T09:30', 'America/New_York')).toBe('2026-12-01T09:30:00-05:00');
  expect(isoToZonedLocal('2026-10-02T18:00:00.000Z', 'America/Sao_Paulo')).toBe('2026-10-02T15:00');
});

it('names the common repetitions and round-trips them', () => {
  expect(describeCron('0 8 * * *')).toBe('Every day at 08:00');
  expect(describeCron('30 9 * * 1-5')).toBe('Weekdays at 09:30');
  expect(describeCron('0 18 * * 5')).toBe('Every Friday at 18:00');
  expect(describeCron('0 10 1 * *')).toBe('Every month on day 1 at 10:00');
  expect(describeCron('*/15 * * * *')).toBe('Cron */15 * * * *');

  const weekly = readCron(cronFor('weekly', '18:00', 5));

  expect(weekly).toMatchObject({ repeat: 'weekly', time: '18:00', weekday: 5 });
});
