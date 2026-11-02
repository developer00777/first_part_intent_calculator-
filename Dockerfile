# First-Party Intent Calculator: Node API + static frontend in one image.
# Cloudflare Containers requires linux/amd64; wrangler builds for that platform automatically.

FROM node:22-alpine AS deps
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    SKILL_DIR=/app/skill \
    NODE_OPTIONS=--max-old-space-size=3072
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY app/package.json ./
COPY app/src ./src
COPY app/config ./config
COPY app/public ./public
COPY skill ./skill
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "src/server.js"]
