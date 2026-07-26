# YouTube publishing setup

`act-ai-server` publishes to **[youtube.com/@AntiCapTrad](https://youtube.com/@anticaptrad)**
(`UC-Gloecwemo_Mh-VAjnUipg`) headlessly, which needs a long-lived OAuth refresh
token. A refresh token can only come from an interactive consent by the account
that owns the channel, so this is a one-time human step. Everything after it is
automated.

## Status

| Piece | State |
| --- | --- |
| YouTube Data API v3 | **Enabled** on `northern-syntax-442416-j8` |
| OAuth client | **Not created** — the one manual step (see below) |
| Refresh token | **Not minted** — blocked on the client |
| Upload directory | Mounted at `/mnt/renders` |
| Channel pin | `YOUTUBE_CHANNEL_ID` / `_HANDLE` set in the ConfigMap |
| Endpoint auth | `/api/*` requires `SERVER_AUTH_SECRET` |

Until the token exists, `/api/publish/youtube` answers **503** naming the
missing variables. That is the designed behaviour, not a fault.

## 1. Create the OAuth client (manual)

There is no API for creating generic OAuth clients — `gcloud` cannot do it — so
this happens in the Console:

> https://console.cloud.google.com/auth/clients/create?project=northern-syntax-442416-j8

**Application type must be `Desktop app`.** Desktop clients permit the
`http://127.0.0.1` loopback redirect the authorize script uses, which keeps the
authorization code on the machine that requested it. A Web client would require
a pre-registered HTTPS callback and would reject the loopback.

Download the JSON when prompted.

### Check the publishing status

> https://console.cloud.google.com/auth/audience?project=northern-syntax-442416-j8

If the app is **External + Testing**, Google expires refresh tokens after
**7 days**. For a headless publisher that means silent weekly breakage. Either
**Publish app** (moves it to In production), or accept re-authorizing weekly and
add the channel account as a test user.

## 2. Mint the refresh token

```sh
cd act-ai-server.ts
node scripts/youtube-authorize.mjs            # finds the newest client_secret*.json
# or: node scripts/youtube-authorize.mjs --client-json ~/Downloads/client_secret_….json
```

It opens a consent tab. **Sign in as the account that owns the channel**
(`anticaptrad@gmail.com`) — signing in as anyone else mints a token for *their*
channel, which the service will then refuse to use.

The script requests `access_type=offline` and `prompt=consent`. The second is
not redundant: Google returns a refresh token only on a *fresh* grant, so
re-running against an already-approved client otherwise yields an access token
with no refresh token and no error.

It verifies which channel the token owns, then writes
`~/.anticaptrad-youtube.json` with mode `600`. The token is never printed.

## 3. Install into the cluster

```sh
export YOUTUBE_CLIENT_SECRET='…'      # from the same JSON
./scripts/youtube-install-secret.sh --context dd-ec2-runtime --namespace default
kubectl --context dd-ec2-runtime -n default rollout restart deploy/act-ai-server
```

Values are piped through files, so the token never appears in `ps` or shell
history. The script **refuses to install** if the token's channel differs from
the `YOUTUBE_CHANNEL_ID` the deployment enforces — catching a wrong account
before a rollout rather than as a 503 after one.

## 4. Verify

```sh
kubectl --context dd-ec2-runtime -n default exec deploy/act-ai-server -- \
  wget -qO- localhost:3000/ready
```

`youtube` should read `configured`. Then, with the service secret:

```sh
curl -X POST http://<svc>/api/publish/youtube \
  -H 'content-type: application/json' \
  -H "x-server-auth: $SERVER_AUTH_SECRET" \
  -d '{"filePath":"render.mp4","title":"Test","description":"…"}'
```

`filePath` is resolved **inside `/mnt/renders`** — absolute paths, traversal,
and symlinks pointing out of it are all refused. Uploads default to
`privacyStatus: private`, so a misconfiguration cannot publish publicly.

## Failure modes and what they mean

| Response | Cause |
| --- | --- |
| `503 … not configured: YOUTUBE_… unset` | No credentials installed |
| `503 … different channel: got UC…` | Token owns another channel; re-authorize as the right account |
| `503 credentials rejected — re-authorization required` | Refresh token revoked or expired (password change, or 7-day Testing expiry) |
| `429 quota exceeded` | Daily quota spent. An upload costs ~1600 units of a 10,000/day default |
| `404 file not found` / `400 outside the upload directory` | Path is not a real file inside `/mnt/renders` |
| `415 unsupported video format` | Extension not in mp4/mov/webm/mkv/avi |
| `401 Unauthorized` | Missing or wrong `x-server-auth` |

## Notes

- **The render volume is an `emptyDir`.** Videos do not survive a pod restart.
  Switch to a PVC before relying on renders outliving the pod.
- **Quota is the real ceiling on throughput**, not compute: the default 10,000
  units/day allows roughly six uploads. Request more before scheduling
  automated publishing.
- The existing `GOOGLE_OAUTH_CLIENT_ID` in `dd-next-1-js-env` is a **Web** client
  for `dancingdragons.cc`. It is deliberately not reused: wrong redirect type,
  and it would put this product's consent under another product's name.
