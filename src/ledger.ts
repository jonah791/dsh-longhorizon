/**
 * ledger.ts — 长时域未完成项台账的纯逻辑层（无 I/O、无 ctx，离线可测）
 *
 * 为什么需要它（论文 SkillHorizon，arXiv:2610.14966v1）：
 * - 54.0% 的失败终局是「完成 <25% 的局部目标 ∧ 还剩 >50% 的工具额度」——不是做不动，是提前收工。
 * - 论文给的**中性确认提示不改变行为**：GPT 在 1M DocOps 上只做 11/81 页、用掉 172/1715 次额度，
 *   收到确认后**仍然**再交一次 final，90% 额度剩余，压缩甚至还没发生。
 * ⇒ 提醒无效，除非读数出现在**执行路径**上。本模块产出**一行读数**，由 inject.ts 每轮送达。
 *
 * 三分层（task / waiting / issue）不是装饰：
 * 不分层时读数会退化成「永远有 N 条推不动」⇒ 被我自己无视（同一机制在同一主体上失效的形状）。
 *
 * `next` 字段必填，且必须是**下一步可执行动作**——这是论文「局部完成 ≠ 全局交付」的对策：
 * 写不出下一步的条目，要么是我没想清，要么它该被关闭。
 */

/** 条目类别：我能推的 / 等外部的 / 已知问题 */
export type Kind = 'task' | 'waiting' | 'issue'

/** 台账条目 */
export interface Item {
  id: string
  title: string
  kind: Kind
  openedAt: number
  updatedAt: number
  /** 下一步可执行动作（必填非空）——空 ⇒ 登记被拒 */
  next: string
  /** 产物指针：path:line / 工具名 / 会话 id（论文的 identity 判据） */
  refs: string[]
  /** kind=waiting 时：等谁 / 等什么 */
  blockedBy: string | null
  closedAt: number | null
  closeNote: string | null
}

/** 台账根 */
export interface Ledger {
  version: 1
  items: Item[]
}

export const LEDGER_VERSION = 1

const KINDS: readonly Kind[] = ['task', 'waiting', 'issue']
const DAY_MS = 86_400_000

/** 空台账 */
export function emptyLedger(): Ledger {
  return { version: LEDGER_VERSION, items: [] }
}

/** 是否未关闭 */
export function isOpen(item: Item): boolean {
  return item.closedAt === null
}

/** 未关闭条目（按 openedAt 升序：最老的在前） */
export function openItems(ledger: Ledger): Item[] {
  return ledger.items.filter(isOpen).sort((a, b) => a.openedAt - b.openedAt)
}

/** 条龄（天，保留 1 位小数由渲染层负责） */
export function ageDays(item: Item, now: number): number {
  return (now - item.openedAt) / DAY_MS
}

/** 最老的未关闭条目 */
export function oldestOpen(ledger: Ledger, now: number): { item: Item; days: number } | null {
  const open = openItems(ledger)
  const first = open[0]
  if (first === undefined) return null
  return { item: first, days: ageDays(first, now) }
}

/** 生成条目 id（lh- + 8 位十六进制） */
export function nextId(rand: () => number = Math.random): string {
  let hex = ''
  while (hex.length < 8) hex += Math.floor(rand() * 0x100000000).toString(16).padStart(8, '0')
  return `lh-${hex.slice(0, 8)}`
}

/**
 * 一行读数（注入用）。
 *
 * 形状固定——**不因类别缺失而变**：读数形状变化会逼我每次重新解析它，
 * 而它一天要出现几十次。空台账返回空串（调用方据此跳过注入）。
 */
export function renderLine(ledger: Ledger, now: number): string {
  const open = openItems(ledger)
  if (open.length === 0) return ''
  const count = (k: Kind): number => open.filter((it) => it.kind === k).length
  const oldest = oldestOpen(ledger, now)
  const age = oldest === null ? 0 : oldest.days
  return `【长时域】未完成 ${open.length} · 可推 ${count('task')} · 等外部 ${count('waiting')}`
    + ` · 问题 ${count('issue')} · 最老 ${age.toFixed(1)}d`
}

