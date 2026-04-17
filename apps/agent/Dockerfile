# OMA Default Sandbox Base Image
# Build once, push to GHCR, reuse everywhere.
#
# Build & push:
#   docker build -t openma/sandbox-base:latest apps/agent/
#   docker push openma/sandbox-base:latest
#
# Parity target: Anthropic Managed Agents Cloud Container Reference

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# System packages + tools + build essentials
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core
    ca-certificates curl wget gnupg2 software-properties-common \
    # Build essentials
    build-essential gcc g++ make cmake \
    # VCS & archive
    git tar zip unzip xz-utils \
    # Network
    openssh-client \
    # Text processing
    sed gawk grep diffutils patch \
    # Editors & terminal
    vim nano tmux screen \
    # Utilities
    jq tree htop procps less file \
    # Database clients
    sqlite3 libsqlite3-dev postgresql-client redis-tools \
    && rm -rf /var/lib/apt/lists/*

# ripgrep — pre-built binary (not cargo install, which takes 10+ min to compile)
RUN ARCH=$(dpkg --print-architecture) && \
    RG_VERSION="14.1.1" && \
    if [ "$ARCH" = "amd64" ]; then RG_ARCH="x86_64"; else RG_ARCH="aarch64"; fi && \
    curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-${RG_ARCH}-unknown-linux-musl.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local/bin "ripgrep-${RG_VERSION}-${RG_ARCH}-unknown-linux-musl/rg"

# uv — manages Python + packages
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Python 3.12 via uv
RUN uv python install 3.12 && \
    uv venv /opt/venv --python 3.12 --seed
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# Common Python packages
RUN uv pip install --no-cache \
    requests httpx pyyaml toml \
    pandas numpy \
    pytest black ruff mypy

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    npm install -g yarn pnpm && \
    rm -rf /var/lib/apt/lists/*

# Go 1.22
RUN curl -fsSL https://go.dev/dl/go1.22.5.linux-$(dpkg --print-architecture).tar.gz | tar -xz -C /usr/local
ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

# Rust (latest stable) — installed last, largest layer
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# Workspace
RUN mkdir -p /home/user/workspace
WORKDIR /home/user/workspace

ENV SHELL=/bin/bash
CMD ["/bin/bash"]
