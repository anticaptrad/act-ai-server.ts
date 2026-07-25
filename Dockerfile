# Multi-stage build for the act-ai-server Node/TypeScript service.
FROM node:22-bookworm-slim AS builder
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production dependencies for the runtime image.
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /usr/src/app

# node:*-slim ships an unprivileged `node` user.
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist
COPY package.json ./
USER node

ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
