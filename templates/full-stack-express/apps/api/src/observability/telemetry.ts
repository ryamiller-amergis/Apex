import type { IncomingMessage } from 'node:http';
import {
  context,
  diag,
  DiagLogLevel,
  metrics,
  propagation,
  trace,
  type DiagLogger,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  ExportResultCode,
  setGlobalErrorHandler,
  W3CTraceContextPropagator,
  type ExportResult,
} from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  registerInstrumentations,
  type Instrumentation,
} from '@opentelemetry/instrumentation';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  TracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace';
import type { TelemetryEnv } from '../config/env.ts';
import { PROBE_PATHS } from './requestLogging.ts';
import { requestPath } from './redaction.ts';

export type ExporterName = 'otlp' | 'console' | 'none';
export type TelemetrySignal = 'traces' | 'metrics';

export interface TelemetryPlan {
  enabled: boolean;
  reason?: 'OTEL_SDK_DISABLED' | 'no exporter configured';
  traces: ExporterName;
  metrics: ExporterName;
  tracesUrl?: string;
  metricsUrl?: string;
  headers: Record<string, string>;
  timeoutMillis?: number;
}

export interface TelemetryHandle {
  enabled: boolean;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface TelemetryLogger {
  info(fields: object, msg: string): void;
  warn(fields: object, msg: string): void;
}

export interface TelemetryOptions {
  logger?: TelemetryLogger;
  /** Replaces the exporter of a signal the environment enables. For tests. */
  exporters?: { traces?: SpanExporter; metrics?: PushMetricExporter };
}

interface RateLimitOptions {
  windowMs?: number;
  now?: () => number;
}

const FAILURE_LOG_WINDOW_MS = 60000;
const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60000;
const DEFAULT_METRIC_EXPORT_TIMEOUT_MS = 30000;

const silentLogger: TelemetryLogger = {
  info() {},
  warn() {},
};

const disabledHandle: TelemetryHandle = {
  enabled: false,
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

let active: TelemetryHandle = disabledHandle;

/** The handle instrument.ts started, or a disabled handle. */
export function activeTelemetry(): TelemetryHandle {
  return active;
}

function signalUrl(base: string | undefined, signal: TelemetrySignal) {
  if (!base) {
    return undefined;
  }
  const withSlash = base.endsWith('/') ? base : `${base}/`;
  return new URL(`v1/${signal}`, withSlash).toString();
}

function parseHeaders(value: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of value?.split(',') ?? []) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      headers[pair.slice(0, eq).trim()] = decodeURIComponent(
        pair.slice(eq + 1).trim()
      );
    }
  }
  return headers;
}

function chooseExporter(
  requested: ExporterName | undefined,
  url: string | undefined
): ExporterName {
  const name = requested ?? (url ? 'otlp' : 'none');
  return name === 'otlp' && !url ? 'none' : name;
}

/**
 * Telemetry starts only when OTEL_SDK_DISABLED is not true and an OTLP
 * endpoint is set or an exporter is console. Otherwise the SDK is never
 * constructed and the OpenTelemetry API stays a no-op.
 */
export function resolveTelemetryPlan(env: TelemetryEnv): TelemetryPlan {
  const headers = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  if (env.OTEL_SDK_DISABLED) {
    return {
      enabled: false,
      reason: 'OTEL_SDK_DISABLED',
      traces: 'none',
      metrics: 'none',
      headers,
    };
  }
  const tracesUrl =
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    signalUrl(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'traces');
  const metricsUrl =
    env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
    signalUrl(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'metrics');
  const traces = chooseExporter(env.OTEL_TRACES_EXPORTER, tracesUrl);
  const metricsExporter = chooseExporter(env.OTEL_METRICS_EXPORTER, metricsUrl);
  const enabled = traces !== 'none' || metricsExporter !== 'none';
  return {
    enabled,
    ...(enabled ? {} : { reason: 'no exporter configured' as const }),
    traces,
    metrics: metricsExporter,
    ...(traces === 'otlp' ? { tracesUrl } : {}),
    ...(metricsExporter === 'otlp' ? { metricsUrl } : {}),
    headers,
    ...(env.OTEL_EXPORTER_OTLP_TIMEOUT === undefined
      ? {}
      : { timeoutMillis: env.OTEL_EXPORTER_OTLP_TIMEOUT }),
  };
}

