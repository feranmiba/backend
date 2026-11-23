import { Injectable } from '@nestjs/common';

const HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

interface RequestMetrics {
  method: string;
  route: string;
  statusCode: number;
  count: number;
  durationSeconds: number;
  buckets: number[];
}

/** One chain-indexer poll, as reported by `ChainEventIndexerJob` (#530). */
export type IndexerRun =
  { success: true; applied: number; lagLedgers: number } | { success: false };

@Injectable()
export class MetricsService {
  private readonly requests = new Map<string, RequestMetrics>();
  private readonly indexer = {
    successes: 0,
    failures: 0,
    eventsApplied: 0,
    lagLedgers: null as number | null,
    lastSuccessSeconds: null as number | null,
  };

  recordIndexerRun(run: IndexerRun, now: Date = new Date()): void {
    if (!run.success) {
      this.indexer.failures += 1;
      return;
    }
    this.indexer.successes += 1;
    this.indexer.eventsApplied += run.applied;
    this.indexer.lagLedgers = run.lagLedgers;
    this.indexer.lastSuccessSeconds = Math.floor(now.getTime() / 1000);
  }

  recordRequest(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    const key = JSON.stringify([method, route, statusCode]);
    let metrics = this.requests.get(key);
    if (!metrics) {
      metrics = {
        method,
        route,
        statusCode,
        count: 0,
        durationSeconds: 0,
        buckets: HISTOGRAM_BUCKETS.map(() => 0),
      };
      this.requests.set(key, metrics);
    }

    metrics.count += 1;
    metrics.durationSeconds += durationSeconds;
    HISTOGRAM_BUCKETS.forEach((bucket, index) => {
      if (durationSeconds <= bucket) metrics.buckets[index] += 1;
    });
  }

  renderPrometheusMetrics(): string {
    const lines = [
      '# HELP http_requests_total Total HTTP requests.',
      '# TYPE http_requests_total counter',
    ];

    for (const metrics of this.requests.values()) {
      lines.push(`http_requests_total${this.labels(metrics)} ${metrics.count}`);
    }

    lines.push(
      '# HELP http_request_duration_seconds HTTP request duration in seconds.',
      '# TYPE http_request_duration_seconds histogram',
    );
    for (const metrics of this.requests.values()) {
      HISTOGRAM_BUCKETS.forEach((bucket, index) => {
        lines.push(
          `http_request_duration_seconds_bucket${this.labels(metrics, String(bucket))} ${metrics.buckets[index]}`,
        );
      });
      lines.push(
        `http_request_duration_seconds_bucket${this.labels(metrics, '+Inf')} ${metrics.count}`,
        `http_request_duration_seconds_sum${this.labels(metrics)} ${metrics.durationSeconds}`,
        `http_request_duration_seconds_count${this.labels(metrics)} ${metrics.count}`,
      );
    }

    lines.push(...this.renderIndexerMetrics());

    return `${lines.join('\n')}\n`;
  }

  private renderIndexerMetrics(): string[] {
    const {
      successes,
      failures,
      eventsApplied,
      lagLedgers,
      lastSuccessSeconds,
    } = this.indexer;
    const lines = [
      '# HELP indexer_runs_total Chain event indexer polls, by result.',
      '# TYPE indexer_runs_total counter',
      `indexer_runs_total{result="success"} ${successes}`,
      `indexer_runs_total{result="failure"} ${failures}`,
      '# HELP indexer_events_applied_total Chain events the indexer applied to the database.',
      '# TYPE indexer_events_applied_total counter',
      `indexer_events_applied_total ${eventsApplied}`,
    ];
    // Gauges only appear after a successful poll, so a lag of 0 always means
    // "caught up" and never "has not run".
    if (lagLedgers !== null && lastSuccessSeconds !== null) {
      lines.push(
        '# HELP indexer_lag_ledgers Ledgers between the last indexed event and the RPC latest ledger.',
        '# TYPE indexer_lag_ledgers gauge',
        `indexer_lag_ledgers ${lagLedgers}`,
        '# HELP indexer_last_success_timestamp_seconds Unix time of the last successful indexer poll.',
        '# TYPE indexer_last_success_timestamp_seconds gauge',
        `indexer_last_success_timestamp_seconds ${lastSuccessSeconds}`,
      );
    }
    return lines;
  }

  private labels(metrics: RequestMetrics, le?: string): string {
    const labels = [
      `method="${this.escapeLabel(metrics.method)}"`,
      `route="${this.escapeLabel(metrics.route)}"`,
      `status_code="${metrics.statusCode}"`,
      ...(le === undefined ? [] : [`le="${le}"`]),
    ];
    return `{${labels.join(',')}}`;
  }

  private escapeLabel(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/"/g, '\\"');
  }
}
