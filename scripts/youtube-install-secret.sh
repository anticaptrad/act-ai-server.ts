#!/usr/bin/env bash
# Load the YouTube publishing credentials into the cluster.
#
# Reads the file written by scripts/youtube-authorize.mjs and creates/updates
# the Secret the act-ai-server deployment consumes. Values are piped from files
# rather than passed as arguments so they never appear in `ps` output or shell
# history.
#
#   ./scripts/youtube-install-secret.sh [--context CTX] [--namespace NS]
#
# The channel the token actually owns is printed so a mismatch with the
# manifest's YOUTUBE_CHANNEL_ID is caught here, before a deploy.

set -euo pipefail

TOKEN_FILE="${YOUTUBE_TOKEN_OUT:-$HOME/.anticaptrad-youtube.json}"
SECRET_NAME="${SECRET_NAME:-act-ai-server-secrets}"
CONTEXT=""
NAMESPACE="default"

while [ $# -gt 0 ]; do
  case "$1" in
    --context) CONTEXT="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -f "$TOKEN_FILE" ] || {
  echo "No token file at $TOKEN_FILE — run scripts/youtube-authorize.mjs first." >&2
  exit 1
}

KUBECTL=(kubectl)
[ -n "$CONTEXT" ] && KUBECTL+=(--context "$CONTEXT")
KUBECTL+=(-n "$NAMESPACE")

read_field() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['$1'])" "$TOKEN_FILE"; }

CHANNEL_ID="$(read_field channelId)"
CHANNEL_TITLE="$(read_field channelTitle)"
CLIENT_ID="$(read_field clientId)"

echo "Token authorizes: $CHANNEL_TITLE ($CHANNEL_ID)"

# Compare against what the deployment will enforce, so a wrong account is
# caught now rather than as a 503 after rollout.
EXPECTED="$(${KUBECTL[@]} get configmap act-ai-server-config \
  -o jsonpath='{.data.YOUTUBE_CHANNEL_ID}' 2>/dev/null || true)"
if [ -n "$EXPECTED" ] && [ "$EXPECTED" != "$CHANNEL_ID" ]; then
  echo "REFUSING: deployment expects channel $EXPECTED but this token owns $CHANNEL_ID." >&2
  echo "Re-authorize as the correct account, or update YOUTUBE_CHANNEL_ID." >&2
  exit 1
fi

# Written to temp files so the secret never appears in the process table.
TMPDIR_SECURE="$(mktemp -d)"
trap 'find "$TMPDIR_SECURE" -type f -exec shred -u {} + 2>/dev/null || true; rmdir "$TMPDIR_SECURE" 2>/dev/null || true' EXIT
umask 077
read_field refreshToken > "$TMPDIR_SECURE/refresh_token"
printf '%s' "$CLIENT_ID" > "$TMPDIR_SECURE/client_id"

if [ -z "${YOUTUBE_CLIENT_SECRET:-}" ]; then
  echo "Set YOUTUBE_CLIENT_SECRET in the environment before running this." >&2
  exit 1
fi
printf '%s' "$YOUTUBE_CLIENT_SECRET" > "$TMPDIR_SECURE/client_secret"

# --dry-run | apply so an existing Secret is updated in place rather than
# needing a delete, which would blank the credentials between the two calls.
"${KUBECTL[@]}" create secret generic "$SECRET_NAME" \
  --from-file=YOUTUBE_CLIENT_ID="$TMPDIR_SECURE/client_id" \
  --from-file=YOUTUBE_CLIENT_SECRET="$TMPDIR_SECURE/client_secret" \
  --from-file=YOUTUBE_REFRESH_TOKEN="$TMPDIR_SECURE/refresh_token" \
  --dry-run=client -o yaml | "${KUBECTL[@]}" apply -f -

echo
echo "Secret '$SECRET_NAME' updated in $NAMESPACE."
echo "Restart the deployment to pick it up:"
echo "  ${KUBECTL[*]} rollout restart deploy/act-ai-server"
