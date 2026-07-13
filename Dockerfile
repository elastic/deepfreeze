# syntax=docker/dockerfile:1
#
# Deepfreeze server container.
#
# Builds the React frontend, bundles it into the Python package, installs the
# deepfreeze core + cli + server, and runs the daemon as a non-root user.
#
#   docker build -t deepfreeze-server .
#   docker run --rm -p 8000:8000 \
#     -v "$PWD/config.yml:/etc/deepfreeze/config.yml:ro" deepfreeze-server
#
# See packages/deepfreeze-server/README.md ("Docker") for full instructions.

# --- Stage 1: build the React frontend ---------------------------------------
FROM node:22-slim AS frontend
WORKDIR /build/frontend
# Install deps from the lockfile first for better layer caching.
COPY packages/deepfreeze-server/frontend/package.json \
     packages/deepfreeze-server/frontend/package-lock.json ./
RUN npm ci
COPY packages/deepfreeze-server/frontend/ ./
RUN npm run build   # outputs to /build/frontend/dist

# --- Stage 2: python runtime -------------------------------------------------
FROM python:3.12-slim AS runtime

# Optional deepfreeze-core cloud extras. Default installs both azure + gcp so a
# single image works against any backend (aws/boto3 is always included). Slim
# it down with e.g. --build-arg CORE_EXTRAS="[azure]" or CORE_EXTRAS="".
ARG CORE_EXTRAS="[azure,gcp]"

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Copy the monorepo packages needed for install.
COPY packages/deepfreeze-core   ./packages/deepfreeze-core
COPY packages/deepfreeze-cli    ./packages/deepfreeze-cli
COPY packages/deepfreeze-server ./packages/deepfreeze-server

# Bundle the built frontend into the server package so FastAPI serves it from
# deepfreeze_server/static/ (takes precedence over frontend/dist at runtime).
COPY --from=frontend /build/frontend/dist \
     ./packages/deepfreeze-server/deepfreeze_server/static

# Install in dependency order: core (with extras), then cli, then server. The
# local core satisfies the >=2.0.0 pins, so PyPI is never consulted for it.
RUN pip install "./packages/deepfreeze-core${CORE_EXTRAS}" \
 && pip install ./packages/deepfreeze-cli \
 && pip install ./packages/deepfreeze-server

# Run as a non-root user; config is mounted at /etc/deepfreeze/config.yml.
RUN useradd --create-home --uid 1000 deepfreeze \
 && mkdir -p /etc/deepfreeze \
 && chown -R deepfreeze:deepfreeze /etc/deepfreeze
USER deepfreeze

EXPOSE 8000

# Unauthenticated liveness endpoint; urlopen raises (non-zero exit) on non-200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"

ENTRYPOINT ["deepfreeze-server"]
CMD ["--config", "/etc/deepfreeze/config.yml", "--host", "0.0.0.0", "--port", "8000"]
