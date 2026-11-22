import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCacheKey } from '../src/key.js';
import { validateCacheConsistency } from '../src/validator.js';

function buildRequest(overrides = {}) {
  return {
    tenantId: 'tenant-a',
    modelVersion: 'model-v1',
    systemPrompt: '你是助手',
    prompt: '你好',
    params: { temperature: 0.2 },
    ...overrides,
  };
}

function buildEntry(overrides = {}) {
  const request = buildRequest(overrides.request ?? {});
  return {
    id: overrides.id,
    key: overrides.key ?? buildCacheKey(request),
    request,
    resultVersion: overrides.resultVersion ?? request.modelVersion,
    storedAt: overrides.storedAt,
  };
}

const release = {
  oldModelVersion: 'model-v1',
  newModelVersion: 'model-v2',
  cutoffAt: '2026-11-22T11:00:00.000Z',
  dualReadWindow: {
    from: '2026-11-22T11:00:00.000Z',
    to: '2026-11-22T12:00:00.000Z',
  },
};

test('并发失效：失效后命中旧条目是错误命中，待清理键关联失效事件', () => {
  const entry = buildEntry({
    id: 'stale-entry',
    storedAt: '2026-11-22T10:00:00.000Z',
  });
  const report = validateCacheConsistency({
    entries: [entry],
    hits: [
      {
        id: 'hit-after-invalidation',
        request: entry.request,
        storedEntryId: 'stale-entry',
        at: '2026-11-22T10:30:00.000Z',
      },
    ],
    invalidations: [
      {
        id: 'inv-model-v1',
        at: '2026-11-22T10:15:00.000Z',
        scope: { tenantId: 'tenant-a', modelVersion: 'model-v1' },
      },
    ],
  });

  assert.equal(report.summary.invalidHits, 1);
  const reason = report.invalidHits[0].reasons.find(
    (item) => item.code === 'stale-after-invalidation',
  );
  assert.ok(reason);
  assert.deepEqual(
    reason.detail.map((event) => event.id),
    ['inv-model-v1'],
  );

  const cleanup = report.cleanupKeys.find((item) => item.key === entry.key);
  assert.ok(cleanup);
  assert.deepEqual(cleanup.reasons, ['stale-after-invalidation']);
  assert.deepEqual(cleanup.invalidationIds, ['inv-model-v1']);
});

test('失效事件不覆盖其他租户，未覆盖范围的命中仍然有效', () => {
  const entry = buildEntry({
    id: 'tenant-b-entry',
    request: { tenantId: 'tenant-b' },
    storedAt: '2026-11-22T10:00:00.000Z',
  });
  const report = validateCacheConsistency({
    entries: [entry],
    hits: [
      {
        id: 'hit-tenant-b',
        request: entry.request,
        storedEntryId: 'tenant-b-entry',
        at: '2026-11-22T10:30:00.000Z',
      },
    ],
    invalidations: [
      {
        id: 'inv-tenant-a-only',
        at: '2026-11-22T10:15:00.000Z',
        scope: { tenantId: 'tenant-a' },
      },
    ],
  });

  assert.equal(report.summary.validHits, 1);
  assert.equal(report.summary.invalidHits, 0);
  assert.equal(report.cleanupKeys.length, 0);
});

test('失效事件早于条目写入时不判定为陈旧（新写入已不含旧数据）', () => {
  const entry = buildEntry({
    id: 'rewritten-entry',
    storedAt: '2026-11-22T10:20:00.000Z',
  });
  const report = validateCacheConsistency({
    entries: [entry],
    hits: [
      {
        id: 'hit-fresh',
        request: entry.request,
        storedEntryId: 'rewritten-entry',
        at: '2026-11-22T10:25:00.000Z',
      },
    ],
    invalidations: [
      {
        id: 'inv-before-rewrite',
        at: '2026-11-22T10:10:00.000Z',
      },
    ],
  });

  assert.equal(report.summary.validHits, 1);
  assert.equal(report.cleanupKeys.length, 0);
});

test('版本发布：停写旧键后仍写入旧版本会产生风险并要求清理', () => {
  const lateOldEntry = buildEntry({
    id: 'late-old-entry',
    request: { modelVersion: 'model-v1' },
    storedAt: '2026-11-22T11:05:00.000Z',
  });
  const report = validateCacheConsistency({
    entries: [lateOldEntry],
    hits: [],
    release,
  });

  const risk = report.versionRisks.find(
    (item) => item.type === 'old-key-write-after-cutoff',
  );
  assert.ok(risk);
  assert.equal(risk.entryId, 'late-old-entry');

  const cleanup = report.cleanupKeys.find((item) => item.key === lateOldEntry.key);
  assert.ok(cleanup.reasons.includes('old-key-write-after-cutoff'));
});

