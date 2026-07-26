#!/usr/bin/env node
// One-time YouTube authorization: mint a long-lived refresh token.
//
// The server publishes headlessly, which needs a refresh token, and a refresh
// token can only come from an interactive consent by the account that owns the
// channel. This script runs that consent once and stores the result; after it,
// nothing interactive is ever needed again.
//
//   node scripts/youtube-authorize.mjs
//
// Requires YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET from a **Desktop app**
// OAuth client (Desktop clients permit the http://127.0.0.1 loopback redirect
// this uses; Web clients require a pre-registered https URL).
//
// The loopback redirect is deliberate: the authorization code never leaves this
// machine, so no hosted callback can intercept it.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';

// youtube.upload alone is enough to publish. `youtube.readonly` is added so the
// service can verify which channel the credentials own before uploading —
// without it, a swapped token publishes to a stranger's channel silently.
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const OUT_PATH =
  process.env.YOUTUBE_TOKEN_OUT ?? path.join(process.env.HOME ?? '.', '.anticaptrad-youtube.json');

/**
 * Locate the client credentials.
 *
 * Console hands you a `client_secret_*.json` download, so accept that directly
 * rather than making anyone transcribe two long strings into env vars — a step
 * that mostly produces typos. Explicit `--client-json` wins, then the
 * environment, then the newest matching download.
 */
async function loadClientCredentials(argv) {
  const flagIndex = argv.indexOf('--client-json');
  const explicit = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;

  const fromFile = async (file) => {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    // Desktop clients serialize under `installed`, web clients under `web`.
    const block = parsed.installed ?? parsed.web ?? parsed;
    if (!block.client_id || !block.client_secret) {
      throw new Error(`${file} has no client_id/client_secret`);
    }
    if (!parsed.installed && parsed.web) {
      console.warn(
        '\nWarning: this is a WEB client. The loopback redirect below will be\n' +
          'rejected unless it is registered. A Desktop client avoids that.\n',
      );
    }
    return { clientId: block.client_id, clientSecret: block.client_secret, source: file };
  };

  if (explicit) return fromFile(explicit);

  if (process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET) {
    return {
      clientId: process.env.YOUTUBE_CLIENT_ID,
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
      source: 'environment',
    };
  }

  const home = process.env.HOME ?? '.';
  for (const dir of [path.join(home, 'Downloads'), path.join(home, 'Desktop'), process.cwd()]) {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    const candidates = entries.filter(
      (name) => name.startsWith('client_secret') && name.endsWith('.json'),
    );
    if (candidates.length === 0) continue;

    // Newest wins, so re-downloading after a mistake does the obvious thing.
    const withTimes = await Promise.all(
      candidates.map(async (name) => {
        const full = path.join(dir, name);
        return { full, mtime: (await fs.stat(full)).mtimeMs };
      }),
    );
    withTimes.sort((a, b) => b.mtime - a.mtime);
    return fromFile(withTimes[0].full);
  }

  throw new Error(
    'No client credentials found.\n' +
      '  Create a Desktop OAuth client, download its JSON, then either:\n' +
      '    node scripts/youtube-authorize.mjs --client-json <path>\n' +
      '  or set YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET.',
  );
}

/** Open a URL in the user's browser. */
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

/** Serve one request on the loopback redirect and resolve with its code. */
function awaitCode(server) {
  return new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      // Answer the browser before settling, so the tab shows an outcome rather
      // than a connection reset.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>AntiCapTrad</title>` +
          `<body style="font:16px system-ui;padding:3rem;max-width:34rem">` +
          (code
            ? '<h1>Authorized</h1><p>You can close this tab and return to the terminal.</p>'
            : `<h1>Authorization failed</h1><p>${error ?? 'no code returned'}</p>`) +
          '</body>',
      );

      if (code) resolve(code);
      else reject(new Error(error ?? 'no authorization code returned'));
    });
  });
}

async function main() {
  const { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, source } =
    await loadClientCredentials(process.argv.slice(2));
  console.log(`Using client credentials from: ${source}`);

  // Port 0 lets the OS pick; the exact port goes into the redirect URI, and
  // Desktop clients accept any loopback port.
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const redirectUri = `http://127.0.0.1:${port}`;

  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);
  const authUrl = oauth2.generateAuthUrl({
    // Without offline access Google returns only a short-lived access token and
    // the server cannot publish unattended.
    access_type: 'offline',
    scope: SCOPES,
    // Force the consent screen even if this account already approved the app:
    // Google only returns a refresh token on a *fresh* grant, so re-running
    // without this yields tokens with no refresh_token at all.
    prompt: 'consent',
    include_granted_scopes: true,
  });

  console.log('\nSign in as the account that owns the channel you publish to.\n');
  console.log(authUrl, '\n');
  openBrowser(authUrl);

  const code = await awaitCode(server);
  server.close();

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      '\nNo refresh_token returned. This happens when the account has already\n' +
        'granted this client and Google reissued only an access token. Revoke the\n' +
        'app at https://myaccount.google.com/permissions and run this again.',
    );
    process.exit(1);
  }

  // Confirm which channel these credentials actually own before anyone wires
  // them into a deployment.
  oauth2.setCredentials(tokens);
  const youtube = google.youtube({ version: 'v3', auth: oauth2 });
  const channel = (
    await youtube.channels.list({ part: ['id', 'snippet'], mine: true })
  ).data.items?.[0];

  if (!channel?.id) {
    console.error('\nAuthorized, but the account owns no YouTube channel.');
    process.exit(1);
  }

  // 0600: this file is a durable credential.
  await fs.writeFile(
    OUT_PATH,
    JSON.stringify(
      {
        channelId: channel.id,
        channelTitle: channel.snippet?.title ?? '',
        channelHandle: channel.snippet?.customUrl ?? '',
        clientId: CLIENT_ID,
        refreshToken: tokens.refresh_token,
        obtainedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  console.log(`\nAuthorized channel: ${channel.snippet?.title} (${channel.id})`);
  console.log(`Handle:             ${channel.snippet?.customUrl ?? '—'}`);
  console.log(`Refresh token written to ${OUT_PATH} (mode 600).`);
  console.log('\nThe token is NOT printed here on purpose — it is a durable credential.');
  console.log('Load it into the cluster with scripts/youtube-install-secret.sh.\n');
}

main().catch((error) => {
  console.error('\nAuthorization failed:', error.message);
  process.exit(1);
});
