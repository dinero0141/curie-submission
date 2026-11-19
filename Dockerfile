# One image for the api, worker and migrate services (different commands, see docker-compose.yml).
FROM node:22-bookworm-slim AS base
# pnpm pinned to the version that wrote pnpm-lock.yaml (npm instead of corepack: no signature-key drift).
RUN npm install -g pnpm@12.21.0 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/api.js"]
