"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Telemetry must be imported first so auto-instrumentation patches modules
// (http, etc.) before Fastify and the SDKs require them.
const telemetry_1 = require("./telemetry");
const fastify_1 = __importDefault(require("fastify"));
const providers_1 = require("./providers");
const youtube_1 = require("./youtube");
const fastify = (0, fastify_1.default)({ logger: true });
// Liveness probe.
fastify.get('/health', async () => ({ status: 'ok' }));
// Readiness probe.
fastify.get('/ready', async () => ({ ready: true }));
// Generate a video script with the selected LLM provider.
fastify.post('/api/generate/script', async (request, reply) => {
    const { topic, provider } = (request.body ?? {});
    if (!topic || !provider) {
        return reply.status(400).send({ error: 'Missing topic or provider' });
    }
    if (!(0, providers_1.isProvider)(provider)) {
        return reply.status(400).send({ error: `Unsupported provider: ${provider}` });
    }
    try {
        const script = await (0, providers_1.generateScript)(topic, provider);
        return { script };
    }
    catch (error) {
        request.log.error(error);
        return reply.status(502).send({ error: 'Script generation failed' });
    }
});
// Generate a video from a script (placeholder for the video-generation API).
fastify.post('/api/generate/video', async (request, reply) => {
    const { script } = (request.body ?? {});
    if (!script) {
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
    const { filePath, title, description } = (request.body ?? {});
    if (!filePath || !title) {
        return reply.status(400).send({ error: 'Missing filePath or title' });
    }
    try {
        const videoId = await (0, youtube_1.uploadToYouTube)(filePath, title, description ?? '');
        return { videoId, url: `https://youtu.be/${videoId}` };
    }
    catch (error) {
        request.log.error(error);
        return reply.status(502).send({ error: 'YouTube upload failed' });
    }
});
const start = async () => {
    try {
        const port = parseInt(process.env.PORT ?? '3000', 10);
        await fastify.listen({ port, host: '0.0.0.0' });
    }
    catch (err) {
        fastify.log.error(err);
        await (0, telemetry_1.shutdownTelemetry)();
        process.exit(1);
    }
};
// Drain in-flight requests, then flush telemetry, on k8s pod stop.
const shutdown = async (signal) => {
    fastify.log.info(`${signal} received; shutting down`);
    try {
        await fastify.close();
    }
    finally {
        await (0, telemetry_1.shutdownTelemetry)();
        process.exit(0);
    }
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
void start();
