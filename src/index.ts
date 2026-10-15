/**
 * dsh-longhorizon — 长时域未完成项台账 + 每轮一行读数注入。
 *
 * 论文依据（SkillHorizon, arXiv:2610.14966v1）：长时域失败的主形状不是「做不动」，
 * 而是**提前收工**——1M 档 54.0% 的失败终局是「完成 <25% 局部目标 ∧ 还剩 >50% 工具额度」；
 * 且论文给的**中性确认提示不改变行为**。⇒ 提醒无效，除非读数出现在执行路径上。
 *
 * 本插件做三件事：
 *   ① 台账（`<DSH_HOME>/longhorizon/ledger.json`）——独立落盘，压缩不影响；每条带
 *      `next`（下一步可执行动作）与 `refs`（产物指针）= 论文的「局部完成 ≠ 全局交付」对策。
 *   ② 四个工具（status / open / update / close）——决策归爱丽丝，本插件只维护台账与读数。
 *   ③ 每轮一行读数注入（inject.ts）——读数出现在执行路径上，不靠我想起来。
 *
 * 写路径纪律：严格读 + 原子写 + 留痕（`trace.jsonl`）；读路径可宽松（§5.22 / board.ts 教训）。
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  closeItem,
  openItem,
  openItems,
  oldestOpen,
  renderLine,
  renderStatus,
  updateItem,
  type Item,
  type Kind,
  type Ledger,
} from './ledger.ts'
import { appendTrace, ledgerPath, readLenient, readStrict, resolveHome, writeAtomic } from './store.ts'
import { installInject } from './inject.ts'

export const name = 'agent-longhorizon'
export const inject = ['tools', 'agents'] as const

export interface Config {
  enabled: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
})

const KINDS: readonly Kind[] = ['task', 'waiting', 'issue']

/** 台账条目视图（工具出参） */
interface ItemView {
  id: string
  title: string
  kind: string
  ageDays: number
  next: string
  refs: string[]
  blockedBy: string
  updatedAt: string
}

function viewOf(item: Item, now: number): ItemView {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    ageDays: Number(((now - item.openedAt) / 86_400_000).toFixed(1)),
    next: item.next,
    refs: item.refs,
    blockedBy: item.blockedBy ?? '',
    updatedAt: new Date(item.updatedAt).toISOString(),
  }
}

/** 写操作结果（`id` 由 open 透传，避免调用方「取最后一条」猜 id） */
type MutOut = { ok: true; ledger: Ledger; id?: string } | { ok: false; error: string }

