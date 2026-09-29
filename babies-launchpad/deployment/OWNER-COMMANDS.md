# Owner commands (kept in the repository because scripts under /tmp disappear)

macOS deletes files under `/tmp` that have not been touched for a few days (the nightly `tmp_cleaner`). On
28 September 2026 it removed the checkout's git configuration, the kids.fun deploy link
(`/tmp/kids-vercel-deployment/.vercel/project.json`) and the release scripts `/tmp/kids-push-release.sh` and
`/tmp/kids-vercel-deploy-now.sh`. Everything below is the durable copy. Run each block from a terminal on the Mac.

## A. Move the checkouts out of /tmp (once)

Stops nothing; the local validators and the rehearsal database keep working through the links left behind.

```
mkdir -p ~/Documents/kids
mv /tmp/kids-fresh-repo ~/Documents/kids/kids-fresh-repo && ln -s ~/Documents/kids/kids-fresh-repo /tmp/kids-fresh-repo
mv /tmp/kids-public-integration ~/Documents/kids/kids-public-integration && ln -s ~/Documents/kids/kids-public-integration /tmp/kids-public-integration
mv /tmp/kids-public-pg-a1 ~/Documents/kids/kids-public-pg-a1 && ln -s ~/Documents/kids/kids-public-pg-a1 /tmp/kids-public-pg-a1
git -C ~/Documents/kids/kids-fresh-repo worktree repair ~/Documents/kids/kids-public-integration
git -C ~/Documents/kids/kids-public-integration status -sb | head -1
```

The last line must print `## feature/public-launches...origin/feature/public-launches`. Also copy your scripts:
`mkdir -p ~/Documents/kids/bin && cp /tmp/kids-*.sh ~/Documents/kids/bin/`.

## B. kids.fun (the existing coin's site): rebuild the deploy folder and re-link it (once)

```
cd /tmp/kids-fresh-repo/babies-launchpad/interaction-review
rm -rf /tmp/kids-vercel-deployment/.vercel/output && node deployment/prepare.mjs /tmp/kids-vercel-deployment
cd /tmp/kids-vercel-deployment && NODE_USE_ENV_PROXY=1 npx --yes vercel@latest link --yes --project kids-fun --scope trenchfun1 && rm -f .env.local
grep projectName .vercel/project.json
```

The last line must say `kids-fun`. A deploy of the site is then:

```
cd /tmp/kids-vercel-deployment && NODE_USE_ENV_PROXY=1 npx --yes vercel@latest deploy --prebuilt --prod --yes --scope trenchfun1
curl -s https://kids.fun/ | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1
```

The printed bundle name must match the one in `/tmp/kids-vercel-deployment/.vercel/output`.

## C. Release the existing coin's services (main to the `release` branch; Railway deploys it)

```
cd /tmp/kids-fresh-repo
export GH_TOKEN=$(gh auth token -u piczocom)
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main:release
```

## D. The public-launch pilot

The ordered steps, what each needs and what "done" looks like are in `deployment/hosted/PILOT-RUNBOOK.md`
(section "The owner's steps, in order"). The commands, all in this repository:

The upgrade script is pinned to the build it deploys; run it again whenever the runbook's step 2 names a new build
(28 September, afternoon: build `ec8f9951…`, the one-transaction creation).

```
KIDS_HELIUS_RPC_URL=<url> zsh babies-launchpad/deployment/hosted/pilot-upgrade-v3.sh --check-only
KIDS_HELIUS_RPC_URL=<url> zsh babies-launchpad/deployment/hosted/pilot-upgrade-v3.sh
zsh babies-launchpad/deployment/hosted/pilot-railway.sh
zsh babies-launchpad/deployment/hosted/pilot-ui.sh
zsh babies-launchpad/deployment/hosted/pilot-operator.sh <status|grant-keeper|schedule|grant-refund|grant-return> --campaign <address>
zsh babies-launchpad/deployment/hosted/pilot-registry-drill.sh
```
