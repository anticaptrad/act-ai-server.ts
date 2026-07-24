// OpenTelemetry bootstrap. Imported for its side effects as the very first thing
// in the process (see index.ts) so auto-instrumentation can patch modules before
// they are required. Console tracing is used by default; OTLP export is enabled
// when OTEL_EXPORTER_OTLP_ENDPOINT is set (the collector in the k8s cluster).
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const traceExporter = otlpEndpoint
  ? new OTLPTraceExporter()
  : new ConsoleSpanExporter();

const sdk = new NodeSDK({
  traceExporter,
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

/** Flush and shut down the tracer so buffered spans are exported on exit. */
export async function shutdownTelemetry(): Promise<void> {
  try {
    await sdk.shutdown();
  } catch (err) {
    console.error('OpenTelemetry shutdown error', err);
  }
}
