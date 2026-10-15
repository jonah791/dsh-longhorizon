<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 长时域未完成项台账 + 每轮一行读数注入（对抗「低进度高剩余」的提前收工）
  inject: 'tools','agents'
  tools: longhorizon_status,longhorizon_open,longhorizon_update,longhorizon_close
  runtime: host-only
  envDeps: 无
  boundary: 只送读数——**不排序、不推荐、不自动执行**（决策归主体）；写路径绝不退化（台账损坏时拒绝写而非以空台账继续）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools >=0.1.0-rc.6
-->
# dsh-longhorizon

<p align="center">
  <a href="https://github.com/jonah791/dsh-longhorizon"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-42%20passed-brightgreen" alt="tests">
</p>

**一句话**：一个**独立落盘的未完成项台账**，加**每轮一行**的读数注入——专门对抗「活没干完、额度还剩一半」这种长时域失败。

**为什么值得用**：论文 SkillHorizon 实测的失败主形状不是「做不动」，是**提前收工**——1M 参考工作量档位下 **54.0%** 的失败终局是「完成 <25% 局部目标 ∧ 还剩 >50% 工具额度」，而**中性提醒不改变行为**（GPT 收到确认后仍然再交一次 final，90% 额度剩余）。⇒ 结论：**提醒无效，除非读数出现在执行路径上**。本插件就做这一件事。

[SkillHorizon](https://arxiv.org/abs/2610.14966v1)（arXiv:2610.14966v1）在 5 个模型 × 1,050 个任务上实测：

- 1M 参考工作量档位下，**54.0%** 的失败终局是「完成 <25% 的局部目标 **∧** 还剩 >50% 的工具额度」
  （64K 档位只有 2.4%）——长时域失败的主形状不是「做不动」，是**提前收工**。
- 论文给 agent 的**中性确认提示不改变行为**：GPT 在 1M DocOps 上只做 11/81 页、
  用掉 172/1715 次额度，收到确认后**仍然**再交一次 final，90% 额度剩余，压缩甚至还没发生。
- 完成 ≥80% 局部目标的执行，任务成功率仍从 92.1%（64K）掉到 65.7%（1M）——**局部完成 ≠ 全局交付**。

⇒ 结论：**提醒无效，除非读数出现在执行路径上**。本插件就做这一件事。

## 三个部件

| 部件 | 作用 | 对抗的失败形状 |
|---|---|---|
| 台账（`<DSH_HOME>/longhorizon/ledger.json`） | 独立落盘，压缩不影响；每条带 `next`（下一步可执行动作）与 `refs`（产物指针） | 压缩后依赖丢失（论文：历史输出被移除时首检接受率 84.5% → 77.2%） |
| 四个工具 | `longhorizon_status` / `_open` / `_update` / `_close` | 决策归主体，插件只维护台账与读数 |
| 每轮一行注入 | `【长时域】未完成 N · 可推 X · 等外部 Y · 问题 Z · 最老 Wd` | 提前收工（读数出现在执行路径上） |

**三分层不是装饰**：`task`（我能推）/ `waiting`（等外部）/ `issue`（已知问题）。
不分层时读数会退化成「永远有 N 条推不动」⇒ 被无视。

## 用法

```
longhorizon_status                          # 读数 + 明细
longhorizon_open    title kind next [refs]  # 登记（next 必填，同标题未关闭会被拒）
longhorizon_update  id [next|kind|refs|blockedBy]
longhorizon_close   id note                 # 关闭必须写理由
```

## 设计边界（诚实标注）

- **注入去重**：键 = 会话 + 小时 + 内容指纹。`agent/pre-step` 是每 step 触发的，
  去重坏掉的后果是刷屏——而刷屏的读数会被无视，与不注入等价甚至更糟。
- **压缩会删掉注入**：最迟一小时内补上；期间由压缩块的 Pending Jobs 段兜底。
- **不判断「该不该做」**：本插件只送读数，不排序、不推荐、不自动执行。
- **写路径绝不退化**：严格读 + 原子写 + 留痕；台账损坏时**拒绝写**而不是以空台账继续
  （否则一次写入会把整本覆盖成「只有刚写的那条」）。读路径可宽松——「降级」是一个选择，不是默认。

## 测试

```
pnpm install     # 只装 typescript / @types（.npmrc 已关 auto-install-peers，防遮蔽宿主 link farm）
pnpm build
pnpm test        # 42 条
```

42 条判据里含 8 条**尸体样本**（空 next / 重复标题 / 空关闭理由 / 坏 JSON / 整库畸形 /
id 碰撞 / 不可写路径 / 派生会话）与 4 组**对照组**（不是只喂坏样本）。

尸体对照实测：把「拒绝空 next」护栏改坏 ⇒ **恰好红 1 条**（正是该护栏），恢复后 42/42 全绿。

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-longhorizon": "link:E:/alice/self-plugins/dsh-longhorizon"
```

**2) 挂组合**（⚠ 需 agent 作用域——注入要落到具体会话）：

```yaml
- id: longhorizon
  name: dsh-longhorizon
```

**3) 30 秒验证**：`longhorizon_status` → 应返回「未完成 N · 可推 X · 等外部 Y · 问题 Z · 最老 Wd」+ 明细；随后每一轮请求的**上下文尾部**应出现同样格式的一行（这就是「读数出现在执行路径上」）。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `ledgerPath` | `<DSH_HOME>/longhorizon/ledger.json` | 台账落点（**独立落盘**，压缩不影响） |
| （注入开关等见源码 `Config`） | — | 注入去重键 = 会话 + 小时 + 内容指纹 |

## 落盘与自证

| 文件 | 何时写 | 内容 |
|---|---|---|
| `<DSH_HOME>/longhorizon/ledger.json` | 每次 `_open` / `_update` / `_close` | 全部未完成项（含 `next` 下一步动作与 `refs` 产物指针） |

**一条命令答五问**：`longhorizon_status` 一屏给出「还剩几件 / 几件我能推 / 几件等外部 / 最老多久 / 每条的下一步」。

## 生效判据与回退

**判据**：① 行为级——`longhorizon_status` 返回三层计数 + 明细；② **注入级**——后续请求尾部出现 `【长时域】…` 一行（去重键防刷屏）。
**回退**：① `git revert` + 重建 + 预检重启；② patch 行 `disabled: true`；③ 台账是独立 JSON 文件，**停用不丢数据**。

## 相关文档

- ⚠ **本插件暂无 `semantic.md`**（未建语义文档）——契约以上面各节与源码为准；补文档是待办。
- 中心仓：[alice-digital-life](https://github.com/jonah791/alice-digital-life)（本插件归 **治理层**）
- 相关技能：`longhorizon-ledger`（本插件的使用判据与与任务板的分工）

## License

MIT © jonah791

---

本插件属于**爱丽丝 DSH 自研插件生态**（[alice-digital-life](https://github.com/jonah791/alice-digital-life) · 73 个插件 · 8 个模块）：单一职责、独立仓库、独立可用。
