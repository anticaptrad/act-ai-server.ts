#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [[ $node_major != 22 ]]; then
  echo "agent-check requires the flake-pinned Node.js 22 toolchain" >&2
  exit 1
fi

echo "[agent-check] repository secret boundary"
tracked_plaintext=$(git ls-files | grep -E '(^|/)\.env$|(^|/)\.env\.[^/]*$|(^|/)env/dec/' | grep -vE '\.(example|sample|template)$' || true)
if [[ -n $tracked_plaintext ]]; then
  echo "tracked plaintext environment material:" >&2
  echo "$tracked_plaintext" >&2
  exit 1
fi

tracked_private_keys=$(git ls-files | grep -E '\.(agekey|age-key)$|(^|/)keys\.txt$|AGE-SECRET-KEY' || true)
if [[ -n $tracked_private_keys ]]; then
  echo "tracked private key material:" >&2
  echo "$tracked_private_keys" >&2
  exit 1
fi

shopt -s nullglob
encrypted_envs=(env/enc/*.env.enc)
for encrypted_env in "${encrypted_envs[@]}"; do
  grep -q 'ENC\[AES256_GCM' "$encrypted_env" || {
    echo "$encrypted_env is not encrypted" >&2
    exit 1
  }
  grep -q '^sops_mac=' "$encrypted_env" || {
    echo "$encrypted_env has no sops integrity MAC" >&2
    exit 1
  }
  recipient_count=$(grep -c 'map_recipient' "$encrypted_env" || true)
  if (( recipient_count < 2 )); then
    echo "$encrypted_env has fewer than two recovery recipients" >&2
    exit 1
  fi
done

echo "[agent-check] locked dependency install"
npm ci --ignore-scripts

echo "[agent-check] typecheck"
npm run typecheck

echo "[agent-check] build and security tests"
npm test
