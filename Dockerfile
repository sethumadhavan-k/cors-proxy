# syntax=docker/dockerfile:1

# ---- Dependencies ----
FROM node:20-alpine AS deps
ENV NODE_ENV=production
WORKDIR /app

# Only copy manifests for efficient caching
COPY package.json package-lock.json ./

# Install only production deps
RUN npm ci --omit=dev

# ---- Runner ----
FROM node:20-alpine AS runner
ENV NODE_ENV=production \
    PORT=80
WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy app sources
COPY src ./src
COPY public ./public
COPY package.json ./package.json

EXPOSE 80

# Run as non-root user for security
USER node

CMD ["node", "src/server.js"]


