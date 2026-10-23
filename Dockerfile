# minicrawl: Firecrawl-style scraping API.
# Node 24 (for node:sqlite) on Debian 13 trixie (glibc 2.41: light-ocr needs 2.38+, and
# the canvas build needs glibc too), with Playwright's Chromium.
# Works on linux/amd64 and linux/arm64.
FROM node:25-trixie-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOST=0.0.0.0 \
    PORT=3002 \
    DB_PATH=/data/minicrawl.db \
    REQUIRE_API_KEY=true

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

COPY src ./src
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3002
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
