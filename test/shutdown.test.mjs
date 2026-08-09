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

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('TTY first SIGINT drains and second SIGINT forces with two signals', () => {
  const first = transition(initialState(true), ShutdownTrigger.Sigint);
  assert.equal(first.action, ShutdownAction.BeginGraceful);
  assert.equal(first.showForceHint, true);
  assert.equal(first.state.signalCount, 1);

  const second = transition(first.state, ShutdownTrigger.Sigint);
  assert.equal(second.action, ShutdownAction.Force);
  assert.equal(second.state.phase, ShutdownPhase.Forcing);
  assert.equal(second.state.signalCount, 2);
});

test('installing the controller leaves TTY stdin untouched until SIGINT', async () => {
  const processRef = new EventEmitter();
  const stdin = stdinWithTTY(true);
  const drain = deferred();
  const controller = installShutdownHandlers({
    processRef,
    stdin,
    logger: logger(),
    graceMs: 5_000,
    graceful: async () => drain.promise,
    force: async () => undefined,
  });

  assert.equal(stdin.readableFlowing, null);
  assert.equal(stdin.listenerCount('end'), 0);
  stdin.emit('end');
  await tick();
  assert.equal(controller.state.phase, ShutdownPhase.Running);

  processRef.emit('SIGINT');
  await tick();
  assert.equal(controller.state.phase, ShutdownPhase.Draining);
  assert.equal(stdin.listenerCount('end'), 1);
  assert.equal(stdin.readableFlowing, true);
  controller.dispose();
  drain.resolve();
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
  await tick();
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
  assert.equal(
    logs.find((entry) => entry.fields.event === 'shutdown_forced').fields.signal_count,
    2,
  );
});

test('TTY Ctrl-D after first SIGINT is alternate force action, not a signal', async () => {
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
    graceful: async () => drain.promise,
    force: async (trigger) => calls.push(trigger),
  });

  processRef.emit('SIGINT');
  await tick();
  stdin.end();

  const outcome = await controller.completion;
  drain.resolve();
  assert.equal(outcome.forced, true);
  assert.equal(outcome.trigger, ShutdownTrigger.StdinEof);
  assert.deepEqual(calls, [ShutdownTrigger.StdinEof]);
  assert.equal(
    logs.find((entry) => entry.fields.event === 'shutdown_forced').fields.signal_count,
    1,
  );
});

test('TTY SIGTERM needs one signal and never arms stdin EOF', async () => {
  const processRef = new EventEmitter();
  const stdin = stdinWithTTY(true);
  const logs = [];
  const controller = installShutdownHandlers({
    processRef,
    stdin,
    logger: logger(logs),
    graceful: async () => undefined,
    force: async () => assert.fail('must not force'),
  });

  processRef.emit('SIGTERM');
  const outcome = await controller.completion;
  assert.deepEqual(outcome, {
    forced: false,
    trigger: ShutdownTrigger.Sigterm,
    failed: false,
  });
  assert.equal(stdin.listenerCount('end'), 0);
  assert.equal(stdin.readableFlowing, null);
  assert.equal(
    logs.find((entry) => entry.fields.event === 'shutdown_requested').fields.signal_count,
    1,
  );
});

test('non-TTY SIGTERM needs one signal and completes gracefully', async () => {
  const processRef = new EventEmitter();
  const stdin = stdinWithTTY(false);
  let flushCount = 0;
  const logs = [];

  const controller = installShutdownHandlers({
    processRef,
    stdin,
    logger: logger(logs),
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
  assert.equal(stdin.listenerCount('end'), 0);
  assert.equal(stdin.readableFlowing, null);
  assert.equal(
    logs.find((entry) => entry.fields.event === 'shutdown_complete').fields.signal_count,
    1,
  );
});

test('grace deadline force-closes a stalled non-TTY drain', async () => {
  const processRef = new EventEmitter();
  const stdin = stdinWithTTY(false);
  const drain = deferred();
  const calls = [];
  const logs = [];
  const keepAlive = setTimeout(() => undefined, 1_000);

  try {
    const controller = installShutdownHandlers({
      processRef,
      stdin,
      logger: logger(logs),
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
    assert.equal(
      logs.find((entry) => entry.fields.event === 'shutdown_forced').fields.signal_count,
      1,
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test('force and telemetry hooks that never settle are bounded', async () => {
  const processRef = new EventEmitter();
  const stdin = stdinWithTTY(true);
  const never = new Promise(() => undefined);
  const controller = installShutdownHandlers({
    processRef,
    stdin,
    logger: logger(),
    graceMs: 5_000,
    forceMs: 5,
    graceful: async () => never,
    force: async () => never,
    flush: async () => never,
  });

  processRef.emit('SIGINT');
  await tick();
  processRef.emit('SIGINT');
  const outcome = await controller.completion;
  assert.equal(outcome.forced, true);
  assert.equal(outcome.failed, true);
});
