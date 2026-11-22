import { analyzeKeyComposition, buildCacheKey, normalizeParams } from './key.js';

/**
 * 统一时间输入：支持毫秒时间戳、Date、ISO 字符串，统一转成毫秒。
 * @param {number|string|Date} value
 * @param {string} field
 * @returns {number}
 */
export function toTimeMs(value, field) {
  if (typeof value === 'number') {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      throw new Error(`${field} 不是合法时间: ${value}`);
    }
    return ms;
  }
  throw new Error(`${field} 必须是时间戳数字、Date 或 ISO 字符串`);
}

const DIMENSION_LABELS = {
  t: '租户',
  m: '模型版本',
  s: '系统提示',
  p: '采样参数',
  pr: 'prompt',
};

/**
 * 判断失效事件的 scope 是否覆盖某个请求维度。
 * scope 中给出的每个字段都必须与目标请求相等；未给出的字段视为通配。
 * @param {{scope?:object}} invalidation
 * @param {object} target 带 tenantId/modelVersion/systemPrompt/prompt/params 的请求
 * @returns {boolean}
 */
export function invalidationMatches(invalidation, target) {
  const scope = invalidation.scope;
  if (!scope) {
    return true;
  }
  if (scope.tenantId !== undefined && scope.tenantId !== target.tenantId) {
    return false;
  }
  if (scope.modelVersion !== undefined && scope.modelVersion !== target.modelVersion) {
    return false;
  }
  if (
    scope.systemPrompt !== undefined &&
    scope.systemPrompt !== (target.systemPrompt ?? '')
  ) {
    return false;
  }
  if (scope.prompt !== undefined && scope.prompt !== target.prompt) {
    return false;
  }
  if (scope.params !== undefined && normalizeParams(scope.params) !== normalizeParams(target.params)) {
    return false;
  }
  return true;
}

function describeDimensions(dimensions) {
  return dimensions.map((dimension) => DIMENSION_LABELS[dimension] ?? dimension);
}

/**
 * 校验推理结果缓存一致性。
 *
 * 输入：
 * - entries: 缓存中实际写入的条目（原始键、请求元数据、结果版本、写入时间）
 * - hits: 每次缓存命中事件（请求元数据 + 命中的条目 id + 时间 + 来源标记）
 * - invalidations: 失效事件（时间 + 作用范围 scope）
 * - release: 版本发布信息（旧版本、停写旧键时间点、双读窗口）
 *
 * 输出：有效命中、错误命中（含原因）、待清理键（含原因与失效事件）、版本风险。
 * @param {object} input
 * @returns {object}
 */
