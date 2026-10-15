/**
 * inject.ts — 每轮一行读数注入（`agent/pre-step` 瀑布）。
 *
 * 为什么是**注入**而不是「再写一条规则」（论文 arXiv:2610.14966v1 的直接教训）：
 * 论文给 agent 的中性确认提示（"Are you sure? … To continue working, submit actions"）
 * **不改变行为**——GPT 在 1M DocOps 上只做 11/81 页、用掉 172/1715 次额度，
 * 收到确认后仍然再交一次 final，90% 额度剩余。
 * ⇒ 提醒无效，除非读数出现在**执行路径**上。pre-step 注入就是执行路径。
 *
 * 去重（防刷屏）：`agent/pre-step` 是**每 step** 触发的，一个长 turn 里有几十个 step。
 * 键 = 会话 + 小时 + 内容指纹 ⇒
 *   ① 内容变了（我加/关了一条）⇒ 下次 pre-step 立刻带新读数（闭环）
 *   ② 跨小时 ⇒ 重注入（读数新鲜）
 *   ③ 其余不重复
 * 压缩会删掉旧注入 ⇒ 最迟一小时内补上（期间由压缩块的 Pending Jobs 段兜底）。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { renderLine, type Ledger } from './ledger.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-longhorizon': { kind: 'dsh-longhorizon' }
  }
}

/**
 * 人类会话判据：DSH 人类会话形如 `session-<uuid>`；子代理是裸 uuid。
 *
 * ⚠ 这是 `dsh-life-core/src/target.ts` 同判据的**第二份副本**（不 import 别的插件内部，
 * §5.34）。已知漂移风险：对方改判据时这里不会自动跟随——故本文件带**样本集测试**
 * （人类样本 + 裸 uuid 样本），改判据必须两侧同时改，测试会红。
 */
export function isUserSession(sessionId: string): boolean {
  return /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)
}

/** 去重键：会话 + 小时 + 读数内容 */
export function dedupeKey(sessionId: string, line: string, now: Date): string {
  const hour = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
    + '-' + String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0')
  return sessionId + '|' + hour + '|' + line
}

/** 注入依赖（测试注入替身） */
export interface InjectDeps {
  /** 读台账（接线层给：宽松读——注入面绝不可因台账坏而崩） */
  loadLedger: () => Ledger
  /** 当前时刻（测试注入固定时刻） */
  now?: () => number
}

/** 去重集合上限（护栏：长期运行不得无限增长；清空只导致一次重复注入） */
const SEEN_CAP = 500

/**
 * 安装注入：每个 pre-step 检查一次，命中即把一行读数追加进本 step 的消息批次末尾。
 *
 * 尾部追加（缓存友好）：动态注入统一放批次末尾，避免插在历史中部破坏前缀缓存。
 */
export function installInject(ctx: Context, deps: InjectDeps): void {
  const seen = new Set<string>()
  // DSH 类型漂移（同 life-core 的处理）：pre-step 事件重载后 TS 无法匹配监听器签名，
  // 运行时契约未变——用宽松类型绕开重载匹配。
  ctx.on('agent/pre-step', (async (payload: any, next: any) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const sid = String(payload.agent?.session?.id ?? '')
    if (!isUserSession(sid)) return decision
    const nowMs = deps.now !== undefined ? deps.now() : Date.now()
    const line = renderLine(deps.loadLedger(), nowMs)
    if (line === '') return decision
    const key = dedupeKey(sid, line, new Date(nowMs))
    if (seen.has(key)) return decision
    if (seen.size >= SEEN_CAP) seen.clear()
    seen.add(key)
    const msg = createUserMessage({
      content: [{ type: 'text', text: line }],
      source: { kind: 'dsh-longhorizon' },
    })
    return { ...decision, messages: [...decision.messages, msg] }
  }) as any, { prepend: true })
}
