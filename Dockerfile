# KIDS API for a real network (devnet or mainnet): the account API, keepers and the authenticated gateway.
# No validator, no program binary, no keys in the image. State lives on the /data volume (journals, sqlite, backups).
FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini util-linux postgresql-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app/babies-launchpad
COPY babies-launchpad/localnet/package*.json ./localnet/
RUN cd localnet && npm ci --omit=dev --ignore-scripts
COPY babies-launchpad ./
RUN npm --prefix localnet run harden && node --test localnet/security/dependencies.test.mjs
# One dependency tree for the whole application: server modules outside localnet (interaction-review/server, staging,
# deployment, shared) resolve their packages through this link, so the hardened localnet tree is the only one in the image.
RUN rm -rf node_modules interaction-review/node_modules && ln -s /app/babies-launchpad/localnet/node_modules /app/babies-launchpad/node_modules
RUN mkdir -p /data && chmod 700 /data && rm -rf localnet/.runtime protocol/.runtime && ln -s /data/localnet localnet/.runtime && ln -s /data/protocol protocol/.runtime
ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","deployment/mainnet/supervisor.mjs"]
