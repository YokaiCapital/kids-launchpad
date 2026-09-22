FROM node:24-trixie-slim
ARG AGAVE_VERSION=v3.0.13
ARG AGAVE_LINUX_SHA256=5dfd42a8f4a2c6319c4dcf4790582aa28573825fe1cb8475c70e497ffa0aabd6
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 libssl3t64 libudev1 tini util-linux && rm -rf /var/lib/apt/lists/*
RUN test ${#AGAVE_LINUX_SHA256} -eq 64 && curl --fail --location --retry 3 "https://github.com/anza-xyz/agave/releases/download/${AGAVE_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" -o /tmp/agave.tar.bz2 && echo "${AGAVE_LINUX_SHA256}  /tmp/agave.tar.bz2" | sha256sum -c - && tar -xjf /tmp/agave.tar.bz2 -C /opt && rm /tmp/agave.tar.bz2
ENV SOLANA_BIN=/opt/solana-release/bin PATH=/opt/solana-release/bin:$PATH NODE_ENV=production RAYON_NUM_THREADS=2
WORKDIR /app/babies-launchpad
COPY babies-launchpad/localnet/package*.json ./localnet/
RUN cd localnet && npm ci --omit=dev --ignore-scripts
COPY babies-launchpad ./
RUN cd interaction-review && npm ci --omit=dev --ignore-scripts && ./node_modules/.bin/vite build
# The program binary's expected hash: the reviewed classic binary by default; a service may pin the CI reproducible
# hash of a newer build through the KIDS_PROGRAM_SHA256 build variable (Railway passes service variables as build args).
ARG KIDS_PROGRAM_SHA256=ef584ae7555415215b8cda0597cfff8362a7ecdbb31fdc07aa747c3f63368923
ENV KIDS_PROGRAM_SHA256=${KIDS_PROGRAM_SHA256}
COPY deployment-artifacts/kids_atomic_launch.so /opt/kids/kids_atomic_launch.so
RUN test ${#KIDS_PROGRAM_SHA256} -eq 64 && echo "${KIDS_PROGRAM_SHA256}  /opt/kids/kids_atomic_launch.so" | sha256sum -c -
RUN mkdir -p /data && chmod 700 /data && rm -rf localnet/.runtime protocol/.runtime && ln -s /data/localnet localnet/.runtime && ln -s /data/protocol protocol/.runtime
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","deployment/railway/supervisor.mjs"]
