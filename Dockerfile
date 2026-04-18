FROM node:20-alpine AS builder
WORKDIR /build
COPY package*.json ./
RUN npm install --include=dev
COPY tsconfig.json ./
COPY src/ ./src/
COPY CHANGELOG.md ./
RUN npm run build

FROM node:20-alpine AS production
LABEL org.opencontainers.image.vendor="Alterspective"
LABEL org.opencontainers.image.title="deploy-validation-poc"

RUN addgroup -g 1001 -S appuser && adduser -u 1001 -S appuser -G appuser
WORKDIR /app
COPY --chown=appuser:appuser package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder --chown=appuser:appuser /build/dist ./dist
COPY --from=builder --chown=appuser:appuser /build/CHANGELOG.md ./CHANGELOG.md

# Build metadata (VER-BUILD-01, VER-CI-05)
# Coolify injects COOLIFY_* args automatically. For the SHA we read from
# package.json version at runtime; Coolify provides the commit in its env.
ENV APP_VERSION="" \
    APP_BUILD_SHA="" \
    APP_BUILD_DATE="" \
    NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1
EXPOSE 3000
USER appuser
CMD ["node", "dist/index.js"]
