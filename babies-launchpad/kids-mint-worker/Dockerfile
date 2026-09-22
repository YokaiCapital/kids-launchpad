FROM node:24-bookworm-slim
WORKDIR /compute
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY vendor ./vendor
COPY worker.mjs PROVENANCE.md ./
CMD ["node", "worker.mjs"]
