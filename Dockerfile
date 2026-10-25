FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN pnpm build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3400 DATABASE_PATH=/app/data/market.sqlite
RUN npm install -g pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile && mkdir /app/data && chown node:node /app/data
COPY --from=build /app/dist ./dist
COPY server ./server
USER node
EXPOSE 3400
CMD ["node", "server/index.mjs"]
