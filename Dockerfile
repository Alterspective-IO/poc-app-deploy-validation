FROM node:20-alpine AS builder
# Install git for build metadata extraction (VER-BUILD-01)
RUN apk add --no-cache git
WORKDIR /build
COPY .git ./.git
COPY package*.json ./
RUN npm install --include=dev
COPY tsconfig.json ./
COPY src/ ./src/
COPY CHANGELOG.md ./
RUN npm run build

# Extract build metadata from git (VER-CI-05)
RUN echo "$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')" > /tmp/build-sha \
    && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/build-date \
    && echo "$(node -p \"require('./package.json').version\")" > /tmp/build-version

FROM node:20-alpine AS production
LABEL org.opencontainers.image.vendor="Alterspective"
LABEL org.opencontainers.image.title="deploy-validation-poc"

RUN addgroup -g 1001 -S appuser && adduser -u 1001 -S appuser -G appuser
WORKDIR /app
COPY --chown=appuser:appuser package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder --chown=appuser:appuser /build/dist ./dist
COPY --from=builder --chown=appuser:appuser /build/CHANGELOG.md ./CHANGELOG.md

# Inject build metadata as env vars (VER-BUILD-01)
COPY --from=builder /tmp/build-sha /tmp/build-date /tmp/build-version /tmp/
RUN export APP_BUILD_SHA=$(cat /tmp/build-sha) \
    && export APP_BUILD_DATE=$(cat /tmp/build-date) \
    && export APP_VERSION=$(cat /tmp/build-version) \
    && echo "APP_BUILD_SHA=$APP_BUILD_SHA" >> /etc/environment \
    && echo "APP_BUILD_DATE=$APP_BUILD_DATE" >> /etc/environment \
    && echo "APP_VERSION=$APP_VERSION" >> /etc/environment \
    && rm /tmp/build-sha /tmp/build-date /tmp/build-version

# Set env vars from the captured build metadata
ENV APP_BUILD_SHA="" APP_BUILD_DATE="" APP_VERSION=""
# Use a startup script to load from /etc/environment
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1
EXPOSE 3000
USER appuser
CMD ["sh", "-c", ". /etc/environment && exec node dist/index.js"]
