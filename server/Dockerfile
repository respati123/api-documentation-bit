FROM oven/bun:1-slim

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY index.ts schema.sql ./

ENV PORT=3001
EXPOSE 3001

USER bun
CMD ["bun", "run", "index.ts"]
