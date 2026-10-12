#!/bin/sh
#
# Prepares the store, then hands over to the app.
#
# ===========================================================================
# WHY THIS EXISTS: THE DEMO MUST BE COPIED, NOT MOUNTED IN PLACE
# ===========================================================================
#
# THE APP CANNOT OPEN A READ-ONLY STORE, which was measured rather than assumed. Every
# connection runs `prepareDatabase`, which sets `PRAGMA busy_timeout` and applies the
# schema; both are WRITES, so a `:ro` mount fails with "attempt to write a readonly
# database" on the first read of an organisation. SQLite in WAL mode also creates `-wal`
# and `-shm` sidecars beside the database merely by opening it.
#
# SO THE COMMITTED ARTEFACT IS THE SOURCE AND THE VOLUME IS THE WORKING COPY:
#
#   /app/data/demo   mounted READ-ONLY from the repository - the committed artefact
#   /data/store      a writable named volume - what the app actually opens
#
# THE VOLUME IS NOT UNDER /app, deliberately: the app reads its schema from
# `/app/data/store/schema.sql`, so a volume there hides it and every connection fails.
#
# The copy runs once, when the store is empty. It does NOT run on every start, which
# matters: re-copying would silently discard anything written since, so a container that
# was used would lose it on the next restart.
#
# THE ARTEFACT IS NEVER WRITTEN TO. The mount is read-only, and this script only ever
# reads from it. `data/demo` in the repository is therefore unchanged by a compose run -
# which is the integrity requirement, because the file is committed and its organisation
# id is pinned in the compose file.
set -eu

STORE="${STORE_DIR:-/data/store}"
SEED_SOURCE="${DEMO_SOURCE_DIR:-/app/data/demo}"

echo "[entrypoint] store:      ${STORE}"
echo "[entrypoint] demo source: ${SEED_SOURCE}"

mkdir -p "${STORE}/orgs"

# Copy only when there is nothing there. A store with any organisation file is a store
# somebody has used, and overwriting it would be data loss dressed up as a seed step.
if [ -z "$(ls -A "${STORE}/orgs" 2>/dev/null)" ]; then
    if [ -d "${SEED_SOURCE}/orgs" ]; then
        echo "[entrypoint] the store is empty; seeding it from the committed demo"
        cp -a "${SEED_SOURCE}/." "${STORE}/"
        echo "[entrypoint] seeded: $(ls "${STORE}/orgs" | tr '\n' ' ')"
    else
        echo "[entrypoint] the store is empty and no demo source is mounted at ${SEED_SOURCE};"
        echo "[entrypoint] starting with an empty store. Sign in at /admin to create an"
        echo "[entrypoint] organisation, or mount a seeded one."
    fi
else
    echo "[entrypoint] the store already holds $(ls "${STORE}/orgs" | wc -l) organisation(s); leaving it alone"
fi

# `exec` so node replaces this shell and RECEIVES SIGTERM DIRECTLY. Without it the signal
# goes to the shell, node never sees it, and `docker compose stop` waits out its timeout
# before SIGKILLing - skipping the store's clean shutdown and leaving a WAL behind.
exec "$@"
