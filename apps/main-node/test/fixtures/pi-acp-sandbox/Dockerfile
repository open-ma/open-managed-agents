FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

RUN npm install --global @earendil-works/pi-coding-agent@0.84.4
RUN npm install --global pi-acp@0.0.33 \
    && npm cache clean --force

WORKDIR /workspace
