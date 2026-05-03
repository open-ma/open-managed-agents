# OMA Default Sandbox Base Image
# Based on cloudflare/sandbox:0.9.1 which already has: Node.js 20, npm, git, jq, curl
# We add: Python 3.12, Go, Rust, build tools, ripgrep
# IMPORTANT: keep this version in lock-step with @cloudflare/sandbox in package.json,
# otherwise the container's HTTP routes drift from the SDK and exec calls 500.

FROM docker.io/cloudflare/sandbox:0.9.1

ENV DEBIAN_FRONTEND=noninteractive

# Only install what's missing from the base image
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential make cmake \
    vim nano tmux \
    tree htop less file \
    zip unzip \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# ripgrep — pre-built binary
RUN ARCH=$(dpkg --print-architecture) && \
    RG_VERSION="14.1.1" && \
    if [ "$ARCH" = "amd64" ]; then RG_ARCH="x86_64"; else RG_ARCH="aarch64"; fi && \
    curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 \
      "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-${RG_ARCH}-unknown-linux-musl.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local/bin "ripgrep-${RG_VERSION}-${RG_ARCH}-unknown-linux-musl/rg"

# uv + Python 3.12
RUN curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 \
      https://astral.sh/uv/install.sh | sh
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

# Go 1.22
RUN curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 \
      "https://go.dev/dl/go1.22.5.linux-$(dpkg --print-architecture).tar.gz" \
    | tar -xz -C /usr/local
ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

# Rust (minimal)
RUN curl --proto '=https' --tlsv1.2 -sSf --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 \
      https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"
