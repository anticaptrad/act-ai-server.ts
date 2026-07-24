"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const fastify = (0, fastify_1.default)({ logger: true });
// Basic health check route
fastify.get('/health', async (request, reply) => {
    return { status: 'OK' };
});
const start = async () => {
    try {
        const port = parseInt(process.env.PORT || '3005', 10);
        await fastify.listen({ port, host: '0.0.0.0' });
        fastify.log.info(`AI Server running on port ${port}`);
    }
    catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
start();
