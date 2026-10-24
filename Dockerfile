# App Node: server web + API + WebSocket. Postgres e Ollama girano come servizi
# separati in docker-compose.yml.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --include=optional && npm cache clean --force

COPY src ./src
COPY public ./public
COPY templates ./templates
COPY samples ./samples
COPY scripts ./scripts

# Non-root user; data dir only used if DATABASE_URL is empty (embedded PGlite).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
