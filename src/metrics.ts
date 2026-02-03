import http from 'http';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

const registry = new Registry();
collectDefaultMetrics({ register: registry });

const messagesTotal = new Counter({
  name: 'dotclaw_messages_total',
  help: 'Total messages processed',
  labelNames: ['source']
});

const errorsTotal = new Counter({
  name: 'dotclaw_errors_total',
  help: 'Total errors',
  labelNames: ['type']
});

const toolCallsTotal = new Counter({
  name: 'dotclaw_tool_calls_total',
  help: 'Total tool calls',
  labelNames: ['tool', 'ok']
});

const taskRunsTotal = new Counter({
  name: 'dotclaw_task_runs_total',
  help: 'Total scheduled task runs',
  labelNames: ['status']
});

const responseLatency = new Histogram({
  name: 'dotclaw_response_latency_ms',
  help: 'Agent response latency in ms',
  buckets: [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]
});

registry.registerMetric(messagesTotal);
registry.registerMetric(errorsTotal);
registry.registerMetric(toolCallsTotal);
registry.registerMetric(taskRunsTotal);
registry.registerMetric(responseLatency);

export function recordMessage(source: 'telegram' | 'scheduler'): void {
  messagesTotal.inc({ source });
}

export function recordError(type: string): void {
  errorsTotal.inc({ type });
}

export function recordToolCall(tool: string, ok: boolean): void {
  toolCallsTotal.inc({ tool, ok: ok ? 'true' : 'false' });
}

export function recordTaskRun(status: 'success' | 'error'): void {
  taskRunsTotal.inc({ status });
}

export function recordLatency(ms: number): void {
  if (Number.isFinite(ms)) responseLatency.observe(ms);
}

export function startMetricsServer(): void {
  const port = parseInt(process.env.DOTCLAW_METRICS_PORT || '3001', 10);
  const server = http.createServer(async (_req, res) => {
    try {
      const metrics = await registry.metrics();
      res.writeHead(200, { 'Content-Type': registry.contentType });
      res.end(metrics);
    } catch {
      res.writeHead(500);
      res.end('metrics error');
    }
  });
  server.listen(port, () => {
    console.log(`Metrics server listening on :${port}`);
  });
}
