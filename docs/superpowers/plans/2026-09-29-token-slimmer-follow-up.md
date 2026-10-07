# Token Slimmer 二轮修复执行方法

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. 用复选框记录证据与完成状态。当前请求是编写执行方法，不是开始修改功能代码。

**Goal:** 修复 2026-09-29 复查仍存在的问题，交付内容保真、原文可恢复、预算可解释、统计可信的工具输出压缩版本。

**Architecture:** 保留已完成的配置校验、默认 reasoning 禁写和保护行选择。先完成内容保真与原文恢复，再集成结果级预算和可信处理状态；统计与回放可独立开发，由同一人集成 `index.js`。reasoning 继续关闭写入。

**Tech Stack:** JavaScript ESM、Node.js 内置模块、`node:test`、PowerShell 7。无新增第三方运行依赖。

**Spec:** [上一版完整方案](./2026-09-28-token-slimmer-repair.md)。本文件补充本轮具体决策；冲突时采用本文件，尤其是恢复依赖、预算耗尽和幂等定义。

## 全局约束与当前基线

- 工作目录 `D:\work\token-slimmer`；当前不是 Git 仓库。保留执行前源码副本，不自动初始化仓库或推送。
- 上轮复查 `npm test` 实际通过 61 项内核断言和 9 项配置测试；这是修复前基线，不等于本轮验收通过。
- 已完成的配置小数校验、默认禁止 reasoning 写入、最新短消息不回选旧消息、40 条 ERROR 全保留，应保留回归测试。
- 测试只使用合成输入、假工具和唯一临时目录；不默认读取私人会话或调用付费 API。
- 保留原文、预算溢出和压缩失败必须可观察；不能把所有回退都报告为正常达标。
- 本轮不重新开启 reasoning、不扩大到新 agent 平台、不靠继续降低预算提高表面压缩率。

## Review Focus

- 用户配置的 0 与分配耗尽的 0：前者关闭压缩，后者仍受结果级预算约束。任务 C。
- 原文包含 `(slimmed v1)` 或类似完整标记：不能证明它已被本插件处理。任务 C。
- 字符串空格、CRLF、JSON 重复元素与大整数：预算内必须保持原文。任务 A。
- 恢复读触发同一压缩 hook、存储失败、跨重启：不能再次压缩、重执行工具或宣称恢复成功。任务 B。
- dry-run 重入、部分 surface 替换、最新短 reasoning：不重复记账，不回选旧内容。任务 D、E。

## 执行顺序

1. A：内容保真，可以先独立交付。
2. B：原文存储和恢复，作为后续有损输出的发布前提。
3. C：共享预算、保护上下文和可信处理状态，依赖 A/B。
4. D：统计与回测，可与 A/B 并行编写，最终统一集成。
5. E：修复 reasoning 纯函数，继续保持写入禁用。
6. F：文档、配置、打包和整体验收。

每个任务采用同一流程：**增加针对缺陷的测试 → 在旧实现上确认失败 → 最小范围修改 → 对应测试通过 → `npm test` → 记录证据。** 不用减少断言、放宽预算阈值或删除失败用例换取通过。一次只集成一个任务，避免多个人同时修改 `slim.js` / `index.js`。

## A. 先保证读取的内容真实

**文件：** 修改 `slim.js`、`policy.js`、`test/run.mjs`；新增 `test/fidelity.test.mjs`。

**实现约定：** 新增纯函数 `resolveTransforms({toolName, contentType, options})`，返回该次输入允许的变换开关。`read` 强制关闭空白清理与重复行折叠；code/json/diff/table/未知类型默认同样保真。日志专用变换只有在日志策略和显式配置均允许时启用。预算内不加标记、不补结尾换行。

- [ ] 增加模板字符串用例：`const value = \`first  \nsecond\`;` 经 read 输出处理后，字符串值仍为 `first  \nsecond`，原始正文逐字节不变。
- [ ] 增加 CRLF、Markdown 双空格、Python 多行字符串、Makefile tab、JSON 连续相同元素和超安全整数测试；不使用 JSON parse/stringify 重建原文。
- [ ] 将 `normalize()`、`foldRepeatedLines()`、`foldBlankRuns()` 的调用改为经过 `resolveTransforms()`；低层直接调用默认同样保守，不能只修插件入口。
- [ ] 原有“默认删除空白”断言改为显式日志模式测试；新增保真断言保住新契约。
- [ ] 运行 `node --test test/fidelity.test.mjs` 和 `npm test`。

**完成标准：** 41-token read 样本不再变化；合法 JSON 不会因折叠插入标记而损坏。超预算节选必须等任务 B 成功提供恢复能力后才发布。

## B. 建立同一次执行的原文恢复

**文件：** 新增 `recovery-store.js`、`test/recovery.test.mjs`、`test/cli.test.mjs`；修改 `index.js`、`bin/slim.mjs`、`package.json`。

