#!/bin/sh
set -e
# Render sets PORT=10000 for the web container; nginx listens on that port (nginx.conf).
# Go multiplayer must bind :5000 — nginx proxies /api/multiplayer/ there. Override PORT so the
# Go process does not inherit PORT=10000 from the container environment.
PORT=5000 /usr/local/bin/multiplayer-server &
exec nginx -g "daemon off;"