export function validateCacheConsistency(input = {}) {
  const entries = input.entries ?? [];
  const hits = input.hits ?? [];
  const invalidations = (input.invalidations ?? []).map((event) => ({
    ...event,
    atMs: toTimeMs(event.at, `invalidation ${event.id ?? ''} at`),
  }));
  const release = input.release ?? null;
  const cutoffAtMs =
    release && release.cutoffAt !== undefined
      ? toTimeMs(release.cutoffAt, 'release.cutoffAt')
      : null;

  const entryById = new Map(entries.map((entry) => [entry.id, entry]));

  // 同一个原始键被多个模型版本/租户共用：并发发布共享缓存的核心风险。
  const entriesByKey = new Map();
  for (const entry of entries) {
    if (!entriesByKey.has(entry.key)) {
      entriesByKey.set(entry.key, []);
    }
    entriesByKey.get(entry.key).push(entry);
  }
  const sharedKeys = new Map();
  for (const [key, group] of entriesByKey) {
    const modelVersions = [...new Set(group.map((entry) => entry.request.modelVersion))].sort();
    const tenantIds = [...new Set(group.map((entry) => entry.request.tenantId))].sort();
    if (modelVersions.length > 1 || tenantIds.length > 1) {
      sharedKeys.set(key, { modelVersions, tenantIds, entryIds: group.map((entry) => entry.id) });
    }
  }

  // 原始键缺少必要维度（例如只包含 prompt 文本）。
  const incompleteKeys = new Map();
  for (const entry of entries) {
    const analysis = analyzeKeyComposition(entry.key);
    if (!analysis.complete && !incompleteKeys.has(entry.key)) {
      incompleteKeys.set(entry.key, analysis.missingDimensions);
    }
  }

  // 失效事件覆盖到的、且写入时间早于失效时间的条目即为陈旧条目。
  const staleEntries = new Map();
  for (const entry of entries) {
    const storedAtMs = toTimeMs(entry.storedAt, `entry ${entry.id} storedAt`);
    for (const event of invalidations) {
      if (event.atMs <= storedAtMs) {
        continue;
      }
      if (invalidationMatches(event, entry.request)) {
        if (!staleEntries.has(entry.id)) {
          staleEntries.set(entry.id, []);
        }
        staleEntries.get(entry.id).push({ id: event.id, at: event.at });
      }
    }
  }

  const cleanup = new Map();
  const addCleanup = (key, reason, invalidationId) => {
    if (!cleanup.has(key)) {
      cleanup.set(key, { key, reasons: new Set(), invalidationIds: new Set() });
    }
    cleanup.get(key).reasons.add(reason);
    if (invalidationId !== undefined) {
      cleanup.get(key).invalidationIds.add(invalidationId);
    }
  };

  for (const [entryId, events] of staleEntries) {
    const entry = entryById.get(entryId);
    for (const event of events) {
      addCleanup(entry.key, 'stale-after-invalidation', event.id);
    }
  }
  for (const key of sharedKeys.keys()) {
    addCleanup(key, 'shared-key-across-versions-or-tenants');
  }
  for (const key of incompleteKeys.keys()) {
    addCleanup(key, 'incomplete-key-composition');
  }

  const versionRisks = [];

  for (const [key, missingDimensions] of incompleteKeys) {
    versionRisks.push({
      type: 'incomplete-key-composition',
      key,
      missingDimensions,
      message: `缓存键缺少维度: ${describeDimensions(missingDimensions).join('、')}`,
    });
  }

  for (const [key, detail] of sharedKeys) {
    versionRisks.push({
      type: 'shared-key-across-versions-or-tenants',
      key,
      ...detail,
      message:
        detail.modelVersions.length > 1
          ? `同一缓存键被模型版本 ${detail.modelVersions.join(', ')} 共享`
          : `同一缓存键被租户 ${detail.tenantIds.join(', ')} 共享`,
    });
  }

  // 版本发布：cutoff 之后不允许再写入旧版本键。
  const oldKeyWrites = [];
  if (release && cutoffAtMs !== null && release.oldModelVersion) {
    for (const entry of entries) {
      const storedAtMs = toTimeMs(entry.storedAt, `entry ${entry.id} storedAt`);
      if (
        entry.request.modelVersion === release.oldModelVersion &&
        storedAtMs >= cutoffAtMs
      ) {
        oldKeyWrites.push(entry.id);
        addCleanup(entry.key, 'old-key-write-after-cutoff');
        versionRisks.push({
          type: 'old-key-write-after-cutoff',
          entryId: entry.id,
          key: entry.key,
          storedAt: entry.storedAt,
          cutoffAt: release.cutoffAt,
          message: `停写时间点 ${release.cutoffAt} 之后仍写入旧版本 ${release.oldModelVersion} 的键`,
        });
      }
    }
  }

  const dualReadFromMs =
    release && release.dualReadWindow && release.dualReadWindow.from !== undefined
      ? toTimeMs(release.dualReadWindow.from, 'release.dualReadWindow.from')
      : null;
  const dualReadToMs =
    release && release.dualReadWindow && release.dualReadWindow.to !== undefined
      ? toTimeMs(release.dualReadWindow.to, 'release.dualReadWindow.to')
      : null;

  const validHits = [];
  const invalidHits = [];

  for (const hit of hits) {
    const hitAtMs = toTimeMs(hit.at, `hit ${hit.id ?? ''} at`);
    const request = hit.request;
    const expectedKey = buildCacheKey(request);
    const entry = hit.storedEntryId ? entryById.get(hit.storedEntryId) : undefined;
    const reasons = [];

    if (!entry) {
      reasons.push({ code: 'stored-entry-not-found', detail: hit.storedEntryId ?? null });
    } else {
      const stored = entry.request;
      if (entry.key !== expectedKey) {
        reasons.push({
          code: 'key-mismatch',
          detail: { storedKey: entry.key, expectedKey },
        });
      }
      if (stored.tenantId !== request.tenantId) {
        reasons.push({
          code: 'tenant-mismatch',
          detail: { storedTenantId: stored.tenantId, requestTenantId: request.tenantId },
        });
      }
      if (stored.modelVersion !== request.modelVersion) {
        reasons.push({
          code: 'model-version-mismatch',
          detail: {
            storedModelVersion: stored.modelVersion,
            requestModelVersion: request.modelVersion,
          },
        });
      }
      if ((stored.systemPrompt ?? '') !== (request.systemPrompt ?? '')) {
        reasons.push({
          code: 'system-prompt-mismatch',
          detail: {
            storedSystemPrompt: stored.systemPrompt ?? '',
            requestSystemPrompt: request.systemPrompt ?? '',
          },
        });
      }
      if (normalizeParams(stored.params) !== normalizeParams(request.params)) {
        reasons.push({
          code: 'sampling-params-mismatch',
          detail: {
            storedParams: normalizeParams(stored.params),
            requestParams: normalizeParams(request.params),
          },
        });
      }
      if (stored.prompt !== request.prompt) {
        reasons.push({ code: 'prompt-mismatch' });
      }
      if (entry.resultVersion !== request.modelVersion) {
        reasons.push({
          code: 'result-version-mismatch',
          detail: {
            storedResultVersion: entry.resultVersion,
            requestModelVersion: request.modelVersion,
          },
        });
      }
      if (sharedKeys.has(entry.key)) {
        reasons.push({ code: 'shared-key-across-versions-or-tenants' });
      }
      if (staleEntries.has(entry.id)) {
        reasons.push({
          code: 'stale-after-invalidation',
          detail: staleEntries.get(entry.id),
        });
      }
    }

    // 双读窗口内的命中必须标记来源（old/new），缺失来源记为版本风险。
    const inDualReadWindow =
      dualReadFromMs !== null &&
      hitAtMs >= dualReadFromMs &&
      (dualReadToMs === null || hitAtMs < dualReadToMs);
    if (inDualReadWindow && (typeof hit.source !== 'string' || hit.source.length === 0)) {
      versionRisks.push({
        type: 'dual-read-source-unmarked',
        hitId: hit.id,
        at: hit.at,
        message: '双版本读取窗口内的命中未标记来源（old/new）',
      });
    }

    const hitView = {
      hitId: hit.id,
      at: hit.at,
      tenantId: request.tenantId,
      modelVersion: request.modelVersion,
      expectedKey,
      storedEntryId: hit.storedEntryId ?? null,
      source: hit.source ?? null,
    };

    if (reasons.length === 0) {
      validHits.push(hitView);
    } else {
      invalidHits.push({ ...hitView, reasons });
    }
  }

  const cleanupKeys = [...cleanup.values()]
    .map((item) => ({
      key: item.key,
      reasons: [...item.reasons].sort(),
      invalidationIds: [...item.invalidationIds].sort(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  versionRisks.sort((a, b) => {
    const typeOrder = a.type.localeCompare(b.type);
    if (typeOrder !== 0) {
      return typeOrder;
    }
    return String(a.key ?? a.entryId ?? a.hitId).localeCompare(
      String(b.key ?? b.entryId ?? b.hitId),
    );
  });

  return {
    summary: {
      entries: entries.length,
      hits: hits.length,
      validHits: validHits.length,
      invalidHits: invalidHits.length,
      cleanupKeys: cleanupKeys.length,
      versionRisks: versionRisks.length,
    },
    validHits,
    invalidHits,
    cleanupKeys,
    versionRisks,
  };
}
