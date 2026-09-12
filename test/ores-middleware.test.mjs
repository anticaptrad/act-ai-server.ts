import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { contractVersion, installOresMiddleware } from '../dist/ores-middleware.js';

test('ORES middleware is installed at the Fastify raw HTTP boundary', async () => {
  assert.equal(contractVersion, '1.0.0');
  const app = Fastify({ logger: false });
  installOresMiddleware(app);
  app.get('/probe', async () => ({ ok: true }));

  const response = await app.inject({ method: 'GET', url: '/probe' });
  assert.equal(response.statusCode, 200);
  assert.ok(response.headers['x-request-id']);
  await app.close();
});
