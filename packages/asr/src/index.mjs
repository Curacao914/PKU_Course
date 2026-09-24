import path from 'node:path'
import { fileURLToPath } from 'node:url'

export {
  resolveAsrBudget,
  reserveAsrBudget
} from './asr-budget.mjs'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/** 转录工作器所在目录（Python 入口与 requirements 都在这里）。 */
export const ASR_PYTHON_DIR = path.resolve(moduleDir, '..', 'python')

/** headless 转录入口：由 worker 以子进程方式调用。 */
export const ASR_WORKER_ENTRY = path.join(ASR_PYTHON_DIR, 'paraformer_worker.py')
