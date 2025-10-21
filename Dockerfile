FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Enable corepack for pnpm/yarn support
RUN corepack enable

COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* bun.lockb* ./

RUN \
  if [ -f yarn.lock ]; then \
    yarn --frozen-lockfile; \
  elif [ -f package-lock.json ]; then \
    npm ci; \
  elif [ -f pnpm-lock.yaml ]; then \
    pnpm i --frozen-lockfile; \
  else \
    echo "No lockfile found." && exit 1; \
  fi

FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Enable corepack for the builder stage too
RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

RUN \
  if [ -f yarn.lock ]; then \
    yarn build; \
  elif [ -f package-lock.json ]; then \
    npm run build; \
  elif [ -f pnpm-lock.yaml ]; then \
    pnpm run build; \
  else \
    npm run build; \
  fi

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

RUN mkdir .next
RUN chown nextjs:nodejs .next

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3535

ENV PORT=3535
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]