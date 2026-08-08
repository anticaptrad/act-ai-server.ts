import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

const {
  ShutdownAction,
  ShutdownPhase,
  ShutdownTrigger,
  initialState,
  installShutdownHandlers,
  transition,
} = await import('../dist/shutdown.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function logger(logs = []) {
  return {
    logs,
    info(fields, message) {
      logs.push({ level: 'info', fields, message });
    },
    warn(fields, message) {
      logs.push({ level: 'warn', fields, message });
    },
    error(fields, message) {
      logs.push({ level: 'error', fields, message });
    },
  };
}

function stdinWithTTY(isTTY) {
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: isTTY });
  return stdin;
}

test('TTY first SIGINT drains and the second SIGINT forces', () => {
  const first = transition(initialState(true), ShutdownTrigger.Sigint);
  assert.equal(first.action, ShutdownAction.BeginGraceful);
  assert.equal(first.showForceHint, true);

  const second = transition(first.state, ShutdownTrigger.Sigint);
  assert.equal(second.action, ShutdownAction.Force);
  assert.equal(second.state.phase, ShutdownPhase.Forcing);
});

test('runtime drains once, force-closes on second SIGINT, and flushes once', async () => {
  const processRef = new EventEmitter();
  const stdin = stdinWithTTY(true);
  const drain = deferred();
  const calls = [];
  const logs = [];

  const controller = installShutdownHandlers({
    processRef,
    stdin,
    logger: logger(logs),
    graceMs: 5_000,
    graceful: async (trigger) => {
      calls.push(`graceful:${trigger}`);
      await drain.promise;
    },
    force: async (trigger) => {
      calls.push(`force:${trigger}`);
    },
    flush: async () => {
      calls.push('flush');
    },
  });

  processRef.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.phase, ShutdownPhase.Draining);
  assert.deepEqual(calls, ['graceful:sigint']);
  assert.equal(
    logs.some((entry) => entry.fields.event === 'shutdown_force_available'),
    true,
  );

  processRef.emit('SIGINT');
  const outcome = await controller.completion;
  drain.resolve();

  assert.deepEqual(outcome, {
    forced: true,
    trigger: ShutdownTrigger.Sigint,
    failed: false,
  });
  assert.deepEqual(calls, ['graceful:sigint', 'force:sigint', 'flush']);
});

test('TTY Ctrl-D after the first SIGINT is the alternate force action', async () => {
  const processRef = new EventEmitter();
  const stdin = stdinWithTTY(true);
  const drain = deferred();
  const calls = [];

  const controller = installShutdownHandlers({
    processRef,
    stdin,
    logger: logger(),
    graceMs: 5_000,
    graceful: async () => drain.promise,
    force: async (trigger) => calls.push(trigger),
  });

  processRef.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  stdin.end();

  const outcome = await controller.completion;
  drain.resolve();
  assert.equal(outcome.forced, true);
  assert.equal(outcome.trigger, ShutdownTrigger.StdinEof);
  assert.deepEqual(calls, [ShutdownTrigger.StdinEof]);
});

test('non-TTY SIGTERM needs one signal and completes gracefully', async () => {
  const processRef = new EventEmitter();
  const stdin = stdinWithTTY(false);
  let flushCount = 0;

  const controller = installShutdownHandlers({
    processRef,
    stdin,
    logger: logger(),
    graceMs: 5_000,
    graceful: async () => undefined,
    force: async () => assert.fail('must not force'),
    flush: async () => {
      flushCount += 1;
    },
  });

  processRef.emit('SIGTERM');
  const outcome = await controller.completion;

  assert.deepEqual(outcome, {
    forced: false,
    trigger: ShutdownTrigger.Sigterm,
    failed: false,
  });
  assert.equal(flushCount, 1);
  assert.equal(controller.state.phase, ShutdownPhase.Complete);
});

test('grace deadline force-closes a stalled non-TTY drain', async () => {
  const processRef = new EventEmitter();
  const stdin = stdinWithTTY(false);
  const drain = deferred();
  const calls = [];
  const keepAlive = setTimeout(() => undefined, 1_000);

  try {
    const controller = installShutdownHandlers({
      processRef,
      stdin,
      logger: logger(),
      graceMs: 20,
      graceful: async () => drain.promise,
      force: async (trigger) => calls.push(trigger),
    });

    processRef.emit('SIGTERM');
    const outcome = await controller.completion;
    drain.resolve();

    assert.equal(outcome.forced, true);
    assert.equal(outcome.trigger, ShutdownTrigger.Timeout);
    assert.deepEqual(calls, [ShutdownTrigger.Timeout]);
  } finally {
    clearTimeout(keepAlive);
  }
});
