# inference-result-cache-consistency-validator

推理结果缓存一致性校验工具。针对“缓存键只包含 prompt 文本，模型版本、采样温度、
系统提示变化后仍命中旧结果，以及并发发布时两个版本共享同一缓存”的问题，
基于输入的元数据离线校验每次缓存命中是否有效，并给出需要失效的键范围与版本风险。

## 工具边界（重要）

本工具**只验证元数据和缓存键**，不连接真实缓存、不执行模型推理、不校验推理结果
内容本身的正确性。所有判断都来自输入 JSON 中的缓存条目、命中事件、失效事件和
发布计划，输出一份可审计的一致性报告。

## 正确的缓存键组成

仅用 prompt 文本作为键会在模型升级、调参、系统提示变更和多租户场景下产生错误复用。
正确的键必须绑定以下五个维度（见 `src/key.js`）：

- 租户 `tenantId`
- 模型版本 `modelVersion`
- 系统提示 `systemPrompt`（空串也参与指纹）
- 采样参数指纹（`temperature`、`topP` 等排序后哈希，相同 prompt 不同采样参数生成不同键）
- prompt 文本

键格式：`cache:t=<hash>:m=<hash>:s=<hash>:p=<hash>:pr=<hash>`

## 校验规则

- 命中时逐维度比对请求与缓存条目：租户、模型版本、系统提示、采样参数、prompt、结果版本
- 失效事件按 `scope` 圈定范围（未给出的字段视为通配），命中发生在失效之后即为错误命中，
  对应键进入待清理列表并关联失效事件 id；失效早于条目录入时间则不判定为陈旧
- 同一原始键被多个模型版本或租户共享时，标记 `shared-key-across-versions-or-tenants`
  风险并要求清理（并发发布共享缓存）
- 原始键缺少必要维度时，标记 `incomplete-key-composition` 风险并要求清理
- 发布 `cutoffAt` 之后仍写入旧模型版本键，标记 `old-key-write-after-cutoff`
  （版本发布前必须停止写入旧键）
- 双读窗口 `dualReadWindow` 内的命中必须带 `source`（`old`/`new`）标记来源，
  缺失时标记 `dual-read-source-unmarked`

## 输入格式

```json
{
  "entries": [
    {
      "id": "entry-1",
      "key": "cache:pr=...（实际写入缓存的原始键）",
      "request": {
        "tenantId": "tenant-a",
        "modelVersion": "model-v1",
        "systemPrompt": "你是助手",
        "prompt": "你好",
        "params": { "temperature": 0.2 }
      },
      "resultVersion": "model-v1",
      "storedAt": "2026-11-22T10:00:00.000Z"
    }
  ],
  "hits": [
    {
      "id": "hit-1",
      "request": { "...": "与 entries.request 同结构的请求元数据" },
      "storedEntryId": "entry-1",
      "at": "2026-11-22T10:05:00.000Z",
      "source": "old"
    }
  ],
  "invalidations": [
    {
      "id": "inv-1",
      "at": "2026-11-22T10:15:00.000Z",
      "scope": { "tenantId": "tenant-a", "modelVersion": "model-v1" }
    }
  ],
  "release": {
    "oldModelVersion": "model-v1",
    "newModelVersion": "model-v2",
    "cutoffAt": "2026-11-22T11:00:00.000Z",
    "dualReadWindow": {
      "from": "2026-11-22T11:00:00.000Z",
      "to": "2026-11-22T12:00:00.000Z"
    }
  }
}
```

时间字段支持毫秒时间戳、ISO 字符串或 `Date`（编程调用时）。完整示例见
`examples/scenario.json`。

## 输出

- `summary`：条目数、命中数、有效/错误命中数、待清理键数、版本风险数
- `validHits`：全部维度匹配且未失效的有效命中
- `invalidHits`：错误命中，逐条给出原因码（如 `model-version-mismatch`、
  `sampling-params-mismatch`、`tenant-mismatch`、`stale-after-invalidation`）
- `cleanupKeys`：待清理键，含清理原因和关联的失效事件 id
- `versionRisks`：版本风险（不完整键、跨版本/租户共享键、停写后旧键写入、双读未标来源）

## 使用

要求 Node.js 24.16.0 或更高版本，无第三方依赖。

```bash
node src/cli.js examples/scenario.json
node src/cli.js examples/scenario.json --strict   # 有错误命中或风险时退出码为 1
```

也可编程调用：

```js
import { validateCacheConsistency } from './src/validator.js';
import { buildCacheKey } from './src/key.js';

const report = validateCacheConsistency(input);
const expectedKey = buildCacheKey(requestMetadata);
```

## 测试

测试基于 Node 内置测试运行器，覆盖模型切换、采样参数变化、租户隔离和并发失效：

```bash
node --test
```

- `test/key.test.js`：全绑定键组成、参数顺序无关性、同 prompt 不同采样参数键不同
- `test/validator.test.js`：模型切换、系统提示变化、参数变化、租户隔离、prompt-only 共享键
- `test/concurrency.test.js`：失效范围判定、停写旧键违规、双读来源标记、并发发布全流程
