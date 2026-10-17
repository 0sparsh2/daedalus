#!/usr/bin/env bash
# Free, keyless web search for local development: runs SearXNG in Docker on 127.0.0.1:8888.
# Usage: scripts/searxng.sh start|stop|status   (pnpm search:start / search:stop)
set -euo pipefail
NAME=daedalus-searxng
PORT="${SEARXNG_PORT:-8888}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-start}" in
  start)
    if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then echo "SearXNG already running on http://127.0.0.1:$PORT"; exit 0; fi
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" --restart unless-stopped \
      -p "127.0.0.1:$PORT:8080" \
      -v "$DIR/docker/searxng/settings.yml:/etc/searxng/settings.yml:ro" \
      -e SEARXNG_SECRET="$(openssl rand -hex 32)" \
      -e SEARXNG_BASE_URL="http://127.0.0.1:$PORT/" \
      searxng/searxng:2026.10.17-1c10abe2d >/dev/null
    for _ in $(seq 1 30); do
      if curl -fsS "http://127.0.0.1:$PORT/search?q=test&format=json" >/dev/null 2>&1; then
        echo "SearXNG ready on http://127.0.0.1:$PORT (set SEARXNG_URL=http://127.0.0.1:$PORT)"; exit 0
      fi
      sleep 1
    done
    echo "SearXNG didn't answer within 30 s; see: docker logs $NAME" >&2; exit 1 ;;
  stop) docker rm -f "$NAME" >/dev/null 2>&1 && echo "SearXNG stopped" || echo "SearXNG wasn't running" ;;
  status) docker ps --filter "name=^$NAME$" --format '{{.Names}} {{.Status}}' ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