/** 多行明细（工具用；`now` 决定条龄） */
export function renderStatus(ledger: Ledger, now: number): string {
  const open = openItems(ledger)
  const closed = ledger.items.filter((it) => !isOpen(it)).length
  if (open.length === 0) {
    return `【长时域】未完成 0（累计已关 ${closed}）`
  }
  const lines = open.map((it) => {
    const age = ageDays(it, now).toFixed(1)
    const wait = it.blockedBy !== null && it.blockedBy !== '' ? ` ← 等：${it.blockedBy}` : ''
    const refs = it.refs.length > 0 ? `\n      refs: ${it.refs.join(' · ')}` : ''
    return `  [${it.kind}] ${it.id}  ${age}d  ${it.title}${wait}\n      下一步：${it.next}${refs}`
  })
  return `【长时域】未完成 ${open.length}（累计已关 ${closed}）\n${lines.join('\n')}`
}

/** 登记结果 */
export type OpenResult =
  | { ok: true; ledger: Ledger; id: string }
  | { ok: false; error: string }

/**
 * 登记一条未完成项。
 *
 * 拒绝条件（fail-loud，不静默接受）：
 * - title / next 为空 —— `next` 空等于把「做完没有」交给未来的我猜
 * - kind 非法
 * - 与**未关闭**条目标题完全相同 —— 防同一件事被登记两次（重复登记会让读数虚高，
 *   而虚高的读数与「永远推不动」一样会被无视）
 */
export function openItem(
  ledger: Ledger,
  input: { title: string; kind: Kind; next: string; refs?: string[]; blockedBy?: string | null },
  now: number,
  rand?: () => number,
): OpenResult {
  const title = input.title.trim()
  const next = input.next.trim()
  if (title === '') return { ok: false, error: 'title 不能为空' }
  if (next === '') return { ok: false, error: 'next 不能为空——写不出下一步的条目不该被登记' }
  if (!KINDS.includes(input.kind)) {
    return { ok: false, error: `kind 非法：${String(input.kind)}（应为 ${KINDS.join(' / ')}）` }
  }
  const dup = openItems(ledger).find((it) => it.title === title)
  if (dup !== undefined) {
    return { ok: false, error: `同标题条目未关闭：${dup.id}（改用 update 或先 close）` }
  }
  // id 唯一性护栏（2026-10-15 由测试抓出）：固定/退化随机源会让 nextId 反复产出同一 id，
  // 而 close/update 都**按 id 定位**（findIndex 命中第一条）⇒ 撞 id 的后果是**关错条目**。
  // 宁可拒绝，不可静默覆盖——这条护栏的代价是极端情况下登记失败，收益是台账不会被改错。
  let id = nextId(rand)
  let guard = 0
  while (ledger.items.some((it) => it.id === id)) {
    guard += 1
    if (guard > 16) {
      return { ok: false, error: 'id 生成连续碰撞 16 次——随机源退化，拒绝登记以免覆盖既有条目' }
    }
    id = nextId(rand)
  }
  const item: Item = {
    id,
    title,
    kind: input.kind,
    openedAt: now,
    updatedAt: now,
    next,
    refs: input.refs ?? [],
    blockedBy: input.blockedBy ?? null,
    closedAt: null,
    closeNote: null,
  }
  return { ok: true, ledger: { ...ledger, items: [...ledger.items, item] }, id }
}

/** 更新结果 */
export type MutateResult =
  | { ok: true; ledger: Ledger }
  | { ok: false; error: string }

