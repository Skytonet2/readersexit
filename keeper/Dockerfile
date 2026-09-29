# Build context is the repo root (the keeper imports ../shared).
FROM node:22-slim
WORKDIR /app
COPY keeper/package.json keeper/package-lock.json ./keeper/
RUN npm ci --prefix keeper
COPY shared ./shared
COPY keeper/tsconfig.json ./keeper/
COPY keeper/src ./keeper/src
WORKDIR /app/keeper
# ROLE=keeper (default) or ROLE=indexer; see src/main.ts.
CMD ["npx", "tsx", "src/main.ts"]
