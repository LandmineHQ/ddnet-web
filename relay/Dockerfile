# 中继后端（Node.js ESM；依赖 ws + node-datachannel）
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY bin ./bin
COPY relay.config.json ./relay.config.json
# The repository may be checked out with restrictive umasks; the unprivileged
# runtime user must still be able to read the sources and config.
RUN chmod -R a+rX /app
USER node
EXPOSE 8390
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8390)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bin/relay.mjs"]
