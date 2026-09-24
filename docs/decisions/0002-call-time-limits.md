# 0002 采集限额改为调用时解析

日期：2026-09-24
状态：已采纳

## 背景

`acquisition-runtime.mjs` 把五个环境变量读进模块顶层 `const`：

```js
const START_URL = process.env.COURSE_START_URL || 'https://course.pku.edu.cn/'
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.COURSE_DOWNLOAD_CONCURRENCY || 6)))
const FETCH_ATTEMPTS = ...
const SEGMENT_TIMEOUT_MS = ...
const PROGRESS_EVERY = ...
```

由此产生三个问题：

1. **隐式顺序依赖**：import 之后再设置 `process.env` 不生效。旧系统靠 `worker-env.mjs` 在 import 时写 `process.env`，因此"先 import 环境加载器"成了必须遵守的隐性契约，顺序错了就静默使用默认值。
2. **不可测**：并发、超时无法在测试或单次运行中覆盖。
3. **NaN 静默传播**：`Number('abc')` → `NaN`，`Math.max(1, Math.min(8, NaN))` → `NaN`，并发数变成 `NaN` 后 `runPool` 行为未定义。环境变量写错不会有任何提示。

## 决定

改为导出一个解析函数，在调用点求值：

```js
export function resolveAcquisitionLimits(env = process.env) {
  return {
    startUrl: env.COURSE_START_URL || 'https://course.pku.edu.cn/',
    concurrency: clampNumber(env.COURSE_DOWNLOAD_CONCURRENCY, 6, 1, 8),
    fetchAttempts: clampNumber(env.COURSE_FETCH_ATTEMPTS, 4, 1, 8),
    segmentTimeoutMs: clampNumber(env.COURSE_SEGMENT_TIMEOUT_MS, 90_000, 10_000, 180_000),
    progressEvery: clampNumber(env.COURSE_DOWNLOAD_PROGRESS_EVERY, 5, 1, 100)
  }
}
```

`clampNumber` 把空串、空白、非数字一律视为"未设置"并回退默认值，同时保持原有的上下限夹取。

## 影响

- 行为对合法配置完全一致；仅"配置了非法值"的路径从 NaN 变为默认值（更安全）。
- 调用方不再需要保证环境加载器先于本模块 import。
- 五个限额现在可被单测覆盖（`limits.test.mjs`）。

## 未做

未把 `resolveAcquisitionLimits` 的结果注入到函数签名里（真正的依赖注入）。当前形态足以消除顺序依赖与不可测性；等 `acquisition-runtime.mjs` 拆成"纯逻辑 + IO"两个包时再一并处理。

## 遗留

同类问题在 `asr_core.py` 更严重：`ROOT`、`LOG_DIR`、`OUTPUT_ROOT`、`.private`、`ENV_PATH` 都是 import 时求值的模块级常量。搬运该文件时需要一并改为运行期传入的路径对象。
