// Shared-secret auth for the API surface.
//
// The `/api/*` routes are not ordinary reads. `/api/generate/script` spends
// money on every call — an unauthenticated caller who can reach the pod can
// burn the whole LLM budget — and `/api/publish/youtube` publishes to the
// project's real channel. Neither should be reachable by anything that merely
// has network access to the Service.
//
// Uses the same `x-server-auth` header the cluster's own services use
// (dd-browser-test-server), so one convention covers the platform.
import crypto from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const HEADER = 'x-server-auth';

export function serverAuthSecret(): string {
  return process.env.SERVER_AUTH_SECRET ?? '';
}

export function isAuthConfigured(): boolean {
  return serverAuthSecret().length > 0;
}

/**
 * Compare without leaking length or content through timing.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself be an oracle,
 * so both sides are hashed to a fixed width first and the digests compared.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Routes below this prefix require the shared secret. */
export function isProtectedPath(url: string): boolean {
  return url.startsWith('/api/');
}

/**
 * Fastify `onRequest` hook.
 *
 * Fails closed: with no secret configured the protected routes answer 503
 * rather than serving. Treating "unconfigured" as "open" is how a paid,
 * publish-capable endpoint ends up exposed by a missing env var.
 */
export async function requireServerAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!isProtectedPath(request.url)) return;

  const expected = serverAuthSecret();
  if (!expected) {
    request.log.error('SERVER_AUTH_SECRET not configured; refusing protected request');
    await reply.status(503).send({ error: 'Server auth is not configured' });
    return;
  }

  const presented = request.headers[HEADER];
  if (typeof presented !== 'string' || !secretsMatch(presented, expected)) {
    await reply.status(401).send({ error: 'Unauthorized' });
  }
}
