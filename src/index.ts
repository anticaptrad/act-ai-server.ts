// Telemetry must be imported first so auto-instrumentation patches modules
// (http, etc.) before Fastify and the SDKs require them.
import { shutdownTelemetry } from './telemetry';

import Fastify from 'fastify';
import {
  configuredProviders,
  generateScript,
  isProvider,
  ProviderNotConfiguredError,
  type Provider,
} from './providers';
import { requireServerAuth, isAuthConfigured } from './auth';
import {
  uploadToYouTube,
  classifyYouTubeError,
  isYouTubeConfigured,
  missingYouTubeConfig,
} from './youtube';

const fastify = Fastify({ logger: true });

// Guards every /api/* route. Registered before the routes so nothing can be
// added later that quietly bypasses it — probes stay public because the hook
// only matches the /api/ prefix.
fastify.addHook('onRequest', requireServerAuth);

interface ScriptRequest {
  topic: string;
  provider: Provider;
}

interface VideoRequest {
  script: string;
}

interface PublishRequest {
  filePath: string;
  title: string;
  description: string;
}

/**
 * A required text field must be a non-blank string. Whitespace-only input would
 * otherwise pass a plain truthiness check and be forwarded to a provider, which
 * costs a paid API call to answer nothing.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Liveness probe.
fastify.get('/health', async () => ({ status: 'ok' }));

// Readiness probe. Provider credentials are reported for observability but do
// not gate readiness — the service still serves probes and non-LLM routes
// without them.
fastify.get('/ready', async () => ({
  ready: true,
  providers: configuredProviders(),
  // Publishing is optional like the providers: reported for observability,
  // never a readiness gate.
  youtube: isYouTubeConfigured() ? 'configured' : 'not configured',
  auth: isAuthConfigured() ? 'configured' : 'not configured',
}));

// Generate a video script with the selected LLM provider.
fastify.post('/api/generate/script', async (request, reply) => {
  const { topic, provider } = (request.body ?? {}) as Partial<ScriptRequest>;

  if (!isNonEmptyString(topic) || !provider) {
    return reply.status(400).send({ error: 'Missing topic or provider' });
  }
  if (!isProvider(provider)) {
    return reply.status(400).send({ error: `Unsupported provider: ${provider}` });
  }

  try {
    const script = await generateScript(topic, provider);
    return { script };
  } catch (error) {
    request.log.error(error);
    if (error instanceof ProviderNotConfiguredError) {
      return reply.status(503).send({ error: error.message });
    }
    return reply.status(502).send({ error: 'Script generation failed' });
  }
});

// Generate a video from a script (placeholder for the video-generation API).
fastify.post('/api/generate/video', async (request, reply) => {
  const { script } = (request.body ?? {}) as Partial<VideoRequest>;

  if (!isNonEmptyString(script)) {
    return reply.status(400).send({ error: 'Missing script' });
  }

  request.log.info('Triggering video generation with script payload');
  await new Promise((resolve) => setTimeout(resolve, 2000));

  return {
    status: 'success',
    videoUrl: 'https://storage.example.com/generated_output.mp4',
  };
});

// Publish a rendered video file to YouTube.
fastify.post('/api/publish/youtube', async (request, reply) => {
  const { filePath, title, description } = (request.body ?? {}) as Partial<PublishRequest>;

  if (!isNonEmptyString(filePath) || !isNonEmptyString(title)) {
    return reply.status(400).send({ error: 'Missing filePath or title' });
  }

  try {
    const videoId = await uploadToYouTube(filePath, title, description ?? '');
    return { videoId, url: `https://youtu.be/${videoId}` };
  } catch (error) {
    request.log.error(error);
    // Distinguish "not configured", "bad request", "quota", and "credentials
    // revoked" — they need different responses from whoever is on call.
    const { status, message } = classifyYouTubeError(error);
    return reply.status(status).send({ error: message });
  }
});

const start = async () => {
  try {
    // Surface an unconfigured publishing path once at boot rather than only on
    // the first upload attempt.
    if (!isAuthConfigured()) {
      fastify.log.warn(
        'SERVER_AUTH_SECRET not set; /api/* will answer 503 (paid and publishing routes stay closed)',
      );
    }

    const missingYouTube = missingYouTubeConfig();
    if (missingYouTube.length > 0) {
      fastify.log.warn(
        { missing: missingYouTube },
        'YouTube publishing is not configured; /api/publish/youtube will answer 503',
      );
    }

    const port = parseInt(process.env.PORT ?? '3000', 10);
    await fastify.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    await shutdownTelemetry();
    process.exit(1);
  }
};

// How long to let in-flight work finish before exiting anyway. Keep this below
// the pod's terminationGracePeriodSeconds so we exit on our own terms rather
// than being SIGKILLed.
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 10_000);

// Drain in-flight requests, then flush telemetry, on k8s pod stop.
//
// The drain is bounded: `fastify.close()` waits for open connections to go
// idle, and a client that never reads its response body keeps one active
// indefinitely. Without a deadline a single such client would hold the pod open
// until the kubelet SIGKILLed it, stalling every rolling update.
const shutdown = async (signal: string) => {
  fastify.log.info(`${signal} received; shutting down`);

  const forceExit = setTimeout(() => {
    fastify.log.warn(
      { graceMs: SHUTDOWN_GRACE_MS },
      'grace period elapsed with connections still open; exiting anyway',
    );
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  // Do not let the timer itself keep the event loop alive.
  forceExit.unref();

  try {
    await fastify.close();
  } finally {
    clearTimeout(forceExit);
    await shutdownTelemetry();
    process.exit(0);
  }
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

void start();
