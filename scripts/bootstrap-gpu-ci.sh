#!/usr/bin/env bash

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "GPU CI bootstrap must run as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes \
  build-essential \
  ca-certificates \
  clang \
  cmake \
  curl \
  docker.io \
  pkg-config
systemctl enable --now docker
usermod --append --groups docker ubuntu

if [[ ! -x /home/ubuntu/.cargo/bin/cargo ]]; then
  sudo -u ubuntu -H sh -c \
    'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal'
fi

sudo -u ubuntu -H /home/ubuntu/.cargo/bin/rustup target add wasm32-unknown-unknown
if [[ ! -x /home/ubuntu/.cargo/bin/wasm-pack ]] || \
  [[ $(sudo -u ubuntu -H /home/ubuntu/.cargo/bin/wasm-pack --version) != "wasm-pack 0.13.1" ]]; then
  sudo -u ubuntu -H /home/ubuntu/.cargo/bin/cargo install wasm-pack --version 0.13.1 --locked
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
npx playwright install-deps chromium
