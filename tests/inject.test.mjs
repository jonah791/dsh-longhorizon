/**
 * inject.test.mjs — 注入判据测试（论文最关键的一步：读数出现在**执行路径**上）。
 *
 * 为什么这一组必须测：注入面是**每 step** 触发的（一个长 turn 里有几十个 step），
 * 去重坏掉的后果不是「少一个读数」而是**刷屏**——而刷屏的读数会被我自己无视，
 * 与「不注入」等价甚至更糟。所以去重键的三个维度（会话 / 小时 / 内容）各配一条尸体。
 *
 * 用假 ctx（记录监听器）而不是真 cordis：本文件只验证**决策**，不验证接线
 * （接线由预检 + 重启后的活体读数覆盖）。
 *
 * ⚠ 天花板：本文件不证明注入真的进了模型请求——那要由会话日志里出现
 * source.kind='dsh-longhorizon' 的消息来证明（活体验收）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installInject, isUserSession, dedupeKey } from '../lib/inject.js'
import { emptyLedger, openItem } from '../lib/ledger.js'

const DAY = 86_400_000
const T0 = Date.parse('2026-10-15T04:00:00.000Z')
const SID = 'session-12345678-1234-1234-1234-123456789abc'
const DERIVED = 'b2700a04-1111-2222-3333-444455556666'
/** 变化的伪随机源（固定值会撞 id，被实现的碰撞护栏拦住——那是另一条尸体测试的事） */
let seq = 0
const rand = () => { seq = (seq + 0.137) % 1; return seq }

/** 假 ctx：只记录监听器，供手动触发 */
function fakeCtx() {
  const handlers = []
  return {
    handlers,
    on(event, fn, opts) { handlers.push({ event, fn, opts }) },
  }
}

/** 建一本含 n 条 task 的台账 */
function ledgerWith(n) {
  let l = emptyLedger()
  for (let i = 0; i < n; i += 1) {
    const r = openItem(l, { title: `事 ${i}`, kind: 'task', next: `做 ${i}` }, T0, rand)
    assert.equal(r.ok, true)
    l = r.ledger
  }
  return l
}

/** 触发一次 pre-step（返回 decision） */
async function step(ctx, sessionId, decision = { kind: 'enter', messages: [] }) {
  const h = ctx.handlers.find((x) => x.event === 'agent/pre-step')
  assert.ok(h, '应已注册 agent/pre-step')
  return h.fn({ agent: { session: { id: sessionId } } }, async () => decision)
}

test('isUserSession：人类会话（session-<uuid>）判真，裸 uuid 判假（判据双向）', () => {
  assert.equal(isUserSession(SID), true)
  assert.equal(isUserSession(DERIVED), false, '派生会话是裸 uuid——不注入，避免污染子代理会话')
  assert.equal(isUserSession(''), false)
  assert.equal(isUserSession('session-not-a-uuid'), false)
})

test('dedupeKey：会话 / 小时 / 内容 三维各自可分', () => {
  const base = dedupeKey(SID, 'L', new Date(T0))
  assert.equal(dedupeKey(SID, 'L', new Date(T0)), base, '同会话同小时同内容 ⇒ 同键')
  assert.notEqual(dedupeKey(DERIVED, 'L', new Date(T0)), base, '会话变 ⇒ 异键')
  assert.notEqual(dedupeKey(SID, 'L2', new Date(T0)), base, '内容变 ⇒ 异键')
  assert.notEqual(dedupeKey(SID, 'L', new Date(T0 + 3_600_000)), base, '跨小时 ⇒ 异键')
})

test('有台账 ⇒ 注入一条，source.kind 为 dsh-longhorizon，且追加在批次末尾', async () => {
  const ctx = fakeCtx()
  installInject(ctx, { loadLedger: () => ledgerWith(2), now: () => T0 })
  const d = await step(ctx, SID)
  assert.equal(d.kind, 'enter')
  assert.equal(d.messages.length, 1)
  assert.equal(d.messages[0].source.kind, 'dsh-longhorizon')
  assert.match(d.messages[0].content[0].text, /未完成 2/)
})

test('尸体①：同会话同小时同内容 ⇒ 第二次不注入（防刷屏——每 step 都会触发）', async () => {
  const ctx = fakeCtx()
  installInject(ctx, { loadLedger: () => ledgerWith(1), now: () => T0 })
  await step(ctx, SID)
  const second = await step(ctx, SID)
  assert.equal(second.messages.length, 0, '去重坏掉 = 一个长 turn 里注入几十次')
})

test('闭环：内容变了（新登记一条）⇒ 立刻重注入新读数', async () => {
  const ctx = fakeCtx()
  let l = ledgerWith(1)
  installInject(ctx, { loadLedger: () => l, now: () => T0 })
  await step(ctx, SID)
  const r = openItem(l, { title: '新事', kind: 'issue', next: '看它' }, T0, rand)
  assert.equal(r.ok, true)
  l = r.ledger
  const second = await step(ctx, SID)
  assert.equal(second.messages.length, 1, '内容变 ⇒ 重注入')
  assert.match(second.messages[0].content[0].text, /未完成 2/)
})

test('跨小时 ⇒ 重注入（读数新鲜）', async () => {
  const ctx = fakeCtx()
  let t = T0
  installInject(ctx, { loadLedger: () => ledgerWith(1), now: () => t })
  await step(ctx, SID)
  t = T0 + 3_600_000
  const second = await step(ctx, SID)
  assert.equal(second.messages.length, 1)
})

test('尸体②：裸 uuid 会话（子代理）⇒ 不注入', async () => {
  const ctx = fakeCtx()
  installInject(ctx, { loadLedger: () => ledgerWith(3), now: () => T0 })
  const d = await step(ctx, DERIVED)
  assert.equal(d.messages.length, 0)
})

test('空台账 ⇒ 不注入（没有未完成项时不留噪音）', async () => {
  const ctx = fakeCtx()
  installInject(ctx, { loadLedger: () => emptyLedger(), now: () => T0 })
  const d = await step(ctx, SID)
  assert.equal(d.messages.length, 0)
})

test('decision.kind !== enter ⇒ 原样返回（不破坏瀑布链）', async () => {
  const ctx = fakeCtx()
  installInject(ctx, { loadLedger: () => ledgerWith(1), now: () => T0 })
  const reject = { kind: 'reject', reason: 'x' }
  const d = await step(ctx, SID, reject)
  assert.equal(d, reject, '必须原样放行——吞掉别人的 decision 会破坏整条链')
})

test('已注入的消息保持在原批次之后（缓存友好：只动尾部）', async () => {
  const ctx = fakeCtx()
  installInject(ctx, { loadLedger: () => ledgerWith(1), now: () => T0 })
  const prior = { kind: 'enter', messages: [{ source: { kind: 'other' } }] }
  const d = await step(ctx, SID, prior)
  assert.equal(d.messages.length, 2)
  assert.equal(d.messages[0].source.kind, 'other', '原有消息位置不变')
})
