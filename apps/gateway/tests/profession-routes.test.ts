import { professionCatalogSchema } from '@jian/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testServices } from './helpers/services.js';

const token = 'profession-test-token-'.repeat(3);
let services: Awaited<ReturnType<typeof testServices>>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  services = await testServices();
  app = createApp({ ...services, token, logger: false });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await services?.store.close();
});

describe('profession catalog API', () => {
  it('requires host authorization, not a public profession list', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/professions' });
    expect(response.statusCode).toBe(401);
  });

  it('returns versioned definitions with assignment explicitly unavailable', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/professions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = professionCatalogSchema.parse(response.json());
    expect(body.assignable).toBe(false);
    expect(body.professions.map((item) => item.id)).toEqual(['developer', 'attendant']);
  });
});
