import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('exports request counts and cumulative duration histogram buckets', () => {
    const metrics = new MetricsService();
    metrics.recordRequest('GET', '/events/:param', 200, 0.008);
    metrics.recordRequest('GET', '/events/:param', 200, 0.02);

    const output = metrics.renderPrometheusMetrics();

    expect(output).toContain(
      'http_requests_total{method="GET",route="/events/:param",status_code="200"} 2',
    );
    expect(output).toContain(
      'http_request_duration_seconds_bucket{method="GET",route="/events/:param",status_code="200",le="0.01"} 1',
    );
    expect(output).toContain(
      'http_request_duration_seconds_bucket{method="GET",route="/events/:param",status_code="200",le="+Inf"} 2',
    );
    expect(output).toContain(
      'http_request_duration_seconds_count{method="GET",route="/events/:param",status_code="200"} 2',
    );
  });

  it('escapes Prometheus label values', () => {
    const metrics = new MetricsService();
    metrics.recordRequest('GE"T', '/line\nbreak', 200, 0.001);

    expect(metrics.renderPrometheusMetrics()).toContain(
      'method="GE\\"T",route="/line\\nbreak"',
    );
  });

  describe('chain indexer metrics (#530)', () => {
    it('reports zeroed counters and no gauges before the first successful poll', () => {
      const metrics = new MetricsService();
      metrics.recordIndexerRun({ success: false });

      const output = metrics.renderPrometheusMetrics();

      expect(output).toContain('indexer_runs_total{result="success"} 0');
      expect(output).toContain('indexer_runs_total{result="failure"} 1');
      expect(output).toContain('indexer_events_applied_total 0');
      expect(output).not.toContain('indexer_lag_ledgers');
      expect(output).not.toContain('indexer_last_success_timestamp_seconds');
    });

    it('accumulates applied events and reports the latest lag', () => {
      const metrics = new MetricsService();
      metrics.recordIndexerRun(
        { success: true, applied: 3, lagLedgers: 120 },
        new Date('2026-11-23T00:00:00Z'),
      );
      metrics.recordIndexerRun(
        { success: true, applied: 2, lagLedgers: 0 },
        new Date('2026-11-23T00:00:30Z'),
      );

      const output = metrics.renderPrometheusMetrics();

      expect(output).toContain('indexer_runs_total{result="success"} 2');
      expect(output).toContain('indexer_events_applied_total 5');
      expect(output).toContain('# TYPE indexer_lag_ledgers gauge');
      expect(output).toContain('indexer_lag_ledgers 0');
      expect(output).toContain(
        `indexer_last_success_timestamp_seconds ${Date.parse('2026-11-23T00:00:30Z') / 1000}`,
      );
    });
  });
});
