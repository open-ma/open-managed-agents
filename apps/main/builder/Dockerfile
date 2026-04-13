# DinD builder: builds and pushes custom sandbox images.
# Pattern: docker:dind-rootless + Node.js HTTP server on port 8080.

FROM docker:dind-rootless
USER root

# Node.js + npm + git (for wrangler + cloning)
RUN apk add --no-cache nodejs npm git jq bash

# Install wrangler globally
RUN npm install -g wrangler

# Builder HTTP server
COPY server.js /opt/builder/server.js

# Entrypoint: start dockerd in background, wait for it, then start server
COPY entrypoint.sh /opt/builder/entrypoint.sh
RUN chmod +x /opt/builder/entrypoint.sh

ENTRYPOINT ["sh", "-c", "dockerd-entrypoint.sh dockerd --iptables=false --ip6tables=false & exec /opt/builder/entrypoint.sh"]
