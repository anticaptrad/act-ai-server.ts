import process from 'node:process';

export const ShutdownPhase = {
  Running: 'running',
  Draining: 'draining',
  Forcing: 'forcing',
  Complete: 'complete',
} as const;

export type ShutdownPhase = (typeof ShutdownPhase)[keyof typeof ShutdownPhase];

export const ShutdownTrigger = {
  Sigint: 'sigint',
  Sigterm: 'sigterm',
  StdinEof: 'stdin_eof',
  Timeout: 'timeout',
  GracefulComplete: 'graceful_complete',
} as const;

export type ShutdownTrigger = (typeof ShutdownTrigger)[keyof typeof ShutdownTrigger];
export type ShutdownCause = ShutdownTrigger | 'graceful_error' | 'cleanup_error';

export const ShutdownAction = {
  Ignore: 'ignore',
  BeginGraceful: 'begin_graceful',
  Force: 'force',
  Complete: 'complete',
} as const;

export type ShutdownAction = (typeof ShutdownAction)[keyof typeof ShutdownAction];

export interface ShutdownState {
  phase: ShutdownPhase;
  stdinIsTTY: boolean;
  firstTrigger: ShutdownTrigger | null;
  /** Counts operating-system SIGINT/SIGTERM events only. */
  signalCount: number;
}

export interface ShutdownTransition {
  state: ShutdownState;
  action: ShutdownAction;
  showForceHint: boolean;
}

export interface ShutdownOutcome {
  forced: boolean;
  trigger: ShutdownCause;
  failed: boolean;
}

export interface ShutdownLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

interface ShutdownStdin {
  readonly isTTY?: boolean;
  readonly readableFlowing: boolean | null;
  once(event: 'end', listener: () => void): unknown;
  removeListener(event: 'end', listener: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface ShutdownOptions {
  graceful(trigger: ShutdownTrigger): Promise<void>;
  force(trigger: ShutdownCause): Promise<void> | void;
  flush?: () => Promise<void> | void;
  logger: ShutdownLogger;
  graceMs?: number;
  /** Maximum wait for force and telemetry hooks. Defaults to min(graceMs, 5s). */
  forceMs?: number;
  processRef?: SignalSource;
  stdin?: ShutdownStdin;
  onComplete?: (outcome: ShutdownOutcome) => void;
}

export interface ShutdownController {
  begin(trigger: ShutdownTrigger): Promise<ShutdownOutcome>;
  requestForce(trigger: ShutdownTrigger): void;
  readonly state: ShutdownState;
  readonly completion: Promise<ShutdownOutcome> | null;
  dispose(): void;
}

export function initialState(stdinIsTTY: boolean): ShutdownState {
  return {
    phase: ShutdownPhase.Running,
    stdinIsTTY,
    firstTrigger: null,
    signalCount: 0,
  };
}

function isSignal(trigger: ShutdownTrigger): boolean {
  return trigger === ShutdownTrigger.Sigint || trigger === ShutdownTrigger.Sigterm;
}

export function transition(
  state: ShutdownState,
  trigger: ShutdownTrigger,
): ShutdownTransition {
  if (state.phase === ShutdownPhase.Running) {
    if (!isSignal(trigger)) {
      return ignored(state);
    }

    return {
      state: {
        ...state,
        phase: ShutdownPhase.Draining,
        firstTrigger: trigger,
        signalCount: state.signalCount + 1,
      },
      action: ShutdownAction.BeginGraceful,
      showForceHint: state.stdinIsTTY && trigger === ShutdownTrigger.Sigint,
    };
  }

  if (state.phase === ShutdownPhase.Draining) {
    if (trigger === ShutdownTrigger.GracefulComplete) {
      return {
        state: { ...state, phase: ShutdownPhase.Complete },
        action: ShutdownAction.Complete,
        showForceHint: false,
      };
    }

    const signalForces = isSignal(trigger);
    const eofForces =
      trigger === ShutdownTrigger.StdinEof &&
      state.stdinIsTTY &&
      state.firstTrigger === ShutdownTrigger.Sigint;

    if (trigger === ShutdownTrigger.Timeout || signalForces || eofForces) {
      return {
        state: {
          ...state,
          phase: ShutdownPhase.Forcing,
          signalCount: state.signalCount + (signalForces ? 1 : 0),
        },
        action: ShutdownAction.Force,
        showForceHint: false,
      };
    }
  }

  return ignored(state);
}

function ignored(state: ShutdownState): ShutdownTransition {
  return {
    state,
    action: ShutdownAction.Ignore,
    showForceHint: false,
  };
}

function logFields(
  state: ShutdownState,
  trigger: ShutdownCause,
  graceMs: number,
  forced: boolean,
  event: string,
): Record<string, unknown> {
  return {
    event,
    phase: state.phase,
    trigger,
    stdin_is_tty: state.stdinIsTTY,
    signal_count: state.signalCount,
    grace_ms: graceMs,
    forced,
  };
}

function resolvePositiveMillis(
  logger: ShutdownLogger,
  configured: number | undefined,
  fallback: number,
  field: string,
): number {
  const raw = configured ?? fallback;
  if (Number.isSafeInteger(raw) && raw > 0) {
    return raw;
  }

  logger.warn(
    {
      event: 'shutdown_config_invalid',
      field,
      configured_ms: raw,
      fallback_ms: fallback,
    },
    `${field} must be a positive integer; using the default`,
  );
  return fallback;
}

function errorValue(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      error_stack: error.stack,
    };
  }
  return { error };
}

