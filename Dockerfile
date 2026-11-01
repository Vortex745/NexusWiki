# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:${PATH}"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv
COPY docker/requirements.txt /tmp/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r /tmp/requirements.txt

FROM base AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.web.json vite.config.ts ./
COPY src ./src
COPY frontend ./frontend
COPY scripts/copy-docreader-proto.cjs ./scripts/copy-docreader-proto.cjs
RUN npm run build && npm run build:web
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM nginx:1.28-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/frontend /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

FROM base AS backend
ENV NODE_ENV=production \
    API_PORT=3001 \
    PYTHON_COMMAND=/opt/venv/bin/python \
    MARKITDOWN_COMMAND=/opt/venv/bin/markitdown \
    ENV_FILE=/app/data/model-settings.env \
    DOTENV_CONFIG_PATH=/app/data/model-settings.env \
    DOTENV_CONFIG_OVERRIDE=true
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts/builtin_pdf_extract.py scripts/builtin_pdf_preview.py ./scripts/
RUN mkdir -p /app/data /app/logs && chown node:node /app/data /app/logs
USER node
EXPOSE 3001
# The public auth-config route is local-only work; /api/status probes providers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.API_PORT+'/api/auth/config',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
