FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3777 \
    CONFIG_PATH=/app/bridge/config.json
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY bridge/server ./bridge/server
COPY bridge/shared ./bridge/shared
RUN mkdir -p /app/bridge && chmod -R a-w /app/bridge

USER node
EXPOSE 3777
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3777)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bridge/server/index.js"]
