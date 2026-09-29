#!/bin/zsh
# Owner command: backup and restore drill of the pilot database. The database has no public address, so the drill runs
# inside the platform, on the accounting worker's container: one consistent pg_dump over the private network, a restore
# into a NEW throwaway database on the same server (never inside the live database), a comparison of every table, the
# schema check, then the throwaway database is dropped and the report printed. Add --keep-archive to keep the dump in
# the container's private temp folder named in the report (it vanishes with the container).
set -e
PROJECT=6f623b65-d0e5-4416-acb0-61d4e3507ac9
railway ssh -p "$PROJECT" -e production --service kids-worker-accounting -- node localnet/hosted/registry-drill.mjs "$@"
