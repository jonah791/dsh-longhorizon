/**
 * store.test.mjs — 台账 I/O 护栏测试。
 *
 * 这一组判据的**唯一理由**是防静默数据销毁（搬自 dsh-agent-taskboard/src/board.ts 的事故）：
 * 文件损坏 ⇒ 读到空台账 ⇒ 一次写入把整本覆盖成「只有刚写的那条」。
 * 所以：**写路径绝不退化**。下面每条「拒绝」都配了尸体样本。
 *
 * ⚠ 天花板：本文件证明护栏会拦；不证明真实磁盘上不会出现其它损坏形态（编码/权限/并发写）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readStrict, readLenient, writeAtomic, ledgerPath, tracePath, resolveHome, appendTrace } from '../lib/store.js'
import { emptyLedger, openItem } from '../lib/ledger.js'

const T0 = Date.parse('2026-10-15T00:00:00.000Z')

/** 临时目录（夹具绝不触碰生产资产） */
function tmp() {
  return mkdtempSync(join(tmpdir(), 'lh-test-'))
}

test('resolveHome：环境变量优先，缺省 ~/.dsh', () => {
  assert.equal(resolveHome({ DSH_HOME: 'E:\\alice\\.dsh' }), 'E:\\alice\\.dsh')
  assert.equal(resolveHome({ DSH_HOME: '   ' }), resolveHome({}), '空白值视同未设')
  assert.match(resolveHome({}), /\.dsh$/)
})

test('路径落点：ledger.json 与 trace.jsonl 同在 longhorizon/ 下', () => {
  const home = 'X:\\h'
  assert.equal(ledgerPath(home), join(home, 'longhorizon', 'ledger.json'))
  assert.equal(tracePath(home), join(home, 'longhorizon', 'trace.jsonl'))
})

test('readStrict：ENOENT ⇒ 空台账（首次使用是正常状态，不是错误）', () => {
  const l = readStrict(join(tmp(), 'nope.json'), (p) => readFileSync(p, 'utf8'))
  assert.equal(l.items.length, 0)
})

test('readStrict：坏 JSON ⇒ 抛错（尸体⑤：这条护栏就是防「读到空台账再写回去」）', () => {
  const dir = tmp()
  const p = join(dir, 'ledger.json')
  writeFileSync(p, '{ this is not json', 'utf8')
  assert.throws(() => readStrict(p, (x) => readFileSync(x, 'utf8')), /解析失败/)
})

test('readStrict：顶层缺 items 数组 ⇒ 抛错', () => {
  const dir = tmp()
  const p = join(dir, 'ledger.json')
  writeFileSync(p, JSON.stringify({ version: 1, entries: [] }), 'utf8')
  assert.throws(() => readStrict(p, (x) => readFileSync(x, 'utf8')), /结构异常/)
})

test('readStrict：全部条目畸形 ⇒ 抛错（尸体⑥：整库畸形与单条畸形代价不对称，取严）', () => {
  const dir = tmp()
  const p = join(dir, 'ledger.json')
  writeFileSync(p, JSON.stringify({ version: 1, items: [{ a: 1 }, { b: 2 }] }), 'utf8')
  assert.throws(() => readStrict(p, (x) => readFileSync(x, 'utf8')), /全部畸形/)
})

test('readStrict：部分畸形 ⇒ 保留合法条目（对照组：不因一条坏而弃整库）', () => {
  const dir = tmp()
  const p = join(dir, 'ledger.json')
  const good = { id: 'lh-1', title: '好', kind: 'task', openedAt: T0, updatedAt: T0, next: '做', refs: [], blockedBy: null, closedAt: null, closeNote: null }
  writeFileSync(p, JSON.stringify({ version: 1, items: [good, { junk: true }] }), 'utf8')
  const l = readStrict(p, (x) => readFileSync(x, 'utf8'))
  assert.equal(l.items.length, 1)
  assert.equal(l.items[0].title, '好')
})

test('readLenient：坏 JSON ⇒ 空台账且不抛（只读面专用，绝不可用于写路径）', () => {
  const dir = tmp()
  const p = join(dir, 'ledger.json')
  writeFileSync(p, 'garbage', 'utf8')
  assert.equal(readLenient(p, (x) => readFileSync(x, 'utf8')).items.length, 0)
})

test('writeAtomic → readStrict 往返一致；且不留下 .tmp', () => {
  const dir = tmp()
  const p = join(dir, 'longhorizon', 'ledger.json')
  const r = openItem(emptyLedger(), { title: '一件', kind: 'waiting', next: '等 X', blockedBy: 'X' }, T0, () => 0.5)
  assert.equal(r.ok, true)
  writeAtomic(p, r.ledger)
  const back = readStrict(p, (x) => readFileSync(x, 'utf8'))
  assert.equal(back.items.length, 1)
  assert.equal(back.items[0].blockedBy, 'X')
  assert.throws(() => readFileSync(p + '.tmp', 'utf8'), /ENOENT/)
})

test('appendTrace：不可写路径 ⇒ 返回 false 且**不抛**（尸体⑦：观测绝不反噬主流程）', () => {
  const dir = tmp()
  // 用一个「父级是文件」的路径让 mkdir/append 必然失败
  const file = join(dir, 'afile')
  writeFileSync(file, 'x', 'utf8')
  const ok = appendTrace(join(file, 'sub'), { stage: 'test' })
  assert.equal(ok, false)
})

test('appendTrace：正常路径 ⇒ 返回 true 且落一行 JSONL', () => {
  const dir = tmp()
  const ok = appendTrace(dir, { stage: 'open', id: 'lh-1' })
  assert.equal(ok, true)
  const raw = readFileSync(tracePath(dir), 'utf8').trim()
  const row = JSON.parse(raw)
  assert.equal(row.stage, 'open')
  assert.equal(row.id, 'lh-1')
  assert.equal(typeof row.at, 'string')
  rmSync(dir, { recursive: true, force: true })
})
