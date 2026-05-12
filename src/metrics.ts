type Labels = Record<string, string | number | boolean | null | undefined>;

type MetricSample = {
  name: string;
  labels: Record<string, string>;
};

type SummaryValue = {
  count: number;
  sum: number;
  max: number;
};

const counters = new Map<string, MetricSample & { value: number }>();
const gauges = new Map<string, MetricSample & { value: number }>();
const summaries = new Map<string, MetricSample & SummaryValue>();

const sanitizeMetricName = (name: string): string => name.replace(/[^A-Za-z0-9_:]/g, '_');

const normalizeLabels = (labels: Labels = {}): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== null && entry[1] !== undefined)
      .map(([key, value]) => [key.replace(/[^A-Za-z0-9_]/g, '_'), String(value)])
      .sort(([left], [right]) => left.localeCompare(right))
  );

const sampleKey = (name: string, labels: Labels = {}): string => {
  const normalizedLabels = normalizeLabels(labels);

  return JSON.stringify([sanitizeMetricName(name), normalizedLabels]);
};

const getOrCreateSample = <T extends { value: number }>(
  storage: Map<string, MetricSample & T>,
  name: string,
  labels: Labels,
  initial: T
): MetricSample & T => {
  const key = sampleKey(name, labels);
  const existing = storage.get(key);
  if (existing) return existing;

  const sample = {
    name: sanitizeMetricName(name),
    labels: normalizeLabels(labels),
    ...initial,
  };
  storage.set(key, sample);

  return sample;
};

const formatLabels = (labels: Record<string, string>): string => {
  const entries = Object.entries(labels);
  if (!entries.length) return '';

  const serialized = entries
    .map(([key, value]) => `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');

  return `{${serialized}}`;
};

export const metrics = {
  increment(name: string, labels: Labels = {}, value = 1): void {
    getOrCreateSample(counters, name, labels, { value: 0 }).value += value;
  },

  setGauge(name: string, labels: Labels = {}, value: number): void {
    getOrCreateSample(gauges, name, labels, { value: 0 }).value = Number.isFinite(value) ? value : 0;
  },

  observe(name: string, labels: Labels = {}, value: number): void {
    const key = sampleKey(name, labels);
    const sample = summaries.get(key) ?? {
      name: sanitizeMetricName(name),
      labels: normalizeLabels(labels),
      count: 0,
      sum: 0,
      max: 0,
    };
    const finiteValue = Number.isFinite(value) ? value : 0;

    sample.count += 1;
    sample.sum += finiteValue;
    sample.max = Math.max(sample.max, finiteValue);
    summaries.set(key, sample);
  },

  render(): string {
    const lines: string[] = [];

    for (const sample of [...counters.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      lines.push(`${sample.name}${formatLabels(sample.labels)} ${sample.value}`);
    }

    for (const sample of [...gauges.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      lines.push(`${sample.name}${formatLabels(sample.labels)} ${sample.value}`);
    }

    for (const sample of [...summaries.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      const labels = formatLabels(sample.labels);
      lines.push(`${sample.name}_count${labels} ${sample.count}`);
      lines.push(`${sample.name}_sum${labels} ${sample.sum}`);
      lines.push(`${sample.name}_max${labels} ${sample.max}`);
    }

    return `${lines.join('\n')}\n`;
  },

  reset(): void {
    counters.clear();
    gauges.clear();
    summaries.clear();
  },
};
