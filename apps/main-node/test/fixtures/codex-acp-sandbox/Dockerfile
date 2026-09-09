FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

RUN npm install --global @agentclientprotocol/codex-acp@1.8.0 \
    && npm cache clean --force

WORKDIR /workspace
