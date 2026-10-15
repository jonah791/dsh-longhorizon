/**
 * store.ts — 台账文件读写的**单一真源**。
 *
 * 纪律搬自 `dsh-agent-taskboard/src/board.ts`（同一教训，2026-09-22 事故取证）：
 * **读路径可以退化，写路径绝不可以**——文件损坏时读到空台账，紧接着一次
 * `open`/`close` 就会把整本台账覆盖成「只有刚写的那一条」= 静默数据销毁。
 * 所以本模块只提供**严格读**给写路径用；只读面要宽松版就显式调 `readLenient`
 * ——让「降级」是一个**选择**，不是一个默认。
 *
 * 第二道护栏（本插件特有）：整库畸形与**单条畸形**代价不对称——误丢单条是少一条读数，
 * 误丢整库是不可逆的。故 `items` 全数畸形且原始非空时**抛错**（取严侧留痕由调用方做）。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { normalizeLedger, type Ledger } from './ledger.ts'

/** 读取注入形状（默认传 node:fs 的 readFileSync，测试可传替身） */
export type ReadFile = (path: string) => string

/** 写入注入形状 */
export interface WriteDeps {
  writeFile: (path: string, data: string) => void
  rename: (from: string, to: string) => void
  mkdir: (path: string) => void
}

/** 默认写入依赖（node:fs） */
export const nodeWriteDeps: WriteDeps = {
  writeFile: (p, d) => writeFileSync(p, d, 'utf8'),
  rename: (a, b) => renameSync(a, b),
  mkdir: (p) => { mkdirSync(p, { recursive: true }) },
}

/** 取错误文本（带 code，便于一次判对） */
function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return code !== undefined ? code + ': ' + e.message : e.message
  }
  return String(e)
}

/** 解析 DSH_HOME：环境变量优先，缺省 `<homedir>/.dsh`（与既有插件同约定） */
export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  const raw = (env['DSH_HOME'] ?? '').trim()
  return raw !== '' ? raw : join(homedir(), '.dsh')
}

/** 台账文件路径 */
export function ledgerPath(home: string): string {
  return join(home, 'longhorizon', 'ledger.json')
}

/** 留痕文件路径 */
export function tracePath(home: string): string {
  return join(home, 'longhorizon', 'trace.jsonl')
}

/** 严格读（**写路径专用**）：ENOENT ⇒ 空台账；其余一律抛错 */
export function readStrict(path: string, readFile: ReadFile): Ledger {
  let raw: string
  try {
    raw = readFile(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, items: [] }
    throw new Error('台账读取失败（' + path + '）：' + errText(e))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error('台账解析失败（' + path + '）——拒绝以空台账继续（否则下一次写入会覆盖整本）：' + errText(e))
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) {
    throw new Error('台账结构异常（' + path + '）：顶层缺少 items 数组——拒绝以空台账继续')
  }
  const rawCount = (parsed as { items: unknown[] }).items.length
  const { ledger, dropped } = normalizeLedger(parsed)
  if (dropped > 0 && ledger.items.length === 0 && rawCount > 0) {
    throw new Error('台账条目全部畸形（' + path + '）：' + String(dropped) + ' 条无一可用——拒绝以空台账继续')
  }
  return ledger
}

/** 宽松读（**只读面专用**）：任何失败退化为空台账。⚠ 绝不可用于写路径 */
export function readLenient(path: string, readFile: ReadFile): Ledger {
  try {
    return readStrict(path, readFile)
  } catch {
    return { version: 1, items: [] }
  }
}

/** 原子写：先写 `.tmp` 再 rename（同目录 ⇒ 同卷 ⇒ rename 原子） */
export function writeAtomic(path: string, ledger: Ledger, deps: WriteDeps = nodeWriteDeps): void {
  deps.mkdir(dirname(path))
  const tmp = path + '.tmp'
  deps.writeFile(tmp, JSON.stringify(ledger, null, 2) + '\n')
  deps.rename(tmp, path)
}

/**
 * 追加一行留痕（§5.22 机制必须自证：关键机制不得只写 logger）。
 * 观测绝不反噬主流程：吞错并返回 bool，调用方不得因留痕失败而中断业务。
 */
export function appendTrace(home: string, row: Record<string, unknown>, deps?: { append?: (path: string, data: string) => void }): boolean {
  try {
    const append = deps?.append ?? ((p: string, d: string) => { appendFileSync(p, d, 'utf8') })
    const path = tracePath(home)
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch {
      /* 目录已存在或不可建——交给下面的 append 去决定成败 */
    }
    append(path, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n')
    return true
  } catch {
    return false
  }
}
