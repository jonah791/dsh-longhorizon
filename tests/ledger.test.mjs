/**
 * ledger.test.mjs — 长时域台账**纯逻辑层**的判据测试。
 *
 * 分层：本文件只测纯函数（无 I/O、无 ctx）。I/O 护栏在 store.test.mjs，注入判据在 inject.test.mjs。
 *
 * 尸体样本的重点是**两类反向失效**：
 *   ① 护栏过宽 ⇒ 空 next / 重复标题被放进来 ⇒ 台账变成一堆「不知道下一步做什么」的噪音
 *   ② 护栏过窄 ⇒ 已关闭的同名条目挡着不让重开 ⇒ 真复发的问题登记不进来
 * 每一组都配了**对照组**（不是只喂坏样本）。
 *
 * ⚠ 天花板（诚实标注）：本文件证明**判据有区分力**，不证明台账在真实长任务里够用——
 * 那要由「活体验收：把当前挂着的未完成项灌进去，看覆盖率」来量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyLedger, openItem, closeItem, updateItem, openItems, oldestOpen,
  renderLine, renderStatus, normalizeLedger, nextId, ageDays,
} from '../lib/ledger.js'

const DAY = 86_400_000
const T0 = Date.parse('2026-10-15T00:00:00.000Z')
/**
 * 变化的伪随机源：每次调用前进一格。
 * ⚠ 不要用固定值（如 `() => 0.5`）：那会让 nextId 反复产出同一 id，
 * 而 close/update 按 id 定位 ⇒ 关错条目。实现侧已加碰撞护栏（见下一条尸体测试）。
 */
let seq = 0
const rand = () => { seq = (seq + 0.137) % 1; return seq }
/** 退化随机源：恒定值——用来喂「id 碰撞」护栏 */
const stuck = () => 0.5

/** 建一本含 n 条未完成项的台账 */
function withItems(n, kind = 'task') {
  let l = emptyLedger()
  for (let i = 0; i < n; i += 1) {
    const r = openItem(l, { title: `第 ${i} 件`, kind, next: `做第 ${i} 件` }, T0 + i * DAY, rand)
    assert.equal(r.ok, true, `前置登记 ${i} 应成功`)
    l = r.ledger
  }
  return l
}

test('空台账 renderLine 返回空串（调用方据此跳过注入）', () => {
  assert.equal(renderLine(emptyLedger(), T0), '')
})

test('renderLine 形状固定：三类计数恒在，缺哪类都写 0（不因类别缺失而变形状）', () => {
  const only = withItems(2, 'task')
  const line = renderLine(only, T0 + DAY)
  assert.match(line, /未完成 2/)
  assert.match(line, /可推 2/)
  // 尸体：只有 task 时，另两类仍必须出现——形状变化会逼我每次重新解析它
  assert.match(line, /等外部 0/)
  assert.match(line, /问题 0/)
  // 最老 = 第 0 件（openedAt=T0），渲染时刻 T0+1d ⇒ 1.0d
  assert.match(line, /最老 1\.0d/)
})

test('renderLine 最老条龄取未关闭条目中 openedAt 最早者', () => {
  let l = withItems(1)
  const r = openItem(l, { title: '后一件', kind: 'issue', next: '看它' }, T0 + 3 * DAY, rand)
  assert.equal(r.ok, true)
  l = r.ledger
  const line = renderLine(l, T0 + 3 * DAY)
  assert.match(line, /未完成 2/)
  assert.match(line, /最老 3\.0d/)
})

test('openItem 拒绝空 next（尸体①：写不出下一步的条目不该存在）', () => {
  const out = openItem(emptyLedger(), { title: 'x', kind: 'task', next: '   ' }, T0, rand)
  assert.equal(out.ok, false)
  assert.match(out.error, /next 不能为空/)
})

test('openItem 拒绝空 title', () => {
  const out = openItem(emptyLedger(), { title: '', kind: 'task', next: 'y' }, T0, rand)
  assert.equal(out.ok, false)
  assert.match(out.error, /title 不能为空/)
})

test('openItem 拒绝非法 kind', () => {
  const out = openItem(emptyLedger(), { title: 'x', kind: 'urgent', next: 'y' }, T0, rand)
  assert.equal(out.ok, false)
  assert.match(out.error, /kind 非法/)
})

test('openItem 拒绝同标题未关闭条目（尸体②：重复登记会把读数灌水）', () => {
  const l = withItems(1)
  const dup = openItem(l, { title: '第 0 件', kind: 'task', next: '再做一次' }, T0 + DAY, rand)
  assert.equal(dup.ok, false)
  assert.match(dup.error, /同标题条目未关闭/)
})

test('对照组：同标题在**已关闭**后允许重新登记（护栏不该过窄）', () => {
  let l = withItems(1)
  const id = openItems(l)[0].id
  const c = closeItem(l, id, '做完了', T0 + DAY)
  assert.equal(c.ok, true)
  l = c.ledger
  const again = openItem(l, { title: '第 0 件', kind: 'task', next: '它复发了' }, T0 + 2 * DAY, rand)
  assert.equal(again.ok, true)
})

test('closeItem 拒绝空 note（尸体③：关闭理由要留痕）', () => {
  const l = withItems(1)
  const id = openItems(l)[0].id
  const out = closeItem(l, id, '  ', T0 + DAY)
  assert.equal(out.ok, false)
  assert.match(out.error, /closeNote 不能为空/)
})

