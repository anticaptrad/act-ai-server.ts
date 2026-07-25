// Containment of the upload directory.
//
// `/api/publish/youtube` takes `filePath` from a request body, so without this
// boundary the endpoint is an arbitrary-file-read primitive: any file the
// process can open could be named and streamed to an external platform.
//
// These run against the compiled module with no credentials, so the boundary is
// verified in every environment — the end-to-end suite can only exercise it
// where YouTube is actually configured.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let root;
let outside;
let resolveUploadPath;
let YouTubePublishError;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'act-uploads-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'act-outside-'));

  await fs.writeFile(path.join(root, 'render.mp4'), 'video-bytes');
  await fs.writeFile(path.join(root, 'notes.txt'), 'not a video');
  await fs.writeFile(path.join(root, 'empty.mp4'), '');
  await fs.mkdir(path.join(root, 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'nested', 'deep.mp4'), 'video-bytes');
  await fs.writeFile(path.join(outside, 'secret.mp4'), 'SENSITIVE');

  // A symlink *inside* the upload root pointing out of it. This is the case a
  // string-prefix check misses and `realpath` catches.
  await fs.symlink(path.join(outside, 'secret.mp4'), path.join(root, 'escape.mp4'));

  // The module reads the root at import time.
  process.env.YOUTUBE_UPLOAD_DIR = root;
  ({ resolveUploadPath, YouTubePublishError } = await import('../dist/youtube.js'));
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

/** Resolve and return the thrown error, asserting that one was thrown. */
async function rejection(filePath) {
  try {
    await resolveUploadPath(filePath);
  } catch (err) {
    return err;
  }
  assert.fail(`${filePath} was accepted but should have been refused`);
}

describe('paths inside the upload directory resolve', () => {
  test('a plain filename resolves', async () => {
    const resolved = await resolveUploadPath('render.mp4');
    assert.equal(resolved, path.join(await fs.realpath(root), 'render.mp4'));
  });

  test('a nested path resolves', async () => {
    const resolved = await resolveUploadPath('nested/deep.mp4');
    assert.ok(resolved.endsWith(path.join('nested', 'deep.mp4')));
  });

  test('an absolute path inside the root resolves', async () => {
    const resolved = await resolveUploadPath(path.join(root, 'render.mp4'));
    assert.ok(resolved.endsWith('render.mp4'));
  });
});

describe('paths outside the upload directory are refused', () => {
  const escapes = [
    ['a parent traversal', '../../../../etc/passwd'],
    ['an absolute host path', '/etc/passwd'],
    ['a traversal buried mid-path', 'nested/../../../../etc/passwd'],
    ['an absolute path into another temp dir', null], // filled in below
  ];

  test('traversal and absolute escapes are refused', async () => {
    for (const [label, candidate] of escapes) {
      const filePath = candidate ?? path.join(outside, 'secret.mp4');
      const err = await rejection(filePath);
      assert.ok(
        err instanceof YouTubePublishError,
        `${label}: expected a YouTubePublishError, got ${err?.name}`,
      );
      assert.ok(err.status >= 400 && err.status < 500, `${label}: expected 4xx`);
    }
  });

  test('a symlink pointing out of the root is refused', async () => {
    // The link lives inside the root, so a string-prefix containment check
    // passes it. Resolving symlinks first is what makes the boundary sound.
    const err = await rejection('escape.mp4');
    assert.equal(err.status, 400);
    assert.match(err.message, /outside the upload directory/i);
  });

  test('the refusal does not echo the resolved host path', async () => {
    const err = await rejection('/etc/passwd');
    assert.ok(
      !err.message.includes('/etc/passwd'),
      `error echoed the probed path: ${err.message}`,
    );
  });
});

describe('file shape is validated', () => {
  test('a missing file is a 404', async () => {
    const err = await rejection('does-not-exist.mp4');
    assert.equal(err.status, 404);
  });

  test('a directory is refused', async () => {
    const err = await rejection('nested');
    assert.equal(err.status, 400);
  });

  test('an empty file is refused', async () => {
    const err = await rejection('empty.mp4');
    assert.equal(err.status, 400);
    assert.match(err.message, /empty/i);
  });

  test('an unsupported extension is refused', async () => {
    const err = await rejection('notes.txt');
    assert.equal(err.status, 415);
  });

  test('extension matching is case-insensitive', async () => {
    await fs.writeFile(path.join(root, 'upper.MP4'), 'video-bytes');
    const resolved = await resolveUploadPath('upper.MP4');
    assert.ok(resolved.endsWith('upper.MP4'));
  });
});
