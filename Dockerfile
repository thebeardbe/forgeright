# forgeright, in a container.
#
# RUN IT WITH COMPOSE, not `docker build` and `docker run` by hand: compose supplies the
# environment the app needs (the session secret, the bind address, the demo variables) and
# mounts the store as a volume so data outlives the container. See docker-compose.yml.
#
# ---------------------------------------------------------------------------
# WHY THIS BASE IMAGE, AND WHY PINNED TO A DIGEST
# ---------------------------------------------------------------------------
#
# `node:24-slim` BY DIGEST, not by tag and never `latest`. A tag is a moving reference: the
# same Dockerfile builds a different image next month, so a build that worked can stop
# working with no change to this repository, and two people building the same commit get
# different results. The digest names one immutable image, which is what makes a build
# reproducible and what makes "it worked on my machine" answerable.
#
# `slim` RATHER THAN THE DEFAULT VARIANT: the full image carries a C toolchain and the
# build headers, none of which this app needs. `node:sqlite` is BUILT IN to Node 24, so no
# native module is compiled at install time and the toolchain is dead weight that widens
# the attack surface.
#
# NODE 24 RATHER THAN THE `engines` MINIMUM OF 20: `node:sqlite` is what the store uses,
# and it is only available from Node 22 onward. Pinning to the major version the code is
# developed and tested against is what keeps the container from being a different runtime
# in a way nobody checks.
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

# ---------------------------------------------------------------------------
# WHAT IS COPYABLE, AND WHAT MUST NEVER BE
# ---------------------------------------------------------------------------
#
# `package.json` AND THE LOCK FILE FIRST, then `npm ci`, then the source. Copying the
# source after the install means a code change does not invalidate the dependency layer,
# so a rebuild is seconds rather than a full reinstall.
#
# `--omit=dev` IS THE STANDARD PRODUCTION SHAPE, and it now has nothing special to exclude:
# `puppeteer` and `marked` were removed from `package.json` before this image was built,
# because production code never imported either and puppeteer alone would have pulled
# roughly 300MB of Chromium into an image that can never use it. The flag stays because
# omitting dev dependencies is what a production install should do regardless of whether
# there happen to be any.
#
# THE DEPENDENCY SET IS THREE PACKAGES: express, ejs and dotenv. `node:sqlite` is built into
# Node 24, so there is no native module to compile and no toolchain in this image.
#
# `.dockerignore` EXCLUDES `.env` AND `data/store`. That is the security boundary of this
# build: a `.env` copied into an image is a credential baked into a layer, where it stays
# readable to anyone who can pull the image and survives deleting the file on top of it.
# The app reads `.env` at RUNTIME from the mounted working directory, so the image never
# needs one. `data/demo` IS copied, because it is the committed demo artefact and the whole
# point of this container is to serve it.
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY ai/ ./ai/
COPY config/ ./config/
COPY data/ ./data/
COPY lib/ ./lib/
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY views/ ./views/
COPY server.js ./
COPY docker-entrypoint.sh ./

# The entrypoint seeds the store from the read-only demo mount, then execs the app. It has
# to be executable in the image, and `git` records the mode but a COPY from a host with
# different permissions does not always carry it.
RUN chmod +x /app/docker-entrypoint.sh

# ---------------------------------------------------------------------------
# NON-ROOT
# ---------------------------------------------------------------------------
#
# THE `node` USER SHIPS WITH THIS IMAGE and is uid 1000, the same as the usual first
# desktop user. Running as root would mean a process that can rewrite its own image layer
# contents and any mounted volume, and it is the single cheapest container hardening step
# there is. `--chown` on the copies is not needed because everything above is read-only at
# runtime; only the store is written, and that is a volume.
#
# THE STORE IS A VOLUME, NOT A DIRECTORY IN THE IMAGE. Compose mounts one at /data/store
# and Docker creates a named volume owned by the container user, so the app can write it.
# It is deliberately NOT `chown`ed here: a volume's ownership is settled when the volume is
# created, and a mount covers whatever this layer put there.
# THE STORE DIRECTORY IS CREATED HERE, OWNED BY THE CONTAINER USER, AND THAT IS THE
# WHOLE FIX FOR A VOLUME PERMISSION PROBLEM.
#
# A Docker NAMED VOLUME mounted at a path that exists in the image is INITIALISED FROM THE
# IMAGE'S CONTENTS, INCLUDING OWNERSHIP. If the directory does not exist in the image,
# Docker creates it as root:root, and a container running as `node` then cannot write to it.
# Measured, that is exactly what happened - the first run logged
#
#   EACCES: permission denied, mkdir '<store>/orgs'
#
# and the app's own error handling refused the demo route cleanly and started anyway rather
# than crashing, which is how the fault was visible instead of silent.
#
# `--chown=node:node` ON A DIRECTORY CREATED BY ROOT IS THE POINT. It costs one empty
# directory in the image and removes any need for an entrypoint that starts as root to
# chown a volume before dropping privileges - which would mean shipping a process that runs
# as root in order to be allowed to stop running as root.
#
# OUTSIDE /app, because the app's own schema lives at /app/data/store/schema.sql and a
# volume mounted there would hide it.
RUN mkdir -p /data/store && chown node:node /data/store

USER node

# Same port the app defaults to. Exposed for documentation: compose publishes it.
EXPOSE 3000

# ---------------------------------------------------------------------------
# THE ENVIRONMENT THE APP NEEDS, AND WHAT EACH ONE DOES
# ---------------------------------------------------------------------------
#
# HOST IS `0.0.0.0` AND THAT IS NOT OPTIONAL. The default is 127.0.0.1, which inside a
# container is the container's own loopback: a published port would accept the connection
# and find nothing listening, which reads as a broken image rather than a bind address.
#
# THE OTHERS ARE EXPECTED FROM COMPOSE:
#   SESSION_SECRET   required. The app refuses to start without it, on purpose - a secret
#                    generated per process invalidates every session on restart and looks
#                    like a broken login. Compose passes it from the repo's `.env`.
#   ALLOWED_HOST     the app refuses a Host it does not know, so a browser reaching the
#                    published port must be named here.
#   STORE_DIR        where organisation files live; compose points it at the volume.
#   DEMO_LOGIN*      the four variables that turn on the read-only demo link.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    STORE_DIR=/data/store \
    NODE_ENV=production

# THE ENTRYPOINT SEEDS THE STORE AND THEN EXECS THE APP. See docker-entrypoint.sh for why
# the committed demo has to be copied rather than mounted in place: the app cannot open a
# read-only store, because every connection applies the schema.
#
# NO INIT PROCESS IS NEEDED, and that is checked rather than assumed. Node as PID 1
# receives SIGTERM directly, and `server.js` installs its own handlers for SIGINT and
# SIGTERM that close the store's connections and exit. There are no child processes to
# reap, so the usual reason to add `--init` does not apply. `docker compose stop` therefore
# reaches the clean shutdown rather than a SIGKILL after the timeout.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
