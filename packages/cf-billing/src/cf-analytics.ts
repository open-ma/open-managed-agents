const CF_GQL = "https://api.cloudflare.com/client/v4/graphql";

export interface CfPricing {
  workers: { requests: number; cpu_ms: number };
  durable_objects: { requests: number; duration_gb_s: number; sql_read: number; sql_write: number; storage_gb: number };
  kv: { read: number; write: number; storage_gb: number };
  r2: { class_a: number; class_b: number; storage_gb: number };
  d1: { read: number; write: number; storage_gb: number };
  workers_ai: { neurons: number };
  browser_rendering: { hour: number };
  containers: { cpu_vcpu_s: number; mem_gib_s: number };
}

export interface CfIncluded {
  workers: { requests: number; cpu_ms: number };
  durable_objects: { requests: number; duration_gb_s: number; sql_read: number; sql_write: number; storage_gb: number };
  kv: { read: number; write: number; storage_gb: number };
  r2: { class_a: number; class_b: number; storage_gb: number };
  d1: { read: number; write: number; storage_gb: number };
  browser_rendering: { hours: number };
  containers: { cpu_vcpu_min: number; mem_gib_h: number };
}

export const DEFAULT_PRICING: CfPricing = {
  workers: { requests: 0.30, cpu_ms: 0.02 },
  durable_objects: { requests: 0.15, duration_gb_s: 12.50, sql_read: 0.001, sql_write: 1.00, storage_gb: 0.20 },
  kv: { read: 0.50, write: 5.00, storage_gb: 0.50 },
  r2: { class_a: 4.50, class_b: 0.36, storage_gb: 0.015 },
  d1: { read: 0.001, write: 1.00, storage_gb: 0.75 },
  workers_ai: { neurons: 0.011 },
  browser_rendering: { hour: 0.09 },
  containers: { cpu_vcpu_s: 0.000020, mem_gib_s: 0.0000025 },
};

export const INCLUDED: CfIncluded = {
  workers: { requests: 10_000_000, cpu_ms: 30_000_000 },
  durable_objects: { requests: 1_000_000, duration_gb_s: 400_000, sql_read: 25_000_000_000, sql_write: 50_000_000, storage_gb: 5 },
  kv: { read: 10_000_000, write: 1_000_000, storage_gb: 1 },
  r2: { class_a: 1_000_000, class_b: 10_000_000, storage_gb: 10 },
  d1: { read: 25_000_000_000, write: 50_000_000, storage_gb: 5 },
  browser_rendering: { hours: 10 },
  containers: { cpu_vcpu_min: 375, mem_gib_h: 25 },
};

function overage(used: number, included: number): number {
  return Math.max(0, used - included);
}

function overageCostPerM(used: number, included: number, pricePerM: number): number {
  return (overage(used, included) / 1_000_000) * pricePerM;
}

interface GqlResponse<T = unknown> {
  data?: { viewer?: { accounts?: T[] } };
  errors?: Array<{ message: string }>;
}

