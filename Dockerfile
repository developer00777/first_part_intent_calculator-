# First-Party Intent Calculator: Node API + static frontend + the skill's Python scripts, in one image.
# Cloudflare Containers requires linux/amd64; wrangler builds for that platform automatically.

FROM node:22-bookworm-slim AS node

FROM node AS deps
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM python:3.12-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY app/py/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
 && useradd --create-home --uid 10001 app
ENV NODE_ENV=production \
    PORT=8080 \
    PYTHON=python3 \
    PYTHONDONTWRITEBYTECODE=1 \
    SKILL_DIR=/app/skills/first-party-intent-calculator \
    NODE_OPTIONS=--max-old-space-size=1536
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY app/package.json ./
COPY app/src ./src
COPY app/py ./py
COPY app/public ./public
COPY skills ./skills
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
