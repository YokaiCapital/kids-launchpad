# Launch day runbook (Shartcoin on mainnet)

Built for a first launch of about 1,000 active users (owner decision, 23 September 2026). Every step is either a
command the owner runs or a check that prints its result. Nothing here moves funds except the campaign creation
(operator wallet pays rent, about 0.35 SOL) and the participants' own commitments.

## The day before

0. **Coin name and artwork.** The plan carries the branding: plan with `--name Shartcoin --symbol SHART --description '…'
   --image interaction-review/public/assets/shart-pfp.png`. Without these flags the plan carries the TEST coin (name
   "KIDS test coin", grey test image), so a test launch never shows the real artwork. The kids-api service needs
   `KIDS_PINATA_JWT` (the Pinata token, same provider as Pairz; set it in the Railway dashboard, never in source): at
   boot the image and the metadata document are pinned and the coin's Metaplex metadata is created, immutable, in the
   same transaction that mints the supply. Without the variable a real-network boot refuses to create the coin.
1. **Terms and date.** Set `opensAt` (ISO 8601, UTC), `soft`, `hard` and `deadlineSeconds` in
   `deployment/mainnet/launch-schedule.json`; the same terms go into `deployment/mainnet/campaign-plan.json`
   (`terms`). If the terms changed since the plan was made, plan again with
   `KIDS_NETWORK=mainnet node localnet/plan-network-campaign.mjs --soft-sol … --hard-sol … --hours …` and take a
   fresh snapshot for the new campaign address (`snapshot-parents-mainnet.mjs`); a plan with evidence is never reused
   for different terms.
2. **Upload the API with the schedule** (no plan file in the folder): `/tmp/kids-mainnet-upload-service.sh`. kids.fun
   then shows "Shartcoin opens <date>" with the countdown and the greyed commit box.
3. **Operator balance.** `AAuwkFNvXRimHyvdQfh7Zik9baw8W2ufSbc5cyBqsdoE` needs at least 1 SOL for the campaign
   creation and the keepers' fees on launch day.
4. **Backups on.** Railway dashboard, project kids-mainnet, the volume, Backups: daily. Confirm one backup exists.
5. **Wallet check.** Commit 0.01 SOL from a real wallet on the test ledger is not possible any more (kids.fun is on
   mainnet); instead verify sign-in, balances and the greyed commit box on kids.fun with a real wallet.

## Opening (T minus 15 minutes)

6. **Create the campaign.** Copy `deployment/mainnet/campaign-plan.json` into the upload folder and run
   `/tmp/kids-mainnet-upload-service.sh`. At boot the service creates the coin mint and the escrow and configures the
   parents from the snapshot roots; the 24-hour (or configured) clock starts at that moment, so time the upload so the
   boot finishes at the announced opening. The upload takes 4 to 6 minutes.
7. **Verify.** `node /tmp/kids-mainnet-state.mjs` prints `configured:true, phase:open` with the deadline. On kids.fun
   the status card says "Open for commitments" with the countdown, the commit box is live, the coin and escrow
   addresses show with explorer links.
8. **Announce** the kids.fun link and the password, or remove the password gate (owner decision).

## During the campaign

- The keepers settle, launch, collect fees, split and buy back by themselves. Watch
  `node /tmp/kids-mainnet-state.mjs` and the coin page. The API refuses money operations by itself while the RPC is
  down and reopens when it answers again.
- Do not restart the service unless it is stuck; a restart takes 4 to 6 minutes of downtime.

## After the deadline

- Soft cap met: the launch runs within a minute; the coin page shows the pool, claims and trading.
- Soft cap missed: refunds are open on the launch page; nothing else to do.

## Rollback

- A broken site build: redeploy the previous bundle with `/tmp/kids-vercel-deploy-now.sh` after re-preparing it.
- A broken API build: re-upload the previous folder contents; the volume keeps the journals and the campaign.
- Never delete the volume or the journals; never re-create a campaign that already has commitments.