async function withDeadline<T>(
  operation: string,
  milliseconds: number,
  promise: Promise<T> | T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${operation} exceeded ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function installShutdownHandlers(options: ShutdownOptions): ShutdownController {
  const processRef = options.processRef ?? process;
  const stdin = options.stdin ?? process.stdin;
  const flush = options.flush ?? (() => undefined);
  const onComplete = options.onComplete ?? (() => undefined);
  const graceMs = resolvePositiveMillis(
    options.logger,
    options.graceMs ?? Number(process.env.SHUTDOWN_GRACE_MS ?? 10_000),
    10_000,
    'SHUTDOWN_GRACE_MS',
  );
  const forceMs = resolvePositiveMillis(
    options.logger,
    options.forceMs,
    Math.min(graceMs, 5_000),
    'shutdown force timeout',
  );

  let state = initialState(Boolean(stdin.isTTY));
  let completionPromise: Promise<ShutdownOutcome> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let eofArmed = false;
  let resumedStdin = false;
  let flushPromise: Promise<void> | null = null;
  let resolveForce!: (trigger: ShutdownTrigger) => void;

  const forceRequested = new Promise<ShutdownTrigger>((resolve) => {
    resolveForce = resolve;
  });

  const flushOnce = (): Promise<void> => {
    flushPromise ??= Promise.resolve().then(() => flush());
    return flushPromise;
  };

  const cleanupListeners = () => {
    processRef.removeListener('SIGINT', onSigint);
    processRef.removeListener('SIGTERM', onSigterm);
    if (eofArmed) stdin.removeListener('end', onEof);
    if (resumedStdin && stdin.readableFlowing === true) stdin.pause();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const requestForce = (trigger: ShutdownTrigger) => {
    const next = transition(state, trigger);
    state = next.state;
    if (next.action !== ShutdownAction.Force) return;

    options.logger.warn(
      logFields(state, trigger, graceMs, true, 'shutdown_forced'),
      'forceful shutdown requested; active connections will be dropped',
    );
    resolveForce(trigger);
  };

  const onSigint = () => {
    if (state.phase === ShutdownPhase.Running) void begin(ShutdownTrigger.Sigint);
    else requestForce(ShutdownTrigger.Sigint);
  };

  const onSigterm = () => {
    if (state.phase === ShutdownPhase.Running) void begin(ShutdownTrigger.Sigterm);
    else requestForce(ShutdownTrigger.Sigterm);
  };

  const onEof = () => requestForce(ShutdownTrigger.StdinEof);

  const armInteractiveEof = () => {
    if (eofArmed) return;
    eofArmed = true;
    stdin.once('end', onEof);
    if (stdin.readableFlowing !== true) {
      stdin.resume();
      resumedStdin = true;
    }
  };

  function begin(trigger: ShutdownTrigger): Promise<ShutdownOutcome> {
    if (completionPromise) return completionPromise;

    const first = transition(state, trigger);
    state = first.state;
    if (first.action !== ShutdownAction.BeginGraceful) {
      return Promise.resolve({ forced: false, trigger, failed: false });
    }

    options.logger.info(
      logFields(state, trigger, graceMs, false, 'shutdown_requested'),
      'graceful shutdown requested; listener is closing and active work is draining',
    );

    if (first.showForceHint) {
      options.logger.info(
        logFields(state, trigger, graceMs, false, 'shutdown_force_available'),
        'press Ctrl-C again or Ctrl-D to force shutdown',
      );
      // Deliberately arm stdin only after the first interactive SIGINT.
      armInteractiveEof();
    }

    timer = setTimeout(() => requestForce(ShutdownTrigger.Timeout), graceMs);

    completionPromise = (async () => {
      let forced = false;
      let failed = false;
      let finalTrigger: ShutdownCause = trigger;

      const gracefulResult = Promise.resolve()
        .then(() => options.graceful(trigger))
        .then(
          () => ({ kind: 'graceful' as const }),
          (error: unknown) => ({ kind: 'graceful_error' as const, error }),
        );

      const result = await Promise.race([
        gracefulResult,
        forceRequested.then((forceTrigger) => ({
          kind: 'force' as const,
          trigger: forceTrigger,
        })),
      ]);

      try {
        if (result.kind === 'force') {
          forced = true;
          finalTrigger = result.trigger;
          await withDeadline(
            'force shutdown',
            forceMs,
            options.force(result.trigger),
          );
        } else if (result.kind === 'graceful_error') {
          forced = true;
          failed = true;
          finalTrigger = 'graceful_error';
          state = { ...state, phase: ShutdownPhase.Forcing };
          options.logger.error(
            {
              ...logFields(state, finalTrigger, graceMs, true, 'shutdown_failed'),
              ...errorValue(result.error),
            },
            'graceful shutdown failed; forcing active connections closed',
          );
          await withDeadline(
            'force shutdown',
            forceMs,
            options.force(finalTrigger),
          );
        } else {
          state = transition(state, ShutdownTrigger.GracefulComplete).state;
        }
      } catch (error) {
        failed = true;
        options.logger.error(
          {
            ...logFields(state, finalTrigger, graceMs, forced, 'shutdown_failed'),
            ...errorValue(error),
          },
          'server shutdown operation failed',
        );
      }

      try {
        await withDeadline('telemetry flush', forceMs, flushOnce());
      } catch (error) {
        failed = true;
        finalTrigger = 'cleanup_error';
        options.logger.error(
          {
            ...logFields(state, finalTrigger, graceMs, forced, 'shutdown_failed'),
            ...errorValue(error),
          },
          'shutdown cleanup or telemetry flush failed',
        );
      } finally {
        cleanupListeners();
      }

      state = { ...state, phase: ShutdownPhase.Complete };
      options.logger.info(
        {
          ...logFields(state, finalTrigger, graceMs, forced, 'shutdown_complete'),
          failed,
        },
        forced ? 'forceful shutdown complete' : 'graceful shutdown complete',
      );

      const outcome = { forced, trigger: finalTrigger, failed };
      onComplete(outcome);
      return outcome;
    })();

    return completionPromise;
  }

  processRef.on('SIGINT', onSigint);
  processRef.on('SIGTERM', onSigterm);
  // No stdin listener or resume call is installed here.

  return {
    begin,
    requestForce,
    get state() {
      return { ...state };
    },
    get completion() {
      return completionPromise;
    },
    dispose: cleanupListeners,
  };
}
