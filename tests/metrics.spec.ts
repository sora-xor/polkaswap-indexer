import { afterEach, describe, expect, it } from 'vitest';

import { metrics } from '../src/metrics.js';

describe('metrics registry', () => {
  afterEach(() => {
    metrics.reset();
  });

  it('renders counters, gauges, and summaries in Prometheus text format', () => {
    metrics.increment('indexer_http_requests_total', { method: 'POST', path: '/graphql', status: 200 });
    metrics.setGauge('postgres_query_pool_waiting', {}, 3);
    metrics.observe('indexer_http_request_duration_seconds', { method: 'POST', path: '/graphql', status: 200 }, 0.25);

    const output = metrics.render();

    expect(output).toContain('indexer_http_requests_total{method="POST",path="/graphql",status="200"} 1');
    expect(output).toContain('postgres_query_pool_waiting 3');
    expect(output).toContain(
      'indexer_http_request_duration_seconds_count{method="POST",path="/graphql",status="200"} 1'
    );
    expect(output).toContain(
      'indexer_http_request_duration_seconds_sum{method="POST",path="/graphql",status="200"} 0.25'
    );
  });
});
