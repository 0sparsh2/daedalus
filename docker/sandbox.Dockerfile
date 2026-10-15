# Local sandbox image for the Docker provider (development and tests). Production uses Vercel
# Sandbox microVMs. The starter app's dependencies are pre-installed for fast project creation.
FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system user.name "Daedalus" \
 && git config --system user.email "agent@daedalus.dev" \
 && git config --system init.defaultBranch main
COPY sandbox-template/ /opt/template/
RUN cd /opt/template && npm ci --no-audit --no-fund --loglevel=error
WORKDIR /workspace
CMD ["sleep", "infinity"]