**接口：** `createRecoveryStore({rootDir, maxBytes})` 返回 `save({sessionId, callId, blocks})`、`read({artifactId, blockIndex, offset, limit})`、`ownsPath(path)`。保存成功返回原文文件路径、block index、SHA-256 和 artifact ID；失败抛明确错误。保存的是插件实际收到的文本，不是工具内部未返回的数据。

- [ ] 先用带执行计数的假工具写测试：执行一次、压缩、恢复三次，执行计数仍为 1，恢复结果与原输入完全一致。
- [ ] 原文以独立 UTF-8 文件加 manifest 保存；文件名使用生成的 ID，session 隔离。默认沿用上版方案的 256 MiB 上限，不自动删除；满后保留原输出并记录 `recovery-unavailable`。
- [ ] 插件先生成候选，再保存原文，保存成功后才能发布有损候选；纯压缩核不直接访问文件系统。
- [ ] 恢复提示改为读取快照路径和行区间，删除“重复执行相同调用即可恢复”的默认承诺。`fullTextOnRepeat` 默认关闭，保留为明确说明副作用的兼容选项。
- [ ] `read` 读取本插件登记且校验通过的恢复文件时绕过所有变换；不得再次归档、截断或修改空白。
- [ ] CLI 提供 `--save-original <directory>`、`--restore <artifact-id> --store <directory>` 和 `--full`。`--full` 只原样输出调用方仍持有的输入，不声称能恢复已丢失的动态结果。全文恢复不补换行。
- [ ] 覆盖跨重启、文件缺失、哈希不符、并行 agent、写入失败及超配额；临时目录在异步测试结束后清理。
- [ ] 运行 `node --test test/recovery.test.mjs test/cli.test.mjs` 和 `npm test`。

**完成标准：** 18,489 字符样本能从快照恢复全部原文；重复工具执行不再是恢复路径；保存失败时明确返回原文和失败原因。

## C. 修复共享预算，而非给每块补一个最小值

**文件：** 修改 `slim.js`、`importance.js`；新增 `test/result-budget.test.mjs`、`test/kernel-regressions.test.mjs`。依赖 A/B。

**接口与语义：** 用户配置 `maxResultTokens: 0` / `readMaxResultTokens: 0` 仍代表关闭。在适配边界一次性转换为内部 `budgetTokens: null`；内部数字 0 代表没有剩余额度。不得直接改变导出旧函数中 0 的兼容含义；新增内部规划函数承接该区分。

- [ ] 先增加原复现：10,000 行相同正文分别拆成 1、10、100 块，总预算 2,000；最终结果计入全部标记后不因拆块膨胀。再测 2,001 个块分配为 0 的情况。
- [ ] 停止在 `keepSet.size === 0` 时直接返回该块全文；结果层将未选中块表示为引用原文的省略项。不能用 `Math.max(1, allocation)` 掩盖问题，也不能静默返回空文本。
- [ ] 用包含 block index 和原始行跨度的候选集合统一规划：先保护错误/异常行及其前后各 2 行，再分配其他内容。不同 block 不共享邻域，重叠邻域去重。
- [ ] 渲染结果后计算全部保留文本、read 包络、省略标记与恢复路径成本。超额时撤掉最低优先级的非保护选择并重新渲染，选择数量必须单调下降直至完成；合并相邻省略项和重复恢复提示。
- [ ] 全部保护内容超过额度时保持它们，报告 `budgetExceeded: true`、`overflowReason: protected-content`。极小正预算连最短恢复提示都装不下时报告 `metadata-minimum`，不能假称达标；快照失败保留全文则报告 `recovery-unavailable`。这些是明确的软预算例外。
- [ ] 删除凭正文 `(slimmed v1)` 判定处理完成的逻辑。由插件本地状态保存 `{version, artifactId, optionsHash}`；普通工具文本不能自称已处理。相同可信状态复用输出，配置变化则读取原始快照重算。
- [ ] 幂等验收区分两件事：同一原文和配置结果确定；带可信已处理状态的结果重复经过管道不变。CLI 普通文本 stdin 永远按原文处理；它无法只凭字符串同时区分“真实原文”和“压缩表示”，文档需明确这一边界。旧的字符串二次处理断言迁移为上述两个契约测试，不能只删掉。
- [ ] 新增测试：原文含普通标记文本、40 组 ERROR 加调用栈、多个小省略区间、混合图像/文本。非文本对象保持不变，预算统计只声明文本估算。
- [ ] 运行 `node --test test/result-budget.test.mjs test/kernel-regressions.test.mjs` 和 `npm test`。

**完成标准：** 100 块样本不再出现 313,590 tokens 穿透；无软预算例外时最终文本估算不超过总额度；有例外时原因和原文恢复路径明确。输出标记不能让普通输入绕过规划。

## D. 修复统计与回测的调用契约

**文件：** 修改 `index.js`、`test/budget-swap.mjs`、`test/strategy.mjs`、`test/audit.mjs`、`test/reasoning.mjs`、`test/replay.mjs`；新增 `metrics.js`、`test/metrics.test.mjs`、`test/helpers/replay-ledger.mjs`、`test/replay-ledger.test.mjs`。