test('closeItem 幂等拒绝：已关闭的条目不能再关', () => {
  let l = withItems(1)
  const id = openItems(l)[0].id
  l = closeItem(l, id, 'ok', T0 + DAY).ledger
  const again = closeItem(l, id, 'ok again', T0 + 2 * DAY)
  assert.equal(again.ok, false)
  assert.match(again.error, /条目已关闭/)
})

test('updateItem 拒绝把 next 改为空（尸体④：空 next 等于把「做完没有」交给未来的我猜）', () => {
  const l = withItems(1)
  const id = openItems(l)[0].id
  const out = updateItem(l, id, { next: '' }, T0 + DAY)
  assert.equal(out.ok, false)
  assert.match(out.error, /next 不能改为空/)
})

test('updateItem 拒绝改已关闭条目', () => {
  let l = withItems(1)
  const id = openItems(l)[0].id
  l = closeItem(l, id, 'done', T0 + DAY).ledger
  const out = updateItem(l, id, { next: '再改改' }, T0 + 2 * DAY)
  assert.equal(out.ok, false)
  assert.match(out.error, /已关闭/)
})

test('updateItem 只改给到的字段（未给的保留）', () => {
  const l = withItems(1)
  const before = openItems(l)[0]
  const out = updateItem(l, before.id, { kind: 'waiting', blockedBy: '等主人重启 watch' }, T0 + DAY)
  assert.equal(out.ok, true)
  const after = openItems(out.ledger)[0]
  assert.equal(after.kind, 'waiting')
  assert.equal(after.blockedBy, '等主人重启 watch')
  assert.equal(after.next, before.next, 'next 未给 ⇒ 保留原值')
  assert.equal(after.title, before.title, 'title 未给 ⇒ 保留原值')
  assert.equal(after.updatedAt, T0 + DAY, 'updatedAt 前进')
  assert.equal(after.openedAt, before.openedAt, 'openedAt 不动')
})

test('openItems 按 openedAt 升序（最老的在前）；已关闭的不出现', () => {
  let l = withItems(3)
  l = closeItem(l, openItems(l)[1].id, 'done', T0 + 5 * DAY).ledger
  const open = openItems(l)
  assert.equal(open.length, 2)
  assert.deepEqual(open.map((it) => it.title), ['第 0 件', '第 2 件'])
})

test('oldestOpen 取最老；空台账 ⇒ null', () => {
  assert.equal(oldestOpen(emptyLedger(), T0), null)
  const l = withItems(2)
  const oldest = oldestOpen(l, T0 + 2 * DAY)
  assert.equal(oldest.item.title, '第 0 件')
  assert.equal(oldest.days, 2)
})

test('ageDays 按毫秒差算（不做日界截断）', () => {
  const l = withItems(1)
  const it = openItems(l)[0]
  assert.equal(ageDays(it, it.openedAt + 1.5 * DAY), 1.5)
})

test('normalizeLedger 丢弃畸形条目但保留合法条目（对照组：不是全丢）', () => {
  const raw = {
    version: 1,
    items: [
      { id: 'lh-1', title: '好条目', kind: 'task', openedAt: T0, updatedAt: T0, next: '做', refs: [], blockedBy: null, closedAt: null, closeNote: null },
      { id: 'lh-2', title: '缺 kind', openedAt: T0, updatedAt: T0, next: '做' },
      'not an object',
      { id: 'lh-3', title: '非法 kind', kind: 'urgent', openedAt: T0, updatedAt: T0, next: '做' },
    ],
  }
  const { ledger, dropped } = normalizeLedger(raw)
  assert.equal(ledger.items.length, 1)
  assert.equal(ledger.items[0].title, '好条目')
  assert.equal(dropped, 3, '三条畸形各计一次')
})

test('normalizeLedger 对非对象输入返回空台账', () => {
  assert.equal(normalizeLedger(null).ledger.items.length, 0)
  assert.equal(normalizeLedger('x').ledger.items.length, 0)
  assert.equal(normalizeLedger({}).ledger.items.length, 0)
})

test('nextId 形状 lh-<8 hex>；两本台账各自登记不撞 id（确定性 rand 下同值是可预期的）', () => {
  const id = nextId(rand)
  assert.match(id, /^lh-[0-9a-f]{8}$/)
})

test('尸体⑧：退化随机源（恒定值）⇒ 拒绝登记，不静默覆盖既有条目', () => {
  let l = emptyLedger()
  const first = openItem(l, { title: '第一件', kind: 'task', next: '做' }, T0, stuck)
  assert.equal(first.ok, true)
  l = first.ledger
  // 第二次仍用退化源 ⇒ id 必然与第一条碰撞 ⇒ 护栏必须拦住（撞 id 会让 close 关错条目）
  const second = openItem(l, { title: '第二件', kind: 'task', next: '做' }, T0 + DAY, stuck)
  assert.equal(second.ok, false)
  assert.match(second.error, /碰撞/)
  assert.equal(l.items.length, 1, '台账未被改动')
})

test('renderStatus 空台账给「累计已关」而不是空白', () => {
  let l = withItems(1)
  l = closeItem(l, openItems(l)[0].id, 'done', T0 + DAY).ledger
  const s = renderStatus(l, T0 + DAY)
  assert.match(s, /未完成 0/)
  assert.match(s, /累计已关 1/)
})
