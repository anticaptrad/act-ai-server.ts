import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';

const {
  ShutdownPhase,
  ShutdownTrigger,
  installShutdownHandlers,
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

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function closeGracefully(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function timeout(ms, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
}

async function startHangingRequest(t) {
  const requestStarted = deferred();
  const socketClosed = deferred();
  const server = http.createServer((request) => {
    requestStarted.resolve();
    request.socket.once('close', () => socketClosed.resolve());
    // Intentionally leave the response active. Graceful server.close() must
    // wait for it, while closeAllConnections() must terminate its socket.
  });

  await listen(server);
  t.after(() => {
    server.closeAllConnections();
    if (server.listening) {
      server.close();
    }
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');

  let clientError = null;
  const clientFinished = deferred();
  const clientRequest = http.get(
    {
      host: '127.0.0.1',
      port: address.port,
      path: '/hang',
      agent: false,
    },
    (response) => {
      response.resume();
      response.once('end', () => clientFinished.resolve());
    },
  );
  clientRequest.once('error', (error) => {
    clientError = error;
    clientFinished.resolve();
  });

  await Promise.race([
    requestStarted.promise,
    timeout(1_000, 'HTTP request did not become active'),
  ]);

  return {
    server,
    socketClosed,
    clientFinished,
    get clientError() {
      return clientError;
    },
  };
}

test('second interactive SIGINT force-closes a real active HTTP connection', async (t) => {
  const fixture = await startHangingRequest(t);
  const processRef = new EventEmitter();
  const stdin = stdinWithTTY(true);
  const logs = [];

  const controller = installShutdownHandlers({
    processRef,
    stdin,
    logger: logger(logs),
    graceMs: 5_000,
    graceful: () => closeGracefully(fixture.server),
    force: () => fixture.server.closeAllConnections(),
  });

  processRef.emit('SIGINT');
  await nextTurn();

  assert.equal(controller.state.phase, ShutdownPhase.Draining);
  assert.equal(fixture.server.listening, false, 'listener must close on first signal');
  assert.equal(
    logs.some((entry) => entry.fields.event === 'shutdown_force_available'),
    true,
  );

  let completedAfterFirstSignal = false;
  controller.completion.then(() => {
    completedAfterFirstSignal = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(completedAfterFirstSignal, false, 'active request must still be draining');

  processRef.emit('SIGINT');
  const outcome = await Promise.race([
    controller.completion,
    timeout(1_000, 'forced shutdown did not complete'),
  ]);

  assert.deepEqual(outcome, {
    forced: true,
    trigger: ShutdownTrigger.Sigint,
    failed: false,
  });
  await Promise.race([
    fixture.socketClosed.promise,
    timeout(1_000, 'force path did not close the active socket'),
  ]);
  await Promise.race([
    fixture.clientFinished.promise,
    timeout(1_000, 'client did not observe forced connection close'),
  ]);
  assert.ok(fixture.clientError instanceof Error);
});

test('grace deadline force-closes a real active non-TTY HTTP connection', async (t) => {
  const fixture = await startHangingRequest(t);
  const processRef = new EventEmitter();
  const stdin = stdinWithTTY(false);

  const controller = installShutdownHandlers({
    processRef,
    stdin,
    logger: logger(),
    graceMs: 40,
    graceful: () => closeGracefully(fixture.server),
    force: () => fixture.server.closeAllConnections(),
  });

  processRef.emit('SIGTERM');
  const outcome = await Promise.race([
    controller.completion,
    timeout(1_000, 'deadline shutdown did not complete'),
  ]);

  assert.deepEqual(outcome, {
    forced: true,
    trigger: ShutdownTrigger.Timeout,
    failed: false,
  });
  await Promise.race([
    fixture.socketClosed.promise,
    timeout(1_000, 'deadline force path did not close the active socket'),
  ]);
  await Promise.race([
    fixture.clientFinished.promise,
    timeout(1_000, 'client did not observe deadline connection close'),
  ]);
  assert.ok(fixture.clientError instanceof Error);
});
