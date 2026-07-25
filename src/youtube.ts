// YouTube Data API publishing.
//
// Uses a long-lived OAuth2 refresh token for headless, background auth. All
// credentials come from the environment (injected by the k8s deployment); no
// `.env` — `dotenv` is blacklisted platform-wide (see agents.md).
import { google } from 'googleapis';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

/** YouTube is configured but the request cannot be served as asked. */
export class YouTubePublishError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'YouTubePublishError';
  }
}

/** Required OAuth credentials are absent. */
export class YouTubeNotConfiguredError extends Error {
  constructor(readonly missing: string[]) {
    super(`YouTube publishing is not configured: ${missing.join(', ')} unset`);
    this.name = 'YouTubeNotConfiguredError';
  }
}

const REQUIRED_ENV = [
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_CLIENT_SECRET',
  'YOUTUBE_REFRESH_TOKEN',
] as const;

/**
 * The single directory uploads may come from.
 *
 * `filePath` arrives in a request body, so without this the endpoint is an
 * arbitrary-file-read primitive: any file the process can open — service
 * account tokens, /etc/passwd, another tenant's render — could be named and
 * published to an external platform. Uploading it "privately" still exfiltrates
 * it. Everything is resolved against this root and rejected if it escapes.
 */
const UPLOAD_ROOT = path.resolve(process.env.YOUTUBE_UPLOAD_DIR ?? '/mnt/renders');

/** Container formats YouTube accepts that we are willing to stream. */
const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);

/** YouTube's own accepted values; anything else is rejected by the API. */
const PRIVACY_STATUSES = new Set(['private', 'unlisted', 'public']);

const MAX_UPLOAD_BYTES = Number(process.env.YOUTUBE_MAX_UPLOAD_BYTES ?? 5 * 1024 * 1024 * 1024);

/**
 * The channel these credentials are expected to own.
 *
 * A refresh token names an account, not a channel, and nothing in the upload
 * call says which channel it lands on. Swap in a token for a different Google
 * account — a stale secret, a copy-paste from another project, a shared
 * dev/prod mixup — and uploads silently publish to a stranger's channel under
 * our titles. Checking identity once before the first upload turns that from a
 * public mistake into a startup error.
 *
 * Unset disables the check.
 */
const EXPECTED_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID ?? '';
const EXPECTED_CHANNEL_HANDLE = process.env.YOUTUBE_CHANNEL_HANDLE ?? '';

export function missingYouTubeConfig(): string[] {
  return REQUIRED_ENV.filter((name) => !process.env[name]);
}

export function isYouTubeConfigured(): boolean {
  return missingYouTubeConfig().length === 0;
}

let client: ReturnType<typeof google.youtube> | undefined;

/**
 * Build the API client on first use.
 *
 * Constructed lazily so an unconfigured deployment still starts and serves its
 * probes — the same reason the LLM providers are lazy. A missing credential is
 * a 503 on this one route, not a dead pod.
 */
function getYouTube() {
  if (client) return client;

  const missing = missingYouTubeConfig();
  if (missing.length > 0) throw new YouTubeNotConfiguredError(missing);

  const oauth2Client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    process.env.YOUTUBE_REDIRECT_URI,
  );
  oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });

  client = google.youtube({ version: 'v3', auth: oauth2Client });
  return client;
}

/**
 * Resolve a caller-supplied path to a real file inside {@link UPLOAD_ROOT}.
 *
 * `realpath` is what makes this sound: it resolves symlinks before the
 * containment check, so a link inside the upload directory pointing at /etc
 * cannot smuggle a file out. Comparing the string paths alone would miss it.
 */
export async function resolveUploadPath(filePath: string): Promise<string> {
  const candidate = path.resolve(UPLOAD_ROOT, filePath);

  let real: string;
  try {
    real = await fsp.realpath(candidate);
  } catch {
    throw new YouTubePublishError('file not found', 404);
  }

  const rootReal = await fsp.realpath(UPLOAD_ROOT).catch(() => UPLOAD_ROOT);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    // Deliberately does not echo the resolved path — that would confirm what
    // exists outside the upload directory.
    throw new YouTubePublishError('file is outside the upload directory', 400);
  }

  const stat = await fsp.stat(real);
  if (!stat.isFile()) throw new YouTubePublishError('not a regular file', 400);
  if (stat.size === 0) throw new YouTubePublishError('file is empty', 400);
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new YouTubePublishError(`file exceeds ${MAX_UPLOAD_BYTES} bytes`, 413);
  }
  if (!ALLOWED_EXTENSIONS.has(path.extname(real).toLowerCase())) {
    throw new YouTubePublishError('unsupported video format', 415);
  }

  return real;
}

export interface ChannelIdentity {
  id: string;
  title: string;
  handle?: string;
}

let verifiedChannel: ChannelIdentity | undefined;

