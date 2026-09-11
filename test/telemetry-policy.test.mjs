import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('OpenTelemetry is explicit and never monkey patches runtime modules', async () => {
  const [telemetry, index, providers, youtube] = await Promise.all([
    source('src/telemetry.ts'),
    source('src/index.ts'),
    source('src/providers.ts'),
    source('src/youtube.ts'),
  ]);

  const runtimeSources = [telemetry, index, providers, youtube].join('\n');

  assert.doesNotMatch(runtimeSources, /@opentelemetry\/auto-instrumentations-node/);
  assert.doesNotMatch(runtimeSources, /\bgetNodeAutoInstrumentations\b/);
  assert.doesNotMatch(telemetry, /\binstrumentations\s*:/);

  assert.match(telemetry, /startActiveSpan/);
  assert.match(providers, /'act\.ai\.script\.generate'/);
  assert.match(youtube, /'act\.youtube\.channel\.verify'/);
  assert.match(youtube, /'act\.youtube\.video\.upload'/);

  // Upstream SDK exception messages can contain request details. The helper
  // records a bounded error class/status instead of the exception payload.
  assert.doesNotMatch(telemetry, /\.recordException\s*\(/);
});
