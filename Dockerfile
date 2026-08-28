FROM node:20-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app
COPY . .

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build core and server
RUN pnpm --filter @syncpad/egwalker-core build
RUN pnpm --filter @syncpad/server build

# Production image
FROM node:20-slim
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy built assets and package files
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/egwalker-core/package.json ./packages/egwalker-core/
COPY --from=builder /app/packages/egwalker-core/dist ./packages/egwalker-core/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/
COPY --from=builder /app/packages/server/dist ./packages/server/dist

# Install only production dependencies
RUN pnpm install --frozen-lockfile --prod

# Expose port (Cloud Run uses PORT env var, typically 8080)
EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production

# Start server
CMD ["node", "packages/server/dist/index.js"]