/**
 * Confirm the configured credentials own the channel we expect.
 *
 * Cached after the first success: channel identity does not change for the life
 * of a token, and re-checking would spend a quota unit per upload.
 */
export async function verifyChannel(): Promise<ChannelIdentity> {
  if (verifiedChannel) return verifiedChannel;

  const youtube = getYouTube();
  const res = await youtube.channels.list({ part: ['id', 'snippet'], mine: true });
  const channel = res.data.items?.[0];
  if (!channel?.id) {
    throw new YouTubePublishError('credentials own no YouTube channel', 503);
  }

  const identity: ChannelIdentity = {
    id: channel.id,
    title: channel.snippet?.title ?? '',
    handle: channel.snippet?.customUrl ?? undefined,
  };

  const normalize = (value: string) => value.replace(/^@/, '').toLowerCase();
  const idMismatch = EXPECTED_CHANNEL_ID && EXPECTED_CHANNEL_ID !== identity.id;
  const handleMismatch =
    EXPECTED_CHANNEL_HANDLE &&
    identity.handle &&
    normalize(EXPECTED_CHANNEL_HANDLE) !== normalize(identity.handle);

  if (idMismatch || handleMismatch) {
    // Names the channel we landed on so the mixup is obvious, but refuses to
    // upload. Publishing to the wrong channel is not recoverable by deleting.
    throw new YouTubePublishError(
      `credentials belong to a different channel: got ${identity.id}` +
        `${identity.handle ? ` (${identity.handle})` : ''}, expected ` +
        `${EXPECTED_CHANNEL_ID || EXPECTED_CHANNEL_HANDLE}`,
      503,
    );
  }

  verifiedChannel = identity;
  return identity;
}

/** Forget the cached identity. Tests use this; production never needs it. */
export function resetChannelCache(): void {
  verifiedChannel = undefined;
}

export interface UploadOptions {
  privacyStatus?: string;
  tags?: string[];
  categoryId?: string;
}

/** Upload a video from the upload directory and return the created video id. */
export async function uploadToYouTube(
  filePath: string,
  title: string,
  description: string,
  options: UploadOptions = {},
): Promise<string> {
  const youtube = getYouTube();
  // Identity first: a path that resolves is no use if the token points at the
  // wrong channel.
  await verifyChannel();
  const resolved = await resolveUploadPath(filePath);
  const { size } = await fsp.stat(resolved);

  const privacyStatus = options.privacyStatus ?? process.env.YOUTUBE_PRIVACY_STATUS ?? 'private';
  if (!PRIVACY_STATUSES.has(privacyStatus)) {
    // Caught here rather than as an opaque 400 from Google, and defaulting to
    // `private` means a typo can never accidentally publish publicly.
    throw new YouTubePublishError(
      `invalid privacyStatus "${privacyStatus}" (expected private, unlisted, or public)`,
      400,
    );
  }

  let lastLoggedDecile = -1;
  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title,
          description,
          tags: options.tags ?? ['AI', 'Automation', 'Generated'],
          categoryId: options.categoryId ?? '28', // Science & Technology
        },
        status: { privacyStatus, selfDeclaredMadeForKids: false },
      },
      media: { body: fs.createReadStream(resolved) },
    },
    {
      onUploadProgress: (evt) => {
        // Log per decile, not per chunk: a multi-GB upload otherwise emits
        // thousands of lines and buries everything else in the pod log.
        const decile = Math.floor((evt.bytesRead / size) * 10);
        if (decile > lastLoggedDecile) {
          lastLoggedDecile = decile;
          console.log('YouTube upload progress', { percent: decile * 10 });
        }
      },
    },
  );

  const videoId = res.data.id;
  if (!videoId) throw new YouTubePublishError('upload returned no video id', 502);
  return videoId;
}

/**
 * Map a Google API failure onto a status and a message safe to return.
 *
 * Without this every failure is an indistinguishable 502: an expired refresh
 * token, an exhausted daily quota, and a rejected title all look the same to
 * whoever is paging.
 */
export function classifyYouTubeError(error: unknown): { status: number; message: string } {
  if (error instanceof YouTubeNotConfiguredError) return { status: 503, message: error.message };
  if (error instanceof YouTubePublishError) return { status: error.status, message: error.message };

  const err = error as { code?: number; errors?: Array<{ reason?: string }>; message?: string };
  const reason = err?.errors?.[0]?.reason;

  if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded') {
    return { status: 429, message: 'YouTube quota exceeded' };
  }
  if (err?.code === 401 || reason === 'authError') {
    // Refresh tokens are revoked when a password changes or the grant is
    // withdrawn; this needs a human re-consent, not a retry.
    return { status: 503, message: 'YouTube credentials rejected — re-authorization required' };
  }
  if (err?.code === 403) return { status: 403, message: 'YouTube rejected the request' };
  return { status: 502, message: 'YouTube upload failed' };
}
