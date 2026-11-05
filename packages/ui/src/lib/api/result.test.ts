import { expect, it } from 'vitest';
import { GatewayAnswer, result } from './result';

const answer = (status: number, body: unknown) =>
  result(
    Promise.resolve({
      error: body,
      response: new Response(null, { status }),
    }),
  );

it('tells a gateway too old for a route apart from a thing that is not there', async () => {
  await expect(answer(404, { error: 'Not Found' })).rejects.toMatchObject({
    message: 'This gateway does not have this yet. Update it to use it.',
    status: 404,
  });
  await expect(answer(404, { error: 'Session not found' })).rejects.toMatchObject({
    message: 'Session not found',
    status: 404,
  });
});

it('says why a checkout cannot be read, in place of the generic conflict', async () => {
  const refused = await answer(409, { error: 'This conversation has no checkout yet.' }).catch(
    (error: unknown) => error,
  );

  expect(refused).toBeInstanceOf(GatewayAnswer);
  expect((refused as GatewayAnswer).message).toBe('This conversation has no checkout yet.');
});

it('takes an answer with no body as a success when the gateway said 204', async () => {
  await expect(
    result(Promise.resolve({ response: new Response(null, { status: 204 }) })),
  ).resolves.toBeUndefined();
  // A 200 with nothing in it is still a broken answer.
  await expect(
    result(Promise.resolve({ response: new Response(null, { status: 200 }) })),
  ).rejects.toBeInstanceOf(GatewayAnswer);
});
