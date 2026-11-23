import { expect, it } from 'vitest';
import { DeviceIntake } from '../src/channels/whatsapp/intake.js';

const later = () => new Promise((resolve) => setTimeout(resolve, 1));

it('holds few attachments at once and keeps each chat in the order it arrived', async () => {
  const intake = new DeviceIntake(2);
  const done: string[] = [];
  let busy = 0;
  let most = 0;
  const attachment = (name: string) => async () => {
    busy += 1;
    most = Math.max(most, busy);
    await later();
    busy -= 1;
    done.push(name);
  };
  const work: Promise<void>[] = [];

  for (let chat = 0; chat < 6; chat++) {
    work.push(intake.take(`chat-${chat}`, true, attachment(`${chat}:photo`)));
    work.push(
      intake.take(`chat-${chat}`, false, async () => {
        done.push(`${chat}:text`);
      }),
    );
  }
  await Promise.all(work);

  expect(most).toBe(2);
  for (let chat = 0; chat < 6; chat++) {
    expect(done.indexOf(`${chat}:photo`)).toBeLessThan(done.indexOf(`${chat}:text`));
  }
});

it('goes on with a chat after one of its messages failed, and reports that failure', async () => {
  const intake = new DeviceIntake(1);
  const done: string[] = [];
  const failed = intake.take('chat', true, async () => {
    throw new Error('download failed');
  });
  const next = intake.take('chat', true, async () => {
    done.push('next');
  });

  await expect(failed).rejects.toThrow('download failed');
  await next;
  expect(done).toEqual(['next']);
});
