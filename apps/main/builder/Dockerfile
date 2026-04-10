# DinD builder: builds and deploys per-environment sandbox workers.
# Based on rootless Docker + Cloudflare Sandbox binary + Node.js + Wrangler.

FROM docker:dind-rootless

USER root

# Copy sandbox binary and dependencies (musl build for Alpine)
COPY --from=docker.io/cloudflare/sandbox:0.7.4-musl /container-server/sandbox /sandbox
COPY --from=docker.io/cloudflare/sandbox:0.7.4-musl /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=docker.io/cloudflare/sandbox:0.7.4-musl /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=docker.io/cloudflare/sandbox:0.7.4-musl /bin/bash /bin/bash
COPY --from=docker.io/cloudflare/sandbox:0.7.4-musl /usr/lib/libreadline.so.8 /usr/lib/libreadline.so.8
COPY --from=docker.io/cloudflare/sandbox:0.7.4-musl /usr/lib/libreadline.so.8.2 /usr/lib/libreadline.so.8.2

# Install Node.js + npm (for wrangler)
RUN apk add --no-cache nodejs npm jq

# Install wrangler globally
RUN npm install -g wrangler

# Startup script: init Docker daemon then wait
RUN printf '#!/bin/sh\n\
set -eu\n\
dockerd-entrypoint.sh dockerd --iptables=false --ip6tables=false &\n\
until docker version >/dev/null 2>&1; do sleep 0.2; done\n\
echo "Docker is ready"\n\
wait\n' > /home/rootless/boot.sh && chmod +x /home/rootless/boot.sh

ENTRYPOINT ["/sandbox"]
CMD ["/home/rootless/boot.sh"]
