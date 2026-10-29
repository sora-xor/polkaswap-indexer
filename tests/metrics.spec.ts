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

describe('metrics boundary values', () => {
  afterEach(() => metrics.reset());

  it('escapes line breaks, backslashes, and quotes without creating extra sample lines', () => {
    metrics.increment('requests_total', { detail: 'first\nsecond\\n"quoted"' });
    expect(metrics.render()).toBe('requests_total{detail="first\\nsecond\\\\n\\"quoted\\""} 1\n');
  });

  it('normalizes empty names and names starting with digits into valid identifiers', () => {
    metrics.increment('', { '': 'empty' });
    metrics.increment('9-requests', { '2 labels': true });
    expect(metrics.render()).toContain('_{_="empty"} 1\n');
    expect(metrics.render()).toContain('_9_requests{_2_labels="true"} 1\n');
  });

  it('aggregates equivalent labels independently of insertion order and omits absent labels', () => {
    metrics.increment('requests_total', { z: false, a: 0, missing: null, absent: undefined, empty: '' });
    metrics.increment('requests_total', { empty: '', a: 0, z: false }, 2);
    expect(metrics.render()).toBe('requests_total{a="0",empty="",z="false"} 3\n');
  });

  it('keeps distinct label values in separate series', () => {
    metrics.increment('requests_total', { path: '/one' });
    metrics.increment('requests_total', { path: '/two' }, 2);
    expect(metrics.render().trim().split('\n')).toEqual([
      'requests_total{path="/one"} 1',
      'requests_total{path="/two"} 2',
    ]);
  });

  it.each([NaN, Infinity, -Infinity])('does not poison a counter with %s', (value) => {
    metrics.increment('requests_total', {}, 3);
    metrics.increment('requests_total', {}, value);
    metrics.increment('requests_total');
    expect(metrics.render()).toBe('requests_total 4\n');
  });

  it('keeps counters monotonic when given a negative increment', () => {
    metrics.increment('requests_total', {}, 3);
    metrics.increment('requests_total', {}, -2);
    expect(metrics.render()).toBe('requests_total 3\n');
  });

  it.each([NaN, Infinity, -Infinity])('normalizes a non-finite gauge %s and permits recovery', (value) => {
    metrics.setGauge('queue_depth', {}, value);
    expect(metrics.render()).toBe('queue_depth 0\n');
    metrics.setGauge('queue_depth', {}, -1);
    expect(metrics.render()).toBe('queue_depth -1\n');
  });

  it('reports the actual maximum when all summary observations are negative', () => {
    metrics.observe('offset', {}, -5);
    metrics.observe('offset', {}, -2);
    expect(metrics.render()).toBe('offset_count 2\noffset_sum -7\noffset_max -2\n');
  });

  it('normalizes invalid observations and retains accurate count and sum', () => {
    metrics.observe('duration', {}, 0.25);
    metrics.observe('duration', {}, NaN);
    metrics.observe('duration', {}, Infinity);
    metrics.observe('duration', {}, 0.75);
    expect(metrics.render()).toBe('duration_count 4\nduration_sum 1\nduration_max 0.75\n');
  });

  it('renders cumulative positive overflow using the Prometheus infinity spelling', () => {
    metrics.increment('total', {}, Number.MAX_VALUE);
    metrics.increment('total', {}, Number.MAX_VALUE);
    metrics.observe('size', {}, Number.MAX_VALUE);
    metrics.observe('size', {}, Number.MAX_VALUE);
    expect(metrics.render()).toContain('total +Inf\n');
    expect(metrics.render()).toContain('size_sum +Inf\n');
  });

  it('renders cumulative negative overflow using the Prometheus infinity spelling', () => {
    metrics.observe('offset', {}, -Number.MAX_VALUE);
    metrics.observe('offset', {}, -Number.MAX_VALUE);
    expect(metrics.render()).toContain('offset_sum -Inf\n');
  });

  it('reset clears every metric type and their previous aggregation state', () => {
    metrics.increment('total', {}, 10);
    metrics.setGauge('depth', {}, 8);
    metrics.observe('duration', {}, 3);
    metrics.reset();
    expect(metrics.render()).toBe('\n');
    metrics.increment('total');
    metrics.observe('duration', {}, 1);
    expect(metrics.render()).toBe('total 1\nduration_count 1\nduration_sum 1\nduration_max 1\n');
  });
});
