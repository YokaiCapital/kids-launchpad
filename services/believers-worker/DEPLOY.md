# Believers worker on Railway (owner steps, once)

Project kids-mainnet, "New service", Source: this repository, branch `release`, Root Directory `services/believers-worker`.
Settings: Cron Schedule `*/30 * * * *` (one run every 30 minutes, the container exits when done); Volume mounted at `/data`.
Variables (set them yourself, never paste them anywhere else): `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`,
`X_ACCESS_TOKEN_SECRET`, `KIDS_API_URL` (the kids-api public domain), `KIDS_COMMUNITY_TOKEN` (same value as on kids-api),
`WATCH_POSTS`, `ASK_POSTS`, `OWNER_ID`, optional `PINNED_WALLET_POST`, optional `BLOCKLIST`.
The worker holds no KIDS keys and no RPC credential. It reads X, classifies, and publishes the two files to the API.
On the first run the volume is seeded from `seed/` (since dates preserved). Each run costs about 15 to 30 X API calls.
