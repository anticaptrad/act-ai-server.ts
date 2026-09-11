// Explicit OpenTelemetry bootstrap.
//
// This service deliberately does not register auto-instrumentations. Provider
// SDKs, Fastify, HTTP, filesystem, and Google clients must never be monkey
// patched. High-value operations create explicit spans through `withSpan`, and
// every attribute is selected at the call site so prompts, scripts, OAuth
// material, local paths, titles, and descriptions cannot be captured by an
// instrumentation package unexpectedly.
import {
  type Attributes,
  type Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const traceExporter = otlpEndpoint
  ? new OTLPTraceExporter()
  : new ConsoleSpanExporter();

// Supplying no `instrumentations` is intentional. The SDK only installs the
// tracer provider/exporter; application code owns every span boundary.
const sdk = new NodeSDK({ traceExporter });
sdk.start();

const tracer = trace.getTracer(
  'anticaptrad.act-ai-server',
  process.env.npm_package_version ?? '1.0.0',
);

function errorType(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}

/**
 * Run one operation inside an explicit span.
 *
 * Callers may pass only bounded, non-sensitive metadata. Error messages are not
 * recorded because upstream SDK errors can contain request details; the span
 * carries only the error class and a generic failed status.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await operation(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setAttribute('error.type', errorType(error));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'operation failed',
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Flush and shut down the tracer so buffered spans are exported on exit. */
export async function shutdownTelemetry(): Promise<void> {
  try {
    await sdk.shutdown();
  } catch (err) {
    console.error('OpenTelemetry shutdown error', err);
  }
}