async function gql<T>(accountId: string, token: string, query: string): Promise<T | null> {
  const res = await fetch(CF_GQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as GqlResponse<T>;
  if (json.errors?.length) return null;
  return json.data?.viewer?.accounts?.[0] ?? null;
}

function dateRange(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  return { start: start.toISOString().split("T")[0], end: end.toISOString().split("T")[0] };
}

// ── Per-service query + cost ────────────────────────────────

export interface ServiceCost {
  usage: Record<string, number>;
  included: Record<string, number>;
  cost: number;
  breakdown?: Array<Record<string, unknown>>;
}

async function queryWorkers(acct: string, token: string, days: number, pricing: CfPricing): Promise<ServiceCost> {
  const { start, end } = dateRange(days);
  const data = await gql<{
    workersInvocationsAdaptive: Array<{ sum: { requests: number; errors: number; subrequests: number }; quantiles: { cpuTimeP50: number; cpuTimeP99: number }; dimensions: { scriptName: string } }>;
  }>(acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { workersInvocationsAdaptive(filter:{date_geq:"${start}",date_leq:"${end}"},limit:10000) { sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { scriptName } } } } }`);

  const rows = data?.workersInvocationsAdaptive ?? [];
  const requests = rows.reduce((s, r) => s + r.sum.requests, 0);
  const errors = rows.reduce((s, r) => s + r.sum.errors, 0);

  const byScript = new Map<string, { requests: number; errors: number; cpuP50: number; cpuP99: number }>();
  for (const r of rows) {
    const key = r.dimensions.scriptName;
    const prev = byScript.get(key) ?? { requests: 0, errors: 0, cpuP50: 0, cpuP99: 0 };
    prev.requests += r.sum.requests;
    prev.errors += r.sum.errors;
    prev.cpuP50 = Math.max(prev.cpuP50, r.quantiles.cpuTimeP50);
    prev.cpuP99 = Math.max(prev.cpuP99, r.quantiles.cpuTimeP99);
    byScript.set(key, prev);
  }

  return {
    usage: { requests, errors },
    included: { requests: INCLUDED.workers.requests },
    cost: overageCostPerM(requests, INCLUDED.workers.requests, pricing.workers.requests),
    breakdown: [...byScript.entries()]
      .sort((a, b) => b[1].requests - a[1].requests)
      .map(([script, v]) => ({ script, ...v })),
  };
}

async function queryDurableObjects(acct: string, token: string, days: number, pricing: CfPricing): Promise<ServiceCost> {
  const { start, end } = dateRange(days);
  const [inv, periodic, storage, sql] = await Promise.all([
    gql<{ durableObjectsInvocationsAdaptiveGroups: Array<{ sum: { requests: number }; dimensions: { objectName: string } }> }>(
      acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { durableObjectsInvocationsAdaptiveGroups(filter:{date_geq:"${start}",date_leq:"${end}"},limit:10000) { sum { requests } dimensions { objectName } } } } }`),
    gql<{ durableObjectsPeriodicGroups: Array<{ sum: { cpuTime: number }; max: { wallTime: number; activeTime: number } }> }>(
      acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { durableObjectsPeriodicGroups(filter:{date_geq:"${start}",date_leq:"${end}"},limit:10000) { sum { cpuTime } max { wallTime activeTime } } } } }`),
    gql<{ durableObjectsStorageGroups: Array<{ max: { storedBytes: number } }> }>(
      acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { durableObjectsStorageGroups(filter:{date_geq:"${start}",date_leq:"${end}"},limit:10000) { max { storedBytes } } } } }`),
    gql<{ durableObjectsSqlStorageGroups: Array<{ sum: { rowsRead: number; rowsWritten: number }; max: { databaseSizeBytes: number } }> }>(
      acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { durableObjectsSqlStorageGroups(filter:{date_geq:"${start}",date_leq:"${end}"},limit:10000) { sum { rowsRead rowsWritten } max { databaseSizeBytes } } } } }`),
  ]);

  const requests = inv?.durableObjectsInvocationsAdaptiveGroups?.reduce((s, r) => s + r.sum.requests, 0) ?? 0;
  const sqlReads = sql?.durableObjectsSqlStorageGroups?.reduce((s, r) => s + r.sum.rowsRead, 0) ?? 0;
  const sqlWrites = sql?.durableObjectsSqlStorageGroups?.reduce((s, r) => s + r.sum.rowsWritten, 0) ?? 0;
  const storageBytes = Math.max(...(storage?.durableObjectsStorageGroups?.map(r => r.max.storedBytes) ?? [0]), 0);
  const sqlSizeBytes = Math.max(...(sql?.durableObjectsSqlStorageGroups?.map(r => r.max.databaseSizeBytes) ?? [0]), 0);
  const storedGB = (storageBytes + sqlSizeBytes) / (1024 ** 3);

  const cost =
    overageCostPerM(requests, INCLUDED.durable_objects.requests, pricing.durable_objects.requests) +
    overageCostPerM(sqlReads, INCLUDED.durable_objects.sql_read, pricing.durable_objects.sql_read) +
    overageCostPerM(sqlWrites, INCLUDED.durable_objects.sql_write, pricing.durable_objects.sql_write) +
    Math.max(0, storedGB - INCLUDED.durable_objects.storage_gb) * pricing.durable_objects.storage_gb;

  return {
    usage: { requests, sql_reads: sqlReads, sql_writes: sqlWrites, storage_gb: +storedGB.toFixed(4) },
    included: { requests: INCLUDED.durable_objects.requests, sql_reads: INCLUDED.durable_objects.sql_read, sql_writes: INCLUDED.durable_objects.sql_write, storage_gb: INCLUDED.durable_objects.storage_gb },
    cost,
  };
}

async function queryKV(acct: string, token: string, days: number, pricing: CfPricing): Promise<ServiceCost> {
  const { start, end } = dateRange(days);
  const [ops, store] = await Promise.all([
    gql<{ kvOperationsAdaptiveGroups: Array<{ sum: { requests: number }; dimensions: { actionType: string } }> }>(
      acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { kvOperationsAdaptiveGroups(filter:{date_geq:"${start}",date_leq:"${end}"},limit:10000) { sum { requests } dimensions { actionType } } } } }`),
    gql<{ kvStorageAdaptiveGroups: Array<{ max: { byteCount: number } }> }>(
      acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { kvStorageAdaptiveGroups(filter:{date_geq:"${start}",date_leq:"${end}"},limit:10) { max { byteCount } } } } }`),
  ]);

  let reads = 0, writes = 0;
  for (const r of ops?.kvOperationsAdaptiveGroups ?? []) {
    if (r.dimensions.actionType === "read") reads += r.sum.requests;
    else writes += r.sum.requests;
  }
  const storageGB = Math.max(...(store?.kvStorageAdaptiveGroups?.map(r => r.max.byteCount) ?? [0]), 0) / (1024 ** 3);

  return {
    usage: { reads, writes, storage_gb: +storageGB.toFixed(4) },
    included: { reads: INCLUDED.kv.read, writes: INCLUDED.kv.write, storage_gb: INCLUDED.kv.storage_gb },
    cost:
      overageCostPerM(reads, INCLUDED.kv.read, pricing.kv.read) +
      overageCostPerM(writes, INCLUDED.kv.write, pricing.kv.write) +
      Math.max(0, storageGB - INCLUDED.kv.storage_gb) * pricing.kv.storage_gb,
  };
}

async function queryR2(acct: string, token: string, days: number, pricing: CfPricing): Promise<ServiceCost> {
  const { start, end } = dateRange(days);
  const [ops, store] = await Promise.all([
    gql<{ r2OperationsAdaptiveGroups: Array<{ sum: { requests: number }; dimensions: { actionType: string; bucketName: string } }> }>(
      acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { r2OperationsAdaptiveGroups(filter:{date_geq:"${start}",date_leq:"${end}"},limit:10000) { sum { requests } dimensions { actionType bucketName } } } } }`),
    gql<{ r2StorageAdaptiveGroups: Array<{ max: { payloadSize: number; objectCount: number }; dimensions: { bucketName: string } }> }>(
      acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { r2StorageAdaptiveGroups(filter:{date_geq:"${start}",date_leq:"${end}"},limit:100) { max { payloadSize objectCount } dimensions { bucketName } } } } }`),
  ]);

  let classA = 0, classB = 0;
  const bucketOps = new Map<string, number>();
  for (const r of ops?.r2OperationsAdaptiveGroups ?? []) {
    const a = r.dimensions.actionType.toLowerCase();
    if (/put|post|copy|create|complete|abort/i.test(a)) classA += r.sum.requests;
    else classB += r.sum.requests;
    bucketOps.set(r.dimensions.bucketName, (bucketOps.get(r.dimensions.bucketName) ?? 0) + r.sum.requests);
  }
  const storageGB = (store?.r2StorageAdaptiveGroups ?? []).reduce((s, r) => s + r.max.payloadSize, 0) / (1024 ** 3);

  return {
    usage: { class_a_ops: classA, class_b_ops: classB, storage_gb: +storageGB.toFixed(4) },
    included: { class_a_ops: INCLUDED.r2.class_a, class_b_ops: INCLUDED.r2.class_b, storage_gb: INCLUDED.r2.storage_gb },
    cost:
      overageCostPerM(classA, INCLUDED.r2.class_a, pricing.r2.class_a) +
      overageCostPerM(classB, INCLUDED.r2.class_b, pricing.r2.class_b) +
      Math.max(0, storageGB - INCLUDED.r2.storage_gb) * pricing.r2.storage_gb,
    breakdown: [...bucketOps.entries()].sort((a, b) => b[1] - a[1]).map(([bucket, total]) => ({ bucket, total_ops: total })),
  };
}

async function queryD1(acct: string, token: string, days: number, pricing: CfPricing): Promise<ServiceCost> {
  const { start, end } = dateRange(days);
  const [analytics, store] = await Promise.all([
    gql<{ d1AnalyticsAdaptiveGroups: Array<{ sum: { rowsRead: number; rowsWritten: number } }> }>(
      acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { d1AnalyticsAdaptiveGroups(filter:{date_geq:"${start}",date_leq:"${end}"},limit:10000) { sum { rowsRead rowsWritten } } } } }`),
    gql<{ d1StorageAdaptiveGroups: Array<{ max: { databaseSizeBytes: number } }> }>(
      acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { d1StorageAdaptiveGroups(filter:{date_geq:"${start}",date_leq:"${end}"},limit:100) { max { databaseSizeBytes } } } } }`),
  ]);

  const rowsRead = analytics?.d1AnalyticsAdaptiveGroups?.reduce((s, r) => s + r.sum.rowsRead, 0) ?? 0;
  const rowsWritten = analytics?.d1AnalyticsAdaptiveGroups?.reduce((s, r) => s + r.sum.rowsWritten, 0) ?? 0;
  const storageGB = Math.max(...(store?.d1StorageAdaptiveGroups?.map(r => r.max.databaseSizeBytes) ?? [0]), 0) / (1024 ** 3);

  return {
    usage: { rows_read: rowsRead, rows_written: rowsWritten, storage_gb: +storageGB.toFixed(4) },
    included: { rows_read: INCLUDED.d1.read, rows_written: INCLUDED.d1.write, storage_gb: INCLUDED.d1.storage_gb },
    cost:
      overageCostPerM(rowsRead, INCLUDED.d1.read, pricing.d1.read) +
      overageCostPerM(rowsWritten, INCLUDED.d1.write, pricing.d1.write) +
      Math.max(0, storageGB - INCLUDED.d1.storage_gb) * pricing.d1.storage_gb,
  };
}

async function queryAI(acct: string, token: string, days: number, pricing: CfPricing): Promise<ServiceCost> {
  const { start, end } = dateRange(days);
  const data = await gql<{
    aiInferenceAdaptiveGroups: Array<{ sum: { neurons: number }; dimensions: { modelName: string } }>;
  }>(acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { aiInferenceAdaptiveGroups(filter:{date_geq:"${start}",date_leq:"${end}"},limit:10000) { sum { neurons } dimensions { modelName } } } } }`);

  const rows = data?.aiInferenceAdaptiveGroups ?? [];
  const neurons = rows.reduce((s, r) => s + r.sum.neurons, 0);

  const byModel = new Map<string, number>();
  for (const r of rows) byModel.set(r.dimensions.modelName, (byModel.get(r.dimensions.modelName) ?? 0) + r.sum.neurons);

  return {
    usage: { neurons },
    included: {},
    cost: (neurons / 1000) * pricing.workers_ai.neurons,
    breakdown: [...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([model, n]) => ({ model, neurons: n })),
  };
}

