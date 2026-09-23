# KIDS community worker (believers refresh)

Runs every 30 minutes on Railway (cron `*/30 * * * *`). Pulls new likes, retweets, replies and quotes on the
watched X posts, classifies replies and quotes as supportive with a rules pass, merges into the supporters
envelope, collects wallet proofs from the pinned post, and pushes both files to the KIDS API.

## Environment variables (no files, no keys in the image)

| Variable | Purpose |
|---|---|
| X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET | OAuth 1.0a user context of @YokaiCapital (read + write + DM) |
| WATCH_POSTS | comma-separated post ids to watch, e.g. `2101747601494147202,2102035724178448627` |
| ASK_POSTS | subset of WATCH_POSTS whose likes count as support (the "ask" posts) |
| PINNED_WALLET_POST | post id of the pinned wallet-proof post (optional until it exists) |
| OWNER_ID | X user id of the owner account (1851449314163273728) |
| KIDS_API_URL | base URL of the KIDS API, e.g. `https://api.kids.fun` |
| KIDS_COMMUNITY_TOKEN | sent as header `x-kids-community-token` on POST /api/community/supporters and /supporter-wallets (32+ chars, set on the API service too) |
| WORK_DIR | state directory, default `/data` (attach a volume for audit copies) |

## Outputs

- `supporters.json`: `{generatedAt, entries:[{xId, username, name, followers, how:[...], since}]}`
- `supporter-wallets.json`: `{generatedAt, entries:[{xId, wallet, provedAt, tweetUrl}]}`
- `state.json`: seen post ids per source, so a run only fetches what is new
- `run.log`: one line per run with counts and API response codes

`since` is first-seen and never changes. A wallet proof is accepted only from the supporter's own account,
exactly one base58 address of 32 to 44 chars in the reply, on the ed25519 curve (a wallet key, not a program
address), first valid reply wins.

## Credits

Each run costs X API credits: about 5 to 30 read calls depending on new activity. The worker never
sends DMs, never posts, never follows.
