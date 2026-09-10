import type { FastifyInstance } from 'fastify';
import { createMiddleware, defaultConfig, contractVersion } from '@oresoftware/ores-middleware';
import { expressMiddleware } from '@oresoftware/ores-middleware/adapters';

const config = defaultConfig('act-ai-server');
// Keep the service's existing paid-route admission policy authoritative during
// this first rollout. Distributed/shared limiting can be enabled separately.
config.settings.rateLimit.enabled = false;
config.settings.tls.requireHttps = false;
config.settings.tls.mode = 'disabled';

const middleware = expressMiddleware(createMiddleware(config));

export { contractVersion };

export function installOresMiddleware(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    middleware(request.raw, reply.raw, done);
  });
}