**统计接口：** `recordResult(state, {id, mode, beforeTokens, afterTokens})`，mode 为 `applied | dryRun`。汇总分别输出 `estimatedAppliedSavings`、`estimatedPotentialSavings` 和有来源的真实 usage/费用；旧 `savedTokens` 只作为实际应用估算的兼容别名。

- [ ] 重现同一 reasoning 连续三次 pre-step：会话替换为 0 时，实际应用节省必须是 0。预测按 session/seq/content hash/options hash 去重；重复观察可以计次数，不能重复累加同一预测收益。
- [ ] 两条各 1,000 tokens 的结果，一条压到 500、一条不变，整体节省率必须是 25%。未改变、恢复旁路和失败回退均计入全部输入分母。
- [ ] 修复策略调用：向 `planReasoningPass()` 传**当前 surface 上全部 assistant 候选**，并逐个计算 `overBudget`，不能只在原先过滤后的数组上补 `overBudget: true`，否则重新引入“最新很短却选旧消息”。
- [ ] 回放测试同时覆盖：最新长消息确实选中；最新短、旧长时 newest 选中 0 个；all 只选当前仍在 surface 的超预算候选。
- [ ] 以 append/replace surface 事件维护活跃节点；完整替换后旧 reasoning 不再计费，部分替换保留未覆盖节点。不再将所有历史 blocks 永久视为 visible。
- [ ] 三步合成记录中，第二步请求带 2,000-token reasoning，替换后第三步仅含 2-token 摘要；仅用于核对账本的统一 hit 费率 0.04/M 下，成本应为 0.00008008，而非 0.00016008。该费率是测试常量，不是当前真实价格或计费模型。
- [ ] 实际账单按 hit/miss/output usage 与版本化费率计算；reasoning 若已包含在 output 中不能重复收费。只有文本数据时只显示模拟，不用整请求全 hit/全 miss 推导实测费用。
- [ ] 运行 `node --test test/metrics.test.mjs test/replay-ledger.test.mjs` 和 `npm test`；默认运行不打开个人历史会话。

**完成标准：** 无改写不报实际节省；分母完整；策略回放与插件使用同一候选契约；compaction 不产生幽灵历史费用。

## E. 修复 reasoning 纯函数，继续禁止生产写入

**文件：** `reasoning.js`、`test/reasoning-lifecycle.test.mjs`。

- [ ] 对 `'A'.repeat(8000)`、预算 500 添加测试：压缩后包含标记的总估算不得超过 500；再次处理保持相同结果，不再出现 511→511→510→511。
- [ ] 先扣标记成本再分正文，覆盖段落/无段落、中文/emoji；不得切开 surrogate pair。预算小到无法容纳标记时原样返回并提供明确原因。
- [ ] 使用内部处理状态避免再次压缩已完成结果，检查原始文本中类似 reasoning 标记的情况，不把任意正文片段作为可信状态。
- [ ] 保留 `strategy: never`、全局禁写和显式写入被拒绝的测试；不要仅翻转 `REASONING_WRITES_VERIFIED` 来宣称 provider 兼容。
- [ ] 运行 `node --test test/reasoning-lifecycle.test.mjs` 和 `npm test`。

**完成标准：** 纯函数预算/状态测试通过；生产会话写入仍为 0。provider、签名、请求生命周期和真实质量实验属于后续独立工作。

## F. 配置、文档与最终交付

**文件：** `README.md`、`cordis.patch.yml`、`locale/*.json`、`package.json`、`test/all.mjs`。

- [ ] README 与示例配置统一为 reasoning 默认关闭；移除或标为历史失效估算的 21.7% / 35.5% 数字；不再宣称任意 provider 免费改写 reasoning。
- [ ] 新增恢复模块加入 package 的 `files`；用 `npm pack --dry-run` 核对真实分发文件。新 CLI 参数、退出码、恢复限制及存储额度写入说明。
- [ ] 确保新增 `*.test.mjs` 都进入 `npm test`；历史会话分析和真实 API 实验仍为显式入口。Node test runner 参数应在脚本路径前传递。
- [ ] 运行 `npm test`、`node test/perf.mjs` 和 `npm pack --dry-run`。性能在同机同输入下比较，尤其检查最终渲染重算是否退化为不可接受的耗时。
- [ ] 让独立审查者只围绕本轮失败用例和接口进行复核；逐项记录“已实现、离线验证、宿主验证、真实费用验证”，未做的保留未验证。
- [ ] 发布前保留当前源码与配置的可恢复副本；回退只回退代码/配置，不删除原文快照。真实 A/B 待用户确定模型与费用上限后再执行。

## 交付记录格式

每个任务提交一条简短记录：`任务 → 修改文件 → 原失败用例 → 修后输出 → 执行命令/退出码 → 未验证范围`。最终报告用具体失败案例是否消失来证明修复，不用测试总数或压缩百分比代替。
