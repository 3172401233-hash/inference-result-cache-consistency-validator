import { createHash } from 'node:crypto';

/**
 * 规范化采样参数：仅取影响推理输出的参数，按键名排序后序列化，
 * 保证 {temperature:0.2,topP:0.9} 与 {topP:0.9,temperature:0.2} 指纹相同。
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function normalizeParams(params = {}) {
  const filtered = Object.create(null);
  for (const key of Object.keys(params).sort()) {
    filtered[key] = params[key];
  }
  return JSON.stringify(filtered);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 正确的全绑定缓存键：prompt 文本之外，还必须绑定模型版本、
 * 采样参数指纹、系统提示与租户，任一维度变化都会生成不同的键。
 * 输入为推理请求元数据，输出为结构化的缓存键字符串。
 * @param {{tenantId:string, modelVersion:string, systemPrompt?:string,
 *          prompt:string, params?:Record<string, unknown>}} request
 * @returns {string}
 */
export function buildCacheKey(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('request 必须是对象');
  }
  const { tenantId, modelVersion, systemPrompt = '', prompt, params = {} } = request;
  if (!tenantId || typeof tenantId !== 'string') {
    throw new TypeError('tenantId 为必填字符串');
  }
  if (!modelVersion || typeof modelVersion !== 'string') {
    throw new TypeError('modelVersion 为必填字符串');
  }
  if (typeof prompt !== 'string') {
    throw new TypeError('prompt 必须是字符串');
  }
  const paramsFingerprint = sha256(normalizeParams(params));
  const systemFingerprint = sha256(systemPrompt);
  const promptFingerprint = sha256(prompt);
  return [
    'cache',
    `t=${sha256(tenantId)}`,
    `m=${sha256(modelVersion)}`,
    `s=${systemFingerprint}`,
    `p=${paramsFingerprint}`,
    `pr=${promptFingerprint}`,
  ].join(':');
}

/**
 * 分析实际写入缓存的原始键包含哪些维度，用于判断“键只含 prompt 文本”
 * 这类不完整键问题。
 * @param {string} storedKey
 * @returns {{complete:boolean, missingDimensions:string[]}}
 */
export function analyzeKeyComposition(storedKey) {
  const required = ['t', 'm', 's', 'p', 'pr'];
  const present = new Set(
    String(storedKey)
      .split(':')
      .map((segment) => segment.split('=')[0])
      .filter(Boolean),
  );
  const missingDimensions = required.filter((dimension) => !present.has(dimension));
  return {
    complete: missingDimensions.length === 0,
    missingDimensions,
  };
}