async function queryBrowserRendering(acct: string, token: string, days: number, pricing: CfPricing): Promise<ServiceCost> {
  const { start, end } = dateRange(days);
  const data = await gql<{
    browserRenderingApiAdaptiveGroups: Array<{ sum: { requests: number; durationMs: number } }>;
  }>(acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { browserRenderingApiAdaptiveGroups(filter:{date_geq:"${start}",date_leq:"${end}"},limit:10000) { sum { requests durationMs } } } } }`);

  const rows = data?.browserRenderingApiAdaptiveGroups ?? [];
  const requests = rows.reduce((s, r) => s + r.sum.requests, 0);
  const hours = rows.reduce((s, r) => s + r.sum.durationMs, 0) / 3_600_000;

  return {
    usage: { requests, hours: +hours.toFixed(2) },
    included: { hours: INCLUDED.browser_rendering.hours },
    cost: Math.max(0, hours - INCLUDED.browser_rendering.hours) * pricing.browser_rendering.hour,
  };
}

async function queryContainers(acct: string, token: string, days: number, pricing: CfPricing): Promise<ServiceCost> {
  const { start, end } = dateRange(days);
  const data = await gql<{
    containersMetricsAdaptiveGroups: Array<{ sum: { cpuTimeUs: number; memoryGiBSeconds: number; diskGBSeconds: number } }>;
  }>(acct, token, `{ viewer { accounts(filter:{accountTag:"${acct}"}) { containersMetricsAdaptiveGroups(filter:{date_geq:"${start}",date_leq:"${end}"},limit:10000) { sum { cpuTimeUs memoryGiBSeconds diskGBSeconds } } } } }`);

  const rows = data?.containersMetricsAdaptiveGroups ?? [];
  const cpuS = rows.reduce((s, r) => s + r.sum.cpuTimeUs, 0) / 1_000_000;
  const memGiBs = rows.reduce((s, r) => s + r.sum.memoryGiBSeconds, 0);

  const inclCpuS = INCLUDED.containers.cpu_vcpu_min * 60;
  const inclMemS = INCLUDED.containers.mem_gib_h * 3600;

  return {
    usage: { cpu_seconds: +cpuS.toFixed(2), memory_gib_seconds: +memGiBs.toFixed(2) },
    included: { cpu_seconds: inclCpuS, memory_gib_seconds: inclMemS },
    cost:
      Math.max(0, cpuS - inclCpuS) * pricing.containers.cpu_vcpu_s +
      Math.max(0, memGiBs - inclMemS) * pricing.containers.mem_gib_s,
  };
}

// ── Public API ───────────────────────────────────────────────

export interface CostReport {
  period: { start: string; end: string; days: number };
  platform_fee: number;
  services: Record<string, ServiceCost>;
  total_estimated_cost: number;
}

export async function generateCostReport(
  accountId: string,
  token: string,
  days: number,
  pricing: CfPricing = DEFAULT_PRICING,
): Promise<CostReport> {
  const { start, end } = dateRange(days);

  const [workers, durableObjects, kv, r2, d1, ai, browser, containers] = await Promise.all([
    queryWorkers(accountId, token, days, pricing),
    queryDurableObjects(accountId, token, days, pricing),
    queryKV(accountId, token, days, pricing),
    queryR2(accountId, token, days, pricing),
    queryD1(accountId, token, days, pricing),
    queryAI(accountId, token, days, pricing),
    queryBrowserRendering(accountId, token, days, pricing),
    queryContainers(accountId, token, days, pricing),
  ]);

  const services: Record<string, ServiceCost> = {
    workers, durable_objects: durableObjects, kv, r2, d1, workers_ai: ai, browser_rendering: browser, containers,
  };

  const platformFee = 5.00;
  const totalCost = platformFee + Object.values(services).reduce((s, svc) => s + svc.cost, 0);

  return {
    period: { start, end, days },
    platform_fee: platformFee,
    services,
    total_estimated_cost: +totalCost.toFixed(2),
  };
}
