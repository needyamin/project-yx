# Project YX — Linux AppImage builder
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates build-essential pkg-config \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    patchelf libssl-dev libgtk-3-dev libxdo-dev libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev \
    wget file desktop-file-utils \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
    && rustup target list --installed

WORKDIR /workspace