/** 更新一条未关闭项（只改给到的字段；`next` 若给则不可为空） */
export function updateItem(
  ledger: Ledger,
  id: string,
  patch: { title?: string; kind?: Kind; next?: string; refs?: string[]; blockedBy?: string | null },
  now: number,
): MutateResult {
  const idx = ledger.items.findIndex((it) => it.id === id)
  if (idx < 0) return { ok: false, error: `找不到条目：${id}` }
  const cur = ledger.items[idx]
  if (cur === undefined) return { ok: false, error: `找不到条目：${id}` }
  if (!isOpen(cur)) return { ok: false, error: `条目已关闭：${id}（已关闭的条目不再修改）` }
  if (patch.next !== undefined && patch.next.trim() === '') {
    return { ok: false, error: 'next 不能改为空' }
  }
  if (patch.kind !== undefined && !KINDS.includes(patch.kind)) {
    return { ok: false, error: `kind 非法：${String(patch.kind)}` }
  }
  const updated: Item = {
    ...cur,
    title: patch.title !== undefined ? patch.title.trim() : cur.title,
    kind: patch.kind ?? cur.kind,
    next: patch.next !== undefined ? patch.next.trim() : cur.next,
    refs: patch.refs ?? cur.refs,
    blockedBy: patch.blockedBy !== undefined ? patch.blockedBy : cur.blockedBy,
    updatedAt: now,
  }
  const items = [...ledger.items]
  items[idx] = updated
  return { ok: true, ledger: { ...ledger, items } }
}

/** 关闭一条未关闭项（`note` 必填：关闭理由与登记理由一样要留痕） */
export function closeItem(ledger: Ledger, id: string, note: string, now: number): MutateResult {
  const idx = ledger.items.findIndex((it) => it.id === id)
  if (idx < 0) return { ok: false, error: `找不到条目：${id}` }
  const cur = ledger.items[idx]
  if (cur === undefined) return { ok: false, error: `找不到条目：${id}` }
  if (!isOpen(cur)) return { ok: false, error: `条目已关闭：${id}` }
  const trimmed = note.trim()
  if (trimmed === '') return { ok: false, error: 'closeNote 不能为空——关闭理由要留痕' }
  const items = [...ledger.items]
  items[idx] = { ...cur, closedAt: now, closeNote: trimmed, updatedAt: now }
  return { ok: true, ledger: { ...ledger, items } }
}

/**
 * 读盘容错：丢弃畸形条目而不是整库报错。
 *
 * 边界诚实：被丢弃的条目数由调用方（store 层）留证——静默丢弃等于伪造一个更干净的台账。
 */
export function normalizeLedger(raw: unknown): { ledger: Ledger; dropped: number } {
  if (raw === null || typeof raw !== 'object') return { ledger: emptyLedger(), dropped: 0 }
  const obj = raw as { items?: unknown }
  if (!Array.isArray(obj.items)) return { ledger: emptyLedger(), dropped: 0 }
  const items: Item[] = []
  let dropped = 0
  for (const entry of obj.items) {
    if (entry === null || typeof entry !== 'object') {
      dropped += 1
      continue
    }
    const e = entry as Record<string, unknown>
    const kind = e.kind
    if (
      typeof e.id !== 'string' || typeof e.title !== 'string' || typeof e.next !== 'string'
      || typeof e.openedAt !== 'number' || typeof e.updatedAt !== 'number'
      || typeof kind !== 'string' || !KINDS.includes(kind as Kind)
    ) {
      dropped += 1
      continue
    }
    items.push({
      id: e.id,
      title: e.title,
      kind: kind as Kind,
      openedAt: e.openedAt,
      updatedAt: e.updatedAt,
      next: e.next,
      refs: Array.isArray(e.refs) ? e.refs.filter((r): r is string => typeof r === 'string') : [],
      blockedBy: typeof e.blockedBy === 'string' ? e.blockedBy : null,
      closedAt: typeof e.closedAt === 'number' ? e.closedAt : null,
      closeNote: typeof e.closeNote === 'string' ? e.closeNote : null,
    })
  }
  return { ledger: { version: LEDGER_VERSION, items }, dropped }
}
