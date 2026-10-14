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
# ===========================================================================
# STAGE 1: FETCH proton-cli, VERIFIED
# ===========================================================================
#
# FETCHED AT BUILD TIME, NOT COMMITTED. The binary is 27MB, it is third-party, and its
# licence is not this project's to redistribute in a git repository. Fetching also
# means the version is a PIN rather than a file somebody once copied in, so a rebuild
# either reproduces the same binary or fails loudly.
#
# THE VERSION AND THE CHECKSUM ARE BOTH PINNED, and the checksum is what makes that
# meaningful. A pinned version alone still trusts whatever is at that URL today; the
# published SHA-256 is verified before the file is unpacked, so a replaced or corrupted
# asset stops the build instead of shipping. Measured:
#
#   $ sha256sum pkg.tar.gz
#   57e5083c20e8163e88421d0f6bdc7d959165df537b0e553ce9d13532d0686b5c
#
# which matches the proton-cli_5.0.1_linux_amd64.tar.gz line in the release's
# checksums.txt, and the extracted binary is byte-identical to the one running on the
# machine this was developed on.
#
# TO CHANGE THE VERSION: update both ARGs together, or the build stops at the
# checksum. That is the intended friction - a silent upgrade of a mail credential's
# tool is not something to slip through a rebuild.
#
# `--no-same-owner` because the tarball is unpacked as root and the extracted file is
# then copied to its own stage; ownership here is irrelevant and letting tar restore a
# recorded owner would be a pointless privilege.
# ALPINE RATHER THAN A DEBIAN SLIM, because the fetch needs a downloader and the
# Debian slim images carry neither curl nor wget. Measured: `debian:bookworm-slim` has
# sha256sum but no curl and no wget, and so does the node base image. Alpine has wget
# and a busybox sha256sum built in, at 3MB. A scratch stage with a copied-in downloader
# would be more ostentatious and would not be smaller than this.
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS proton-cli
ARG PROTON_CLI_VERSION=5.0.1
ARG PROTON_CLI_SHA256=57e5083c20e8163e88421d0f6bdc7d959165df537b0e553ce9d13532d0686b5c
RUN set -eu; \
    url="https://github.com/roman-16/proton-cli/releases/download/v${PROTON_CLI_VERSION}/proton-cli_${PROTON_CLI_VERSION}_linux_amd64.tar.gz"; \
    wget -q -O /tmp/proton.tar.gz "$url"; \
    echo "${PROTON_CLI_SHA256}  /tmp/proton.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/proton.tar.gz -C /tmp --no-same-owner proton; \
    install -m 0755 /tmp/proton /opt/proton; \
    rm -f /tmp/proton.tar.gz /tmp/proton; \
    /opt/proton --version

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

# ---------------------------------------------------------------------------
# proton-cli, FOR THE PROTON MAIL TRANSPORT
# ---------------------------------------------------------------------------
#
# THE BINARY SHIPS IN THE IMAGE; THE SESSION DOES NOT. That split is the whole point:
# the credential is a Proton login, and it must never exist on the host or in a layer
# anybody can pull. The operator signs in ONCE inside a running container, the session
# lands in the mounted volume below, and it stays there.
#
# STATICALLY LINKED, AND THAT IS MEASURED RATHER THAN ASSUMED, because it decides
# whether this can be a copy:
#
#   $ file proton
#   ELF 64-bit LSB executable, x86-64, statically linked, Go BuildID=..., stripped
#   $ ldd proton
#   not a dynamic executable
#
# A static Go binary has no interpreter, no libc and no libraries to carry, so there
# is no glibc-version question to get wrong - which is the failure mode worth ruling
# out here, since a binary built against a newer glibc would run on the build machine
# and fail at runtime. It was also RUN in this base image before being copied, so
# "static" is confirmed by execution rather than by reading the header:
#
# and the same file is RUN before it is copied, so the version is confirmed by executing
# it rather than by reading a header. The fetch stage below does this on every build:
#
#   /tmp/proton.tar.gz: OK
#   proton version 5.0.1
#
# x86-64 ONLY, because the binary is. On an arm64 host this build fails at the COPY
# rather than producing an image whose mail silently cannot work.
# THE SYSTEM CA BUNDLE, AND IT IS HERE BECAUSE OF THE GO BINARY BELOW RATHER THAN FOR NODE.
#
# `node:24-slim` SHIPS WITHOUT `ca-certificates`. Measured against the pinned digest by
# listing the image's own layers: there is no `/etc/ssl/certs/ca-certificates.crt`, no
# `update-ca-certificates`, and no `ca-certificates` entry in `var/lib/dpkg/status`. The
# image carries the crypto libraries (`libgnutls30`, `libgcrypt20`, `libp11-kit0`) and no
# system trust store at all.
#
# THAT IS FINE FOR NODE AND FATAL FOR GO, and the difference is the whole reason this line
# exists. Node ships its OWN root certificates and ignores the system store, so the app's
# outbound calls verify normally - which is why this looks like a Proton problem rather than
# an image problem. `proton-cli` is a GO binary, and Go reads the SYSTEM trust store, so
# every TLS connection it makes is refused before authentication is even attempted:
#
#   tls: failed to verify certificate: x509: certificate signed by unknown authority
#
# MEASURED on a real deploy, on one container: `node fetch('https://api.deepseek.com/')`
# returned a real 401 response, so TLS verified, while `proton-cli account login` failed with
# the x509 error above. THAT SPLIT - the app's own API calls working while proton-cli fails -
# is the signature of a Go binary in an image with no system roots, and it is recorded in
# DEPLOY.md's troubleshooting table so the next person reads it as an image problem.
#
# IT MUST BE IN THIS STAGE. The binary is built in the `alpine` stage above, but Alpine's
# certificates stay there: a `COPY --from` brings the file, not the trust store. Installing
# them next to the binary is what actually fixes it.
#
# `--no-install-recommends` AND THE LIST CLEANUP, because this image is built slim on
# purpose. `ca-certificates` depends on `openssl`, which brings `libssl3`; everything else in
# that closure (`libc6`, `libgcc-s1`, `debconf`) is already present. So the honest cost is
# THREE new packages, ~8.5MB installed by Debian's own Installed-Size figures - and this is
# the final stage, so it is a new layer rather than a saving in an earlier one.
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    rm -rf /var/lib/apt/lists/*

# THE SESSION DIRECTORY, EMPTY, OWNED BY node. The binary reads XDG_CONFIG_HOME and
# looks for proton-cli/ inside it, so pointing that variable at /home/node/.config
# makes this ONE KNOWN LOCATION - which is what a volume needs.
#
# XDG_CONFIG_HOME RATHER THAN PROTON_CONFIG, and this was tested against the binary
# rather than picked from the documentation: PROTON_CONFIG names the SETTINGS FILE
# only, so the sessions/ directory would stay wherever HOME put it and the credential
# would end up outside the volume. Measured, with XDG_CONFIG_HOME pointed at an empty
# directory: `proton account profiles list` answers "No profiles." and creates
# proton-cli/ there, while without it the host's real session appears.
RUN mkdir -p /home/node/.config && chown node:node /home/node/.config

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
    NODE_ENV=production \
    XDG_CONFIG_HOME=/home/node/.config

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