test('双读窗口内命中必须标记来源，未标记的命中产生版本风险', () => {
  const entry = buildEntry({
    id: 'old-entry',
    storedAt: '2026-11-22T10:00:00.000Z',
  });
  const report = validateCacheConsistency({
    entries: [entry],
    hits: [
      {
        id: 'unmarked-hit',
        request: entry.request,
        storedEntryId: 'old-entry',
        at: '2026-11-22T11:10:00.000Z',
      },
      {
        id: 'marked-hit',
        request: entry.request,
        storedEntryId: 'old-entry',
        at: '2026-11-22T11:20:00.000Z',
        source: 'old',
      },
    ],
    release,
  });

  const unmarkedRisks = report.versionRisks.filter(
    (risk) => risk.type === 'dual-read-source-unmarked',
  );
  assert.equal(unmarkedRisks.length, 1);
  assert.equal(unmarkedRisks[0].hitId, 'unmarked-hit');

  assert.equal(report.validHits.length, 2);
  assert.deepEqual(
    report.validHits.find((hit) => hit.hitId === 'marked-hit').source,
    'old',
  );
});

test('并发发布全流程：共享键、停写违规、失效与双读来源同时校验', () => {
  const promptOnlyKey = `cache:pr=${'c'.repeat(64)}`;
  const v1SharedEntry = buildEntry({
    id: 'v1-shared',
    key: promptOnlyKey,
    request: { modelVersion: 'model-v1' },
    storedAt: '2026-11-22T10:00:00.000Z',
  });
  const v2SharedEntry = buildEntry({
    id: 'v2-shared',
    key: promptOnlyKey,
    request: { modelVersion: 'model-v2' },
    resultVersion: 'model-v2',
    storedAt: '2026-11-22T11:02:00.000Z',
  });
  const lateOldEntry = buildEntry({
    id: 'late-old',
    request: { modelVersion: 'model-v1' },
    storedAt: '2026-11-22T11:06:00.000Z',
  });
  const properV2Entry = buildEntry({
    id: 'proper-v2',
    request: { modelVersion: 'model-v2' },
    resultVersion: 'model-v2',
    storedAt: '2026-11-22T11:03:00.000Z',
  });

  const report = validateCacheConsistency({
    entries: [v1SharedEntry, v2SharedEntry, lateOldEntry, properV2Entry],
    hits: [
      {
        id: 'shared-key-hit',
        request: v2SharedEntry.request,
        storedEntryId: 'v1-shared',
        at: '2026-11-22T11:10:00.000Z',
        source: 'new',
      },
      {
        id: 'clean-v2-hit',
        request: properV2Entry.request,
        storedEntryId: 'proper-v2',
        at: '2026-11-22T11:15:00.000Z',
        source: 'new',
      },
    ],
    invalidations: [
      {
        id: 'inv-v1-purge',
        at: '2026-11-22T10:30:00.000Z',
        scope: { modelVersion: 'model-v1' },
      },
    ],
    release,
  });

  assert.equal(report.summary.validHits, 1);
  assert.equal(report.validHits[0].hitId, 'clean-v2-hit');
  assert.equal(report.summary.invalidHits, 1);
  const invalidCodes = report.invalidHits[0].reasons.map((reason) => reason.code);
  for (const code of [
    'key-mismatch',
    'model-version-mismatch',
    'result-version-mismatch',
    'shared-key-across-versions-or-tenants',
    'stale-after-invalidation',
  ]) {
    assert.ok(invalidCodes.includes(code), `应包含 ${code}`);
  }

  const riskTypes = report.versionRisks.map((risk) => risk.type);
  for (const type of [
    'incomplete-key-composition',
    'shared-key-across-versions-or-tenants',
    'old-key-write-after-cutoff',
  ]) {
    assert.ok(riskTypes.includes(type), `应包含风险 ${type}`);
  }

  const sharedCleanup = report.cleanupKeys.find((item) => item.key === promptOnlyKey);
  assert.ok(sharedCleanup.reasons.includes('shared-key-across-versions-or-tenants'));
  assert.ok(sharedCleanup.invalidationIds.includes('inv-v1-purge'));

  const lateCleanup = report.cleanupKeys.find((item) => item.key === lateOldEntry.key);
  assert.ok(lateCleanup.reasons.includes('old-key-write-after-cutoff'));
  assert.deepEqual(lateCleanup.invalidationIds, []);

  const properCleanup = report.cleanupKeys.find(
    (item) => item.key === properV2Entry.key,
  );
  assert.equal(properCleanup, undefined);
});