function otlpConfig(plan: TelemetryPlan, url: string | undefined) {
  return {
    url,
    headers: plan.headers,
    ...(plan.timeoutMillis === undefined
      ? {}
      : { timeoutMillis: plan.timeoutMillis }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'export failed';
}

function rateLimited(options: RateLimitOptions) {
  const windowMs = options.windowMs ?? FAILURE_LOG_WINDOW_MS;
  const now = options.now ?? Date.now;
  const lastLogged = new Map<string, number>();
  return (key: string): boolean => {
    const time = now();
    const last = lastLogged.get(key);
    if (last !== undefined && time - last < windowMs) {
      return false;
    }
    lastLogged.set(key, time);
    return true;
  };
}

export function createExportFailureReporter(
  logger: TelemetryLogger,
  options: RateLimitOptions = {}
): (signal: TelemetrySignal, error: unknown) => void {
  const shouldLog = rateLimited(options);
  return (signal, error) => {
    if (shouldLog(signal)) {
      logger.warn(
        {
          signal,
          err: error instanceof Error ? error : new Error(errorMessage(error)),
        },
        'telemetry.export_failed'
      );
    }
  };
}

/**
 * Routes OpenTelemetry diagnostics to the logger at warn. Only the message
 * text is logged: diagnostic arguments can hold exporter configuration.
 */
export function createDiagLogger(
  logger: TelemetryLogger,
  options: RateLimitOptions = {}
): DiagLogger {
  const shouldLog = rateLimited(options);
  const forward = (message: string) => {
    if (shouldLog(message)) {
      logger.warn({ diagnostic: message }, 'telemetry.diagnostic');
    }
  };
  const ignore = () => {};
  return {
    error: forward,
    warn: forward,
    info: ignore,
    debug: ignore,
    verbose: ignore,
  };
}

class ReportingSpanExporter implements SpanExporter {
  private readonly inner: SpanExporter;
  private readonly report: (error: unknown) => void;

  constructor(inner: SpanExporter, report: (error: unknown) => void) {
    this.inner = inner;
    this.report = report;
  }

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      if (result.code !== ExportResultCode.SUCCESS) {
        this.report(result.error);
      }
      done(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

function reportingMetricExporter(
  inner: PushMetricExporter,
  report: (error: unknown) => void
): PushMetricExporter {
  const wrapped: PushMetricExporter = {
    export(batch: ResourceMetrics, done: (result: ExportResult) => void) {
      inner.export(batch, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          report(result.error);
        }
        done(result);
      });
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
  };
  if (inner.selectAggregationTemporality) {
    wrapped.selectAggregationTemporality =
      inner.selectAggregationTemporality.bind(inner);
  }
  if (inner.selectAggregation) {
    wrapped.selectAggregation = inner.selectAggregation.bind(inner);
  }
  return wrapped;
}

/**
 * No request or response headers become span attributes, and pg never puts
 * SQL parameters on spans. Probe requests are not traced.
 */
export function createInstrumentations(): Instrumentation[] {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req: IncomingMessage) =>
        PROBE_PATHS.has(requestPath(req)),
    }),
    new ExpressInstrumentation(),
    new PgInstrumentation({ enhancedDatabaseReporting: false }),
  ];
}

function buildSpanExporter(
  plan: TelemetryPlan,
  override: SpanExporter | undefined
): SpanExporter {
  if (override) {
    return override;
  }
  return plan.traces === 'console'
    ? new ConsoleSpanExporter()
    : new OTLPTraceExporter(otlpConfig(plan, plan.tracesUrl));
}

function buildMetricExporter(
  plan: TelemetryPlan,
  override: PushMetricExporter | undefined
): PushMetricExporter {
  if (override) {
    return override;
  }
  return plan.metrics === 'console'
    ? new ConsoleMetricExporter()
    : new OTLPMetricExporter(otlpConfig(plan, plan.metricsUrl));
}

/**
 * Starts tracing and metrics from validated settings only. Exports run in the
 * SDK's background processors and never block a request. Call once per
 * process, from instrument.ts.
 */
export function startTelemetry(
  env: TelemetryEnv,
  options: TelemetryOptions = {}
): TelemetryHandle {
  const logger = options.logger ?? silentLogger;
  const plan = resolveTelemetryPlan(env);
  if (!plan.enabled) {
    logger.info({ reason: plan.reason }, 'telemetry.disabled');
    active = disabledHandle;
    return disabledHandle;
  }

  const diagLogger = createDiagLogger(logger);
  diag.setLogger(diagLogger, DiagLogLevel.WARN);
  setGlobalErrorHandler((error) => diagLogger.warn(errorMessage(error)));
  const report = createExportFailureReporter(logger);
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const resource = resourceFromAttributes({
    'service.name': env.OTEL_SERVICE_NAME,
  });

  const tracerProvider =
    plan.traces === 'none'
      ? undefined
      : new TracerProvider({
          resource,
          spanProcessors: [
            new BatchSpanProcessor({
              exporter: new ReportingSpanExporter(
                buildSpanExporter(plan, options.exporters?.traces),
                (error) => report('traces', error)
              ),
              ...(env.OTEL_BSP_SCHEDULE_DELAY === undefined
                ? {}
                : { scheduledDelayMillis: env.OTEL_BSP_SCHEDULE_DELAY }),
            }),
          ],
        });
  if (tracerProvider) {
    trace.setGlobalTracerProvider(tracerProvider);
  }

  const interval =
    env.OTEL_METRIC_EXPORT_INTERVAL ?? DEFAULT_METRIC_EXPORT_INTERVAL_MS;
  const meterProvider =
    plan.metrics === 'none'
      ? undefined
      : new MeterProvider({
          resource,
          readers: [
            new PeriodicExportingMetricReader({
              exporter: reportingMetricExporter(
                buildMetricExporter(plan, options.exporters?.metrics),
                (error) => report('metrics', error)
              ),
              exportIntervalMillis: interval,
              exportTimeoutMillis: Math.min(
                interval,
                DEFAULT_METRIC_EXPORT_TIMEOUT_MS
              ),
            }),
          ],
        });
  if (meterProvider) {
    metrics.setGlobalMeterProvider(meterProvider);
  }

  const unregister = registerInstrumentations({
    instrumentations: createInstrumentations(),
    ...(tracerProvider ? { tracerProvider } : {}),
    ...(meterProvider ? { meterProvider } : {}),
  });

  logger.info(
    { traces: plan.traces, metrics: plan.metrics },
    'telemetry.started'
  );

  let stopping: Promise<void> | undefined;
  const handle: TelemetryHandle = {
    enabled: true,
    async forceFlush() {
      await Promise.all([
        tracerProvider?.forceFlush(),
        meterProvider?.forceFlush(),
      ]);
    },
    shutdown() {
      stopping ??= (async () => {
        unregister();
        await Promise.allSettled([
          tracerProvider?.shutdown(),
          meterProvider?.shutdown(),
        ]);
        trace.disable();
        metrics.disable();
        propagation.disable();
        context.disable();
        diag.disable();
        if (active === handle) {
          active = disabledHandle;
        }
      })();
      return stopping;
    },
  };
  active = handle;
  return handle;
}
