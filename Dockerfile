# syntax=docker/dockerfile:1
# Imagen fijada por digest para build reproducible.
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./

# --omit=dev evita dependencias de desarrollo; se limpia la caché en la misma capa.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server/ ./server/
COPY --chown=node:node shared/ ./shared/

# Usuario no root: reduce superficie de ataque en runtime.
USER node

EXPOSE 3000

# SIGTERM debe llegar a Node como PID 1 para cierre ordenado (sin wrappers de shell).
STOPSIGNAL SIGTERM

# HEALTHCHECK omitido a propósito: ADR-012 reserva /api/health/live para el target group del ALB.
CMD ["node", "server/index.js"]