export function apply(ctx: Context, config: Config): void {
  const home = resolveHome()
  const path = ledgerPath(home)
  const read = (p: string): string => readFileSync(p, 'utf8')
  const now = (): number => Date.now()

  /** 只读面：宽松读（台账坏时给空读数，绝不让注入面崩） */
  const loadLenient = (): Ledger => readLenient(path, read)

  /**
   * 写面：严格读 ⇒ 变更 ⇒ 原子写 ⇒ 留痕。
   * 严格读失败 ⇒ 拒绝写（否则损坏台账会被一次写入覆盖成「只有刚写的那条」= 静默销毁）。
   */
  const mutate = (stage: string, fn: (l: Ledger) => MutOut): MutOut => {
    let ledger: Ledger
    try {
      ledger = readStrict(path, read)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      appendTrace(home, { stage, ok: false, error: msg })
      return { ok: false, error: msg }
    }
    const out = fn(ledger)
    if (!out.ok) {
      appendTrace(home, { stage, ok: false, error: out.error })
      return out
    }
    try {
      writeAtomic(path, out.ledger)
    } catch (e: unknown) {
      const msg = '写盘失败：' + (e instanceof Error ? e.message : String(e))
      appendTrace(home, { stage, ok: false, error: msg })
      return { ok: false, error: msg }
    }
    return out
  }

  const statusTool: ToolDefinition = defineTool({
    name: 'longhorizon_status',
    description:
      '长时域未完成项读数：未关闭条目总数 + 三分层计数（task 我能推 / waiting 等外部 / issue 已知问题）+ 最老条龄。'
      + '每轮上下文已自动注入一行摘要；本工具给明细（每条含「下一步」与产物指针 refs）。'
      + '用途：收工前对照「还剩几件、最老多久」——论文 SkillHorizon 实测，长时域失败的主形状是'
      + '「活没干完、额度还剩一半」（1M 档 54.0%），而中性提醒不改变行为。',
    parameters: {
      kind: { type: 'string', description: '按类别过滤：task | waiting | issue（缺省全部）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          line: { type: 'string', required: true },
          total: { type: 'number', required: true },
          task: { type: 'number', required: true },
          waiting: { type: 'number', required: true },
          issue: { type: 'number', required: true },
          closed: { type: 'number', required: true },
          oldestDays: { type: 'number', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                ageDays: { type: 'number', required: true },
                next: { type: 'string', required: true },
                refs: { type: 'array', required: true, items: { type: 'string' } },
                blockedBy: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
              },
            },
          },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => {
        const v = value as {
          line: string
          total: number
          closed: number
          entries: ItemView[]
          note: string
        }
        const head = v.line === ''
          ? `【长时域】未完成 0（累计已关 ${v.closed}）——台账干净`
          : v.line
        const rows = v.entries.map((e) => {
          const wait = e.blockedBy !== '' ? ` ← 等：${e.blockedBy}` : ''
          const refs = e.refs.length > 0 ? `\n      refs: ${e.refs.join(' · ')}` : ''
          return `  [${e.kind}] ${e.id}  ${e.ageDays}d  ${e.title}${wait}\n      下一步：${e.next}${refs}`
        })
        return [{ type: 'text', text: [head, ...rows, v.note].join('\n') }]
      },
    },
    async execute(args) {
      const ledger = loadLenient()
      const nowMs = now()
      const all = openItems(ledger)
      const kindFilter = typeof args.kind === 'string' && args.kind !== '' ? args.kind : ''
      if (kindFilter !== '' && !KINDS.includes(kindFilter as Kind)) {
        return {
          line: '',
          total: all.length,
          task: 0,
          waiting: 0,
          issue: 0,
          closed: ledger.items.length - all.length,
          oldestDays: 0,
          entries: [],
          note: `kind 过滤值非法「${kindFilter}」（应为 ${KINDS.join(' | ')}）——按不过滤返回。`,
        }
      }
      const shown = kindFilter === '' ? all : all.filter((it) => it.kind === kindFilter)
      const oldest = oldestOpen(ledger, nowMs)
      const note = all.length === 0
        ? '台账为空：没有挂着的未完成项。'
        : '按登记时间升序（最老的在前）。每条都带「下一步」——写不出下一步的条目不该存在（论文的「局部完成 ≠ 全局交付」对策）。'
      return {
        line: renderLine(ledger, nowMs),
        total: all.length,
        task: all.filter((it) => it.kind === 'task').length,
        waiting: all.filter((it) => it.kind === 'waiting').length,
        issue: all.filter((it) => it.kind === 'issue').length,
        closed: ledger.items.length - all.length,
        oldestDays: oldest === null ? 0 : Number(oldest.days.toFixed(1)),
        entries: shown.map((it) => viewOf(it, nowMs)),
        note,
      }
    },
  })

  const openTool: ToolDefinition = defineTool({
    name: 'longhorizon_open',
    description:
      '登记一条未完成项。kind：task（我能推的）/ waiting（等外部，须写 blockedBy）/ issue（已知问题）。'
      + 'next 必填且必须是**下一步可执行动作**——写不出来说明还没想清，或它不该被登记。'
      + '同标题未关闭条目会被拒（防重复登记把读数灌水）。',
    parameters: {
      title: { type: 'string', description: '一句话说明（未完成的是什么）', required: true },
      kind: { type: 'string', description: 'task | waiting | issue', required: true },
      next: { type: 'string', description: '下一步可执行动作（非空）', required: true },
      refs: { type: 'array', description: '产物指针：path:line / 工具名 / 会话 id（论文的 identity 判据）' },
      blockedBy: { type: 'string', description: 'kind=waiting 时：等谁 / 等什么' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          line: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => {
        const v = value as { ok: boolean; id: string; line: string; note: string }
        return [{ type: 'text', text: (v.ok ? '✅ ' : '❌ ') + v.note + (v.line === '' ? '' : '\n' + v.line) }]
      },
    },
    async execute(args) {
      const kind = typeof args.kind === 'string' ? args.kind : ''
      if (!KINDS.includes(kind as Kind)) {
        return { ok: false, id: '', line: '', note: `kind 非法「${kind}」（应为 ${KINDS.join(' | ')}）——未登记。` }
      }
      const refs = Array.isArray(args.refs) ? args.refs.filter((r): r is string => typeof r === 'string') : []
      const out = mutate('open', (l) => {
        const r = openItem(l, {
          title: String(args.title ?? ''),
          kind: kind as Kind,
          next: String(args.next ?? ''),
          refs,
          blockedBy: typeof args.blockedBy === 'string' && args.blockedBy !== '' ? args.blockedBy : null,
        }, now())
        return r.ok ? { ok: true, ledger: r.ledger, id: r.id } : r
      })
      if (!out.ok) return { ok: false, id: '', line: '', note: '未登记：' + out.error }
      const id = out.id ?? ''
      appendTrace(home, { stage: 'open', ok: true, id, title: String(args.title ?? '') })
      return { ok: true, id, line: renderLine(out.ledger, now()), note: `已登记 ${id}：${String(args.title ?? '')}` }
    },
  })

  const updateTool: ToolDefinition = defineTool({
    name: 'longhorizon_update',
    description:
      '更新一条**未关闭**条目（只改给到的字段）。next 不可改为空；kind 变更走白名单。'
      + '用途：推进后刷新「下一步」——让台账始终指向当下真正要做的动作。',
    parameters: {
      id: { type: 'string', description: '条目 id（lh-xxxxxxxx）', required: true },
      next: { type: 'string', description: '新的下一步动作' },
      kind: { type: 'string', description: '新类别：task | waiting | issue' },
      refs: { type: 'array', description: '新的产物指针（整体替换）' },
      blockedBy: { type: 'string', description: '新的阻塞说明（传空串清空）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          line: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => {
        const v = value as { ok: boolean; line: string; note: string }
        return [{ type: 'text', text: (v.ok ? '✅ ' : '❌ ') + v.note + (v.line === '' ? '' : '\n' + v.line) }]
      },
    },
    async execute(args) {
      const id = String(args.id ?? '')
      const kind = typeof args.kind === 'string' && args.kind !== '' ? args.kind : undefined
      if (kind !== undefined && !KINDS.includes(kind as Kind)) {
        return { ok: false, line: '', note: `kind 非法「${kind}」——未改动。` }
      }
      const refs = Array.isArray(args.refs) ? args.refs.filter((r): r is string => typeof r === 'string') : undefined
      const blockedBy = typeof args.blockedBy === 'string' ? args.blockedBy : undefined
      const out = mutate('update', (l) => updateItem(l, id, {
        next: typeof args.next === 'string' ? args.next : undefined,
        kind: kind as Kind | undefined,
        refs,
        blockedBy,
      }, now()))
      if (!out.ok) return { ok: false, line: '', note: '未更新：' + out.error }
      appendTrace(home, { stage: 'update', ok: true, id })
      return { ok: true, line: renderLine(out.ledger, now()), note: `已更新 ${id}` }
    },
  })

  const closeTool: ToolDefinition = defineTool({
    name: 'longhorizon_close',
    description:
      '关闭一条未完成项（note 必填：关闭理由与登记理由一样要留痕）。'
      + '⚠ 关闭是**声明它做完了**——不是「我不想再看见它」。做不完就 update 改 next 或改 kind，不要 close。',
    parameters: {
      id: { type: 'string', description: '条目 id（lh-xxxxxxxx）', required: true },
      note: { type: 'string', description: '关闭理由（非空）', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          line: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => {
        const v = value as { ok: boolean; line: string; note: string }
        return [{ type: 'text', text: (v.ok ? '✅ ' : '❌ ') + v.note + (v.line === '' ? '' : '\n' + v.line) }]
      },
    },
    async execute(args) {
      const id = String(args.id ?? '')
      const out = mutate('close', (l) => closeItem(l, id, String(args.note ?? ''), now()))
      if (!out.ok) return { ok: false, line: '', note: '未关闭：' + out.error }
      appendTrace(home, { stage: 'close', ok: true, id, note: String(args.note ?? '') })
      return { ok: true, line: renderLine(out.ledger, now()), note: `已关闭 ${id}：${String(args.note ?? '')}` }
    },
  })

  ctx.tools.register(statusTool)
  ctx.tools.register(openTool)
  ctx.tools.register(updateTool)
  ctx.tools.register(closeTool)

  if (config.enabled) installInject(ctx, { loadLedger: loadLenient })

  console.info('[dsh-longhorizon] 就绪（台账 ' + path + '；注入 ' + (config.enabled ? '开' : '关') + '）')
}
