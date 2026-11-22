import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCacheKey } from '../src/key.js';
import { invalidationMatches, validateCacheConsistency } from '../src/validator.js';

function buildRequest(overrides = {}) {
  return {
    tenantId: 'tenant-a',
    modelVersion: 'model-v1',
    systemPrompt: '你是助手',
    prompt: '你好',
    params: { temperature: 0.2, topP: 0.9 },
    ...overrides,
  };
}

function buildEntry(overrides = {}) {
  const request = buildRequest(overrides.request ?? {});
  return {
    id: overrides.id ?? 'entry-1',
    key: overrides.key ?? buildCacheKey(request),
    request,
    resultVersion: overrides.resultVersion ?? request.modelVersion,
    storedAt: overrides.storedAt ?? '2026-11-22T10:00:00.000Z',
  };
}

function buildHit(overrides = {}) {
  const request = buildRequest(overrides.request ?? {});
  return {
    id: overrides.id ?? 'hit-1',
    request,
    storedEntryId: overrides.storedEntryId ?? 'entry-1',
    at: overrides.at ?? '2026-11-22T10:05:00.000Z',
    source: overrides.source,
  };
}

test('全维度匹配的命中是有效命中', () => {
  const report = validateCacheConsistency({
    entries: [buildEntry()],
    hits: [buildHit()],
  });
  assert.equal(report.summary.validHits, 1);
  assert.equal(report.summary.invalidHits, 0);
  assert.equal(report.validHits[0].hitId, 'hit-1');
  assert.equal(report.versionRisks.length, 0);
  assert.equal(report.cleanupKeys.length, 0);
});

test('模型切换：新版本请求命中旧模型结果是错误命中，并标记待清理', () => {
  const entry = buildEntry({ id: 'old-entry' });
  const hit = buildHit({
    id: 'model-switch-hit',
    storedEntryId: 'old-entry',
    request: { modelVersion: 'model-v2' },
  });
  const report = validateCacheConsistency({ entries: [entry], hits: [hit] });

  assert.equal(report.summary.validHits, 0);
  assert.equal(report.summary.invalidHits, 1);
  const invalid = report.invalidHits[0];
  const codes = invalid.reasons.map((reason) => reason.code);
  assert.ok(codes.includes('model-version-mismatch'));
  assert.ok(codes.includes('key-mismatch'));
  assert.ok(codes.includes('result-version-mismatch'));
});

test('系统提示变化：命中旧系统提示结果是错误命中', () => {
  const entry = buildEntry({ id: 'old-sys' });
  const hit = buildHit({
    request: { systemPrompt: '你是翻译官' },
    storedEntryId: 'old-sys',
  });
  const report = validateCacheConsistency({ entries: [entry], hits: [hit] });

  assert.equal(report.summary.invalidHits, 1);
  const codes = report.invalidHits[0].reasons.map((reason) => reason.code);
  assert.ok(codes.includes('system-prompt-mismatch'));
  assert.ok(codes.includes('key-mismatch'));
});

test('参数变化：相同 prompt 不同采样温度不能复用确定结果', () => {
  const entry = buildEntry({ id: 'cold-entry' });
  const hit = buildHit({
    request: { params: { temperature: 0.9, topP: 0.9 } },
    storedEntryId: 'cold-entry',
  });
  const report = validateCacheConsistency({ entries: [entry], hits: [hit] });

  assert.equal(report.summary.invalidHits, 1);
  const codes = report.invalidHits[0].reasons.map((reason) => reason.code);
  assert.deepEqual(codes, ['key-mismatch', 'sampling-params-mismatch']);
});

test('租户隔离：跨租户命中是错误命中，且共享键触发版本风险与清理', () => {
  const promptOnlyKey = `cache:pr=${'a'.repeat(64)}`;
  const entryA = buildEntry({
    id: 'entry-a',
    key: promptOnlyKey,
    request: { tenantId: 'tenant-a' },
  });
  const entryB = buildEntry({
    id: 'entry-b',
    key: promptOnlyKey,
    request: { tenantId: 'tenant-b' },
    storedAt: '2026-11-22T10:01:00.000Z',
  });
  const hit = buildHit({
    request: { tenantId: 'tenant-b' },
    storedEntryId: 'entry-a',
  });
  const report = validateCacheConsistency({ entries: [entryA, entryB], hits: [hit] });

  assert.equal(report.summary.invalidHits, 1);
  const codes = report.invalidHits[0].reasons.map((reason) => reason.code);
  assert.ok(codes.includes('tenant-mismatch'));
  assert.ok(codes.includes('shared-key-across-versions-or-tenants'));

  const riskTypes = report.versionRisks.map((risk) => risk.type);
  assert.ok(riskTypes.includes('shared-key-across-versions-or-tenants'));
  assert.ok(riskTypes.includes('incomplete-key-composition'));

  const sharedCleanup = report.cleanupKeys.find((item) => item.key === promptOnlyKey);
  assert.ok(sharedCleanup.reasons.includes('shared-key-across-versions-or-tenants'));
  assert.ok(sharedCleanup.reasons.includes('incomplete-key-composition'));
});

test('只含 prompt 文本的键：同 prompt 不同模型版本共享缓存', () => {
  const promptOnlyKey = `cache:pr=${'b'.repeat(64)}`;
  const v1Entry = buildEntry({
    id: 'v1-entry',
    key: promptOnlyKey,
    request: { modelVersion: 'model-v1' },
  });
  const v2Entry = buildEntry({
    id: 'v2-entry',
    key: promptOnlyKey,
    request: { modelVersion: 'model-v2' },
    resultVersion: 'model-v2',
    storedAt: '2026-11-22T10:02:00.000Z',
  });
  const report = validateCacheConsistency({ entries: [v1Entry, v2Entry], hits: [] });

  const sharedRisk = report.versionRisks.find(
    (risk) => risk.type === 'shared-key-across-versions-or-tenants',
  );
  assert.ok(sharedRisk);
  assert.deepEqual(sharedRisk.modelVersions, ['model-v1', 'model-v2']);
  assert.deepEqual(sharedRisk.entryIds, ['v1-entry', 'v2-entry']);

  const cleanup = report.cleanupKeys.find((item) => item.key === promptOnlyKey);
  assert.ok(cleanup);
  assert.deepEqual(cleanup.reasons, [
    'incomplete-key-composition',
    'shared-key-across-versions-or-tenants',
  ]);
});

test('invalidationMatches：scope 字段全部相等才覆盖，缺字段视为通配', () => {
  const request = buildRequest();
  assert.equal(invalidationMatches({ scope: undefined }, request), true);
  assert.equal(
    invalidationMatches({ scope: { tenantId: 'tenant-a' } }, request),
    true,
  );
  assert.equal(
    invalidationMatches({ scope: { tenantId: 'tenant-b' } }, request),
    false,
  );
  assert.equal(
    invalidationMatches(
      { scope: { params: { topP: 0.9, temperature: 0.2 } } },
      request,
    ),
    true,
  );
  assert.equal(
    invalidationMatches({ scope: { params: { temperature: 0.5 } } }, request),
    false,
  );
});

test('命中不存在的条目时报 stored-entry-not-found', () => {
  const report = validateCacheConsistency({
    entries: [],
    hits: [buildHit({ storedEntryId: 'ghost' })],
  });
  assert.equal(report.summary.invalidHits, 1);
  assert.equal(
    report.invalidHits[0].reasons[0].code,
    'stored-entry-not-found',
  );
});
