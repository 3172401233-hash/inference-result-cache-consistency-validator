import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeKeyComposition, buildCacheKey, normalizeParams } from '../src/key.js';

const baseRequest = {
  tenantId: 'tenant-a',
  modelVersion: 'model-v1',
  systemPrompt: '你是助手',
  prompt: '你好',
  params: { temperature: 0.2, topP: 0.9 },
};

test('全绑定键包含租户、模型版本、系统提示、采样参数、prompt 五个维度', () => {
  const key = buildCacheKey(baseRequest);
  const segments = key.split(':').map((segment) => segment.split('=')[0]);
  assert.deepEqual(segments, ['cache', 't', 'm', 's', 'p', 'pr']);
});

test('相同元数据生成相同键，采样参数键顺序不影响键', () => {
  const reordered = {
    ...baseRequest,
    params: { topP: 0.9, temperature: 0.2 },
  };
  assert.equal(buildCacheKey(baseRequest), buildCacheKey(reordered));
});

test('任一维度变化都会生成不同的键', () => {
  const baseline = buildCacheKey(baseRequest);
  assert.notEqual(
    baseline,
    buildCacheKey({ ...baseRequest, modelVersion: 'model-v2' }),
  );
  assert.notEqual(
    baseline,
    buildCacheKey({ ...baseRequest, tenantId: 'tenant-b' }),
  );
  assert.notEqual(
    baseline,
    buildCacheKey({ ...baseRequest, systemPrompt: '你是翻译官' }),
  );
  assert.notEqual(
    baseline,
    buildCacheKey({ ...baseRequest, prompt: '早上好' }),
  );
  assert.notEqual(
    baseline,
    buildCacheKey({ ...baseRequest, params: { temperature: 0.7, topP: 0.9 } }),
  );
});

test('相同 prompt 不同采样参数不能复用确定结果（键不同）', () => {
  const lowTemperature = buildCacheKey({ ...baseRequest, params: { temperature: 0.1 } });
  const highTemperature = buildCacheKey({ ...baseRequest, params: { temperature: 0.9 } });
  assert.notEqual(lowTemperature, highTemperature);
});

test('normalizeParams 按键名排序序列化，忽略键顺序', () => {
  assert.equal(
    normalizeParams({ temperature: 0.2, topP: 0.9 }),
    normalizeParams({ topP: 0.9, temperature: 0.2 }),
  );
  assert.notEqual(
    normalizeParams({ temperature: 0.2 }),
    normalizeParams({ temperature: 0.3 }),
  );
});

test('analyzeKeyComposition 能识别只含 prompt 文本的不完整键', () => {
  const promptOnlyKey = `cache:pr=${'x'.repeat(64)}`;
  const analysis = analyzeKeyComposition(promptOnlyKey);
  assert.equal(analysis.complete, false);
  assert.deepEqual(analysis.missingDimensions, ['t', 'm', 's', 'p']);
  assert.equal(analyzeKeyComposition(buildCacheKey(baseRequest)).complete, true);
});

test('缺少必填元数据时抛出明确错误', () => {
  assert.throws(() => buildCacheKey({ ...baseRequest, tenantId: '' }), /tenantId/);
  assert.throws(() => buildCacheKey({ ...baseRequest, modelVersion: '' }), /modelVersion/);
});
