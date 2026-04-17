# OMA Default Sandbox Base Image
# Based on cloudflare/sandbox (has correct entrypoint + port setup)
# Adds: Python 3.12, Node.js 20, Go, Rust, common dev tools
#
# Build & push:
#   docker build -t openma/sandbox-base:latest apps/agent/
#   docker push openma/sandbox-base:latest

FROM docker.io/cloudflare/sandbox:0.8.11

ENV DEBIAN_FRONTEND=noninteractive

# System tools (retry apt if mirror is syncing)
RUN apt-get update || (sleep 30 && apt-get update) && \
    apt-get install -y --no-install-recommends \
    build-essential gcc g++ make cmake \
    git curl wget jq tree htop procps less file \
    vim nano tmux screen \
    zip unzip xz-utils \
    sqlite3 libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# ripgrep — pre-built binary
RUN ARCH=$(dpkg --print-architecture) && \
    RG_VERSION="14.1.1" && \
    if [ "$ARCH" = "amd64" ]; then RG_ARCH="x86_64"; else RG_ARCH="aarch64"; fi && \
    curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-${RG_ARCH}-unknown-linux-musl.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local/bin "ripgrep-${RG_VERSION}-${RG_ARCH}-unknown-linux-musl/rg"

# uv + Python 3.12
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"
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

# Rust (minimal profile)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"
