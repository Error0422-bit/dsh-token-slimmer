# Token Slimmer 修复与改进执行方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户后续的执行指令优先；本文件目前仅为方案，不代表代码已修复。

**Goal:** 修复已确认缺陷，在保留可验证任务质量和原文恢复能力的前提下，降低整项任务的实际成本。

**Architecture:** 保留零模型调用、零第三方运行依赖的纯函数压缩核。插件与 CLI 负责原文存储和适配，统计层分开记录估算、模拟、实际应用和 API 账单。工具输出修复先交付，reasoning 压缩保留为默认关闭的独立实验。

**Tech Stack:** JavaScript ESM、Node.js 内置模块、`node:test`、PowerShell 7；本机已验证 Node.js 24.20.0。

**Spec:** 本文件“设计约定”作为本轮执行规格；问题证据来自当前会话的源码审查及内存合成复现。未假设真实 API 兼容性或节省比例已经验证。

## 当前基线与范围

- 项目：`D:\work\token-slimmer`。目前不是 Git 仓库；执行时先复查，不自行初始化、提交、推送或重写历史。
- 上轮已运行 `node test/run.mjs`，结果 57/57 通过。该结果不能覆盖新增的生命周期和边界缺陷。
- 已复现：保护行被预算丢弃、折叠标记绕过预算、reasoning 非幂等、旧 reasoning 被选中、回测 compaction 后继续计算旧 reasoning、统计分母排除未修改结果、CLI 重复调用不能恢复全文。
- 已确认代码风险但未实测服务端结果：修改 reasoning 正文后保留旧 replay 签名。
- 本次方案不包含自动修改已安装的 DSH、修改生产会话、付费 API 实验、跨平台 hook 发布或增加新的模型服务。

## 方案选择

推荐分阶段修复：先建立保留与恢复契约，再修统计，最后实验 reasoning。仅调整预算无法修复已确认缺陷；一次性重做 agent/harness 会扩大范围和验证成本。此次保留现有模块结构，只新增原文存储、共享统计及测试辅助模块。

## 设计约定

1. **预算是软目标。** 已被规则明确标为保护的行及其相邻两行优先保留，超过预算时返回 `budgetExceeded: true` 和原因。结构、声明、novelty 仍是评分信号，不宣称所有语义重要信息都能被识别。错误全量保留、任意大输入和绝对硬上限不能同时保证；本轮不增加自动丢弃保护行的硬上限模式。
2. **预算以一个工具结果为单位。** 所有 text blocks 共享额度，包含包络、省略标记与恢复引用。分析意图倍数对总额只应用一次；内容类型影响分配权重。为兼容原单块策略，总额最多使用一次该结果各块中的最大类型系数，禁止逐块累加完整预算。非文本块原样保留，成本另标为未计入文本估算。
3. **保留来源位置。** 折叠、选择、显示三个阶段使用原始行跨度，避免折叠后重新编号导致恢复指向错误。未选中的内容必须有准确省略提示。
4. **保真优先。** `read`、代码、JSON、diff、表格默认不做尾随空白删除、空行合并、重复语句折叠。日志规范化只能在日志策略下显式启用。节选必须标明是展示片段，不保证可直接执行或解析；恢复得到未经压缩核变换的原始工具文本。
5. **恢复原结果，不重新执行工具。** 原文成功保存后才能发布有损结果。保存失败、磁盘满或超存储额度时返回原结果并记录原因。恢复文件读取走现有 `read`，绕过压缩，不循环生成新恢复文件。
6. **幂等与阶段隔离。** 普通 `⟪` 字符、重复行标记均不能阻止后续预算处理。已完成的压缩表示使用独立版本化标记和明确的输入状态；同配置再次输入时保持字节稳定。需要改变预算时，从保存的原文重新处理。
7. **reasoning 默认关闭。** 默认 `strategy: never`；已有显式配置进入兼容检查，不能悄悄继续未知 provider 的写入。签名或 opaque replay 内容、来源不明内容一律原样保留。不依据 5 分钟空闲或“尚未作为输入回传”推断免费修改。
8. **收益分四本账。** 文本 token 估算、实际应用的文本变化、dry-run 预测、真实 API usage/费用分别记录。压缩率分母包含所有看见的文本；不把未收集的费用或 token 记为零。
9. **异常退回原文。** 压缩、恢复存储、策略检测发生异常时，不阻断原工具返回；独立告警计数保证问题可发现。

## 全局约束

- PowerShell 7 与 Windows 路径；无 Bash 重定向示例。
- 纯核不读写文件、不联网、不调用模型；新模块只使用 Node.js 内置依赖。
- 不读取私人会话作为默认测试数据；合成 fixtures 和临时目录应足以完成离线验收。
- 测试临时文件放在 `os.tmpdir()` 下的唯一目录；清理前验证路径范围，不触碰用户会话和已有输出。
- 不额外注册恢复工具；只在发生省略时附简短恢复路径与区间提示。
- 保留现有导出函数；必要的新返回字段采用附加方式。语义变化通过版本、README、配置迁移说明同步发布。
- 原文指工具交给本插件的文本，不承诺恢复工具自身已经截断的数据，也不宣称恢复到了底层文件的原始编码字节。

## Review Focus

- 保护行总量本身超预算：全部保护行仍在，超额原因明确。归属任务 2。
- 原文带 `⟪`、JSON 字符串、CRLF、连续相同语句：不能误认压缩状态或偷偷改变数据。归属任务 2、3。
- 同一正文拆成 1/10/100 个 blocks：不会取得线性增加的预算，非文本块不变。归属任务 3。
- 恢复跨重启、磁盘写入失败、恢复文件位于压缩路径：不重新执行工具、不循环压缩、不宣称恢复成功。归属任务 4。
- 重试、恢复会话、compaction、并行 agent 和旧 replay 签名：不反复修改历史或重复记账。归属任务 5、6。

## 交付顺序与依赖

| 阶段 | 任务 | 可独立验收的结果 | 依赖 |
|---|---|---|---|
| P0 | 1. 安全默认值与可移植测试入口 | reasoning 默认不写会话；测试不依赖个人安装路径 | 无 |
| P0 | 2. 保护规则、标记和幂等 | 必保留信息不因预算消失，折叠不再绕过限制 | 1 |
| P1 | 3. 内容保真与结果级预算 | 多块不能扩大额度，代码/结构化数据保持保真 | 2 |
| P1 | 4. 原文保存与恢复 | 模型能取回同一次执行的完整结果 | 3 |
| P1 | 5. 统计与回放账本 | 压缩率分母正确，模拟与真实费用分离 | 1；最终对接 4 |
| P2 | 6. reasoning 独立实验 | 幂等、生命周期与 provider 兼容机制可测试 | 5 |
| P2 | 7. 整任务 A/B 与精简 skill | 有质量门槛的真实收益验证、调用前减量 | 4、5；reasoning 单独评估 |

第一批交付任务 1—5；第二批任务 6—7。内核修复与统计账本可分工，但 `index.js` 由同一集成人员修改，避免接口和计数冲突。每个任务先补能暴露原缺陷的测试，确认失败，再实现并复测；每批结束进行一次独立审查。

## 任务 1：安全默认值与可移植测试入口

**修改：** `reasoning.js`、`index.js`、`cordis.patch.yml`、`package.json`、`README.md`、`locale/zh.json`、`locale/en.json`、`test/run.mjs`。

**新增：** `test/all.mjs`、`test/config.test.mjs`、`test/helpers/fake-session.mjs`、`test/fixtures/source-samples.mjs`；可选真实安装检查移至 `test/harness-smoke.mjs`。

**接口：** 保留 `resolveReasoningOptions(raw)` 与 `apply(ctx, config)`。测试假 session 提供 `surface.nodes`、`eventAt(seq)`、`append(type, data, options)`，支持真实的 append/replace 语义。

- [ ] 增加默认配置测试：注册插件并触发 pre-step 后，session 写入次数为 0；工具结果压缩仍可用。
- [ ] 增加比例参数测试：`headRatio: 0.55` 可用；负数、大于 1、NaN、Infinity 被拒绝；token 预算和毫秒参数仍要求非负整数。
- [ ] 将默认 reasoning 改为 `never`。在任务 6 完成前，显式写入模式返回清晰的“不支持/未验证”原因并保留原文；dry-run 可继续纯函数计算。
- [ ] 从默认测试入口移除对 `C:/Users/a/AppData/...` 的依赖，用独立合成源码替代；真实 harness 检查使用显式 `DSH_SOURCE_ROOT`。
- [ ] 配置文件改为当前源码实际支持的配置；附带旧宿主缓存版本的重启说明，执行时不自动改已安装宿主。
- [ ] `package.json` 增加 `scripts.test: "node test/all.mjs"`。该入口用 Node 子进程先运行迁移后的 `test/run.mjs`，再按文件名排序运行顶层 `*.test.mjs`，任一失败保留非零退出码。禁止用默认全目录发现执行历史回放或付费 benchmark；宿主 smoke 单独运行，缺少数据时明确 skipped。

**验收命令：** `node --test test/config.test.mjs`；`npm test`。预期新增边界测试及迁移后的原有断言全部通过。第一步红灯结果必须记录，不能靠降低断言让旧实现通过。

## 任务 2：保护行、折叠阶段和幂等

**修改：** `importance.js`、`slim.js`、`test/run.mjs`；**新增：** `test/kernel-regressions.test.mjs`。

**接口：** 保留 `selectByImportance(lines, budget, context, options)`；返回值追加 `protectedIndices`。内部行记录使用 `{text, firstLine, lastLine, protection}`；对外统计追加 `budgetExceeded`、`overflowReason`、`protectedLines`，不删除旧字段。

- [ ] 补测试：40 行 ERROR、预算 100，断言所有 ERROR 与规定邻域均保留；一条超预算长错误行、数值异常同样覆盖。
- [ ] 将保护行选择放到头尾和普通评分之前，保护行不参与剩余额度竞争；预算不足只影响普通候选。
- [ ] 补测试：5,000 行分别插入四行重复 heartbeat、四个空行、普通 `⟪` 字符，仍发生正常预算处理。
- [ ] 移除“任意 `⟪` 即已压缩”的判断。内部显式区分 normalize/fold/bound 阶段；文本输出使用独立的完整版本标记，不把一般字符当完成凭证。
- [ ] 从原始行记录生成省略区间；折叠记录的行跨度不能用当前数组下标代替。错误位置、恢复区间、保留行顺序均可核对。
- [ ] 同时测试 `slim(slim(x)) === slim(x)`、`slim(x) === slim(x)`；覆盖折叠加 bounding、CRLF、尾部空行和原文含类似标记的情况。只接受完整格式作为已压缩表示，并记录原文保留的保守回退原因。
- [ ] 计算最终标记开销后重新减少普通候选，保护行不删；最终不比原文本估算更省时返回原文。

**验收命令：** `node --test test/kernel-regressions.test.mjs`；`npm test`。无保护溢出的合成日志达到目标预算；有保护溢出时行为及统计一致，不能只断言“至少保留一条”。

## 任务 3：内容保真与整个工具结果共享预算

**修改：** `slim.js`、`policy.js`；**新增：** `test/fidelity.test.mjs`、`test/result-budget.test.mjs`。

**接口：** 保留 `slimContent(blocks, toolName, options, fullText, context)`。新增纯函数 `allocateTextBudgets(blocks, totalBudget, policies)` 返回按 block index 对齐的额度；总代价包括包络和标记，政策倍数只在结果层使用一次。

- [ ] 保真测试覆盖 Markdown 双空格换行、Makefile tab、Python 多行字符串、连续相同语句、JSON 转义内容与超安全整数。预算充足时要求字节完全一致。
- [ ] `read` 以工具身份强制保真，其他内容由 policy 决定允许的变换；未知类型采用保守策略。禁止以 parse/stringify 当作通用无损压缩。
- [ ] 让所有文本块共享总预算，先扣包络/恢复标记预留，再分配保护行和普通候选。保护行或不可拆载荷导致的溢出单独标注。
- [ ] 将同一内容拆为 1、10、100 个文本块；无保护溢出时总文本估算不得超过结果额度。无法容纳所有片段标题时，合并省略说明，不给每块重复发完整提示。
- [ ] 非文本块逐对象保持，统计只声明文本部分。损坏或未知 block 原样返回，不让处理异常阻断工具调用。
- [ ] 超预算的代码/JSON 使用明确节选展示，并在任务 4 接入后指向原文；当前阶段保持恢复能力未接入的有损功能不默认上线。

**验收命令：** `node --test test/fidelity.test.mjs test/result-budget.test.mjs`；`npm test`。

## 任务 4：原文存储和真正可用的恢复

**新增：** `recovery-store.js`、`test/recovery.test.mjs`、`test/cli.test.mjs`。

**修改：** `index.js`、`slim.js`、`bin/slim.mjs`、`package.json`、配置和中英文说明。

**接口：** `createRecoveryStore({rootDir, maxBytes})` 返回 `save({sessionId, callId, blocks})`、`read({artifactId, blockIndex, offset, limit})`、`ownsPath(path)`。保存返回 `{artifactId, files:[{blockIndex, path, sha256, bytes}]}`；读取返回该原始文本范围，失败抛明确错误。纯核只接受恢复引用，不导入此模块。

- [ ] 为每个原始 text block 保存独立 UTF-8 文件和 manifest；文件名使用生成的 ID，不拼接工具参数。哈希覆盖插件收到的原始字符串，非文本块保持原对象。
- [ ] 默认存储在当前用户 DSH 数据目录下的独立 `token-slimmer-results`，按 session 隔离；可配置路径。首版总额度 256 MiB，不自动删除历史文件，满后放弃有损变换并返回原文。
- [ ] 先计算候选结果，再持久化原文，持久化成功后才发布带恢复引用的压缩结果；最终报告计入引用的 token 估算。
- [ ] 插件识别读取登记恢复文件的 `read` 调用（当前宿主字段为 `file_path`、`offset`、`limit`），校验规范化路径与 manifest 后绕过压缩。重启后仍可识别已保存文件，不能把整个目录中的任意文件当可信恢复记录。
- [ ] CLI 新增 `--full` 原样输出当前输入、`--save-original <directory>` 保存原文、`--restore <artifact-id> --store <directory> [--block N --offset N --limit N]` 读取快照。恢复失败非零退出；成功无变换保留原有退出码 3，文档明确它不是错误。
- [ ] 没有快照时，CLI 不再承诺重复调用恢复。恢复提示应明确 `--full` 需要调用方仍持有原始输入，不能恢复丢失的动态输出。
- [ ] 将 `fullTextOnRepeat` 降为显式兼容选项，默认关闭；即使开启，也只说明是第二次实际执行的输出，不能替代快照恢复。
- [ ] 假工具执行计数从 0 到 1，压缩后多次恢复计数仍为 1；恢复内容/哈希一致。另测重启、并行 agent、超配额、写入失败、文件缺失、文件被改动、恢复读取再次进入 hook。
- [ ] CLI 子进程测试验证中文、CRLF、无结尾换行、多块恢复，修正当前无条件补换行的行为；脚本不依赖 shell 重定向。

**验收命令：** `node --test test/recovery.test.mjs test/cli.test.mjs`；`npm test`。所有恢复测试均使用临时目录和假工具，无须运行安装、构建或部署等有副作用命令。

## 任务 5：统一统计和回放账本

**新增：** `metrics.js`、`test/metrics.test.mjs`、`test/helpers/replay-ledger.mjs`、`test/replay-ledger.test.mjs`。

**修改：** `index.js`、`test/budget-swap.mjs`、`test/replay.mjs`、`test/audit.mjs`、`test/strategy.mjs`、`test/reasoning.mjs`、README。

**接口：** `recordResult(state, {id, mode, beforeTokens, afterTokens, changed, escaped})`，其中 mode 为 `applied | dryRun`；`summarizeMetrics(state)` 返回带 `schemaVersion: 2` 的分组统计。`replayRequests(events)` 按事件 surfaceOp 重建每次请求的可见消息。`priceUsage(usage, rates)` 对缺失字段返回 unknown，不猜零。

- [ ] 全量分母测试：两个结果各 1,000 tokens，一个压到 500、一个不变，总节省率必须是 25%，不是 50%。未修改、逃生、存储失败结果都进入分母。
- [ ] 分开 `applied.estimatedTokensSaved` 与 `dryRun.estimatedPotentialTokensSaved`；同一 dry-run 候选按 session/seq/content hash/options hash 去重；实际 token 和人民币费用只来自 usage 与固定版本费率。
- [ ] 保留事件级日志，汇总按进程运行和 session 隔离，避免多个实例覆盖同一个总账。日志不写原文和完整调用参数。
- [ ] 回放按 `event.seq`、`surfaceOp: append/replace` 重建活跃消息，不按“见过 message 就一直累加”。compaction 以实际替换事件为准，不能见到 compaction/end 就假设全部历史消失。
- [ ] 三步 fixture：第一步产生 1,000-token reasoning，第二步请求携带；压缩会话后只剩 2-token 摘要，第三步只能计 2 tokens。另测部分替换、重试、非 surface message、恢复会话、分 agent 的流。
- [ ] 回放实际执行本版本压缩函数，不把结果强行假定为恰好 500 tokens。未知事件格式拒绝给出完整成本结论；无会话数据明确输出无数据。
- [ ] 删除“整请求要么全部 cache hit、要么全部 miss”的账单模型。真实费用为各请求 hit、miss、output 及其他适用费用之和；只有文本的回放只能显示 token 估算或明确标注的缓存情景分析。
- [ ] usage 归一化保留请求 ID、provider/model 和原始字段来源；reasoning tokens 若已包含在 output/completion tokens 中，不再重复加费。合成样本分别覆盖缓存子集、reasoning 子集、缺字段和失败重试。
- [ ] 固定费率的 provider、model、币种、生效日期及计费档位；不硬编码一个 50 倍比例代表所有模型。
- [ ] 用可移植样本重新生成 README 表格；保留旧结果仅作为历史估算并注明版本和口径，不沿用“实测账单”表述。

**验收命令：** `node --test test/metrics.test.mjs test/replay-ledger.test.mjs`；`npm test`。当前私人历史日志不属于默认回归测试输入。

## 任务 6：reasoning 独立实验与生命周期保护

**修改：** `reasoning.js`、`index.js`、README；**新增：** `test/reasoning-lifecycle.test.mjs`。

**接口：** `canRewriteReasoning({providerCapability, message, lifecycle})` 返回 `{allowed, reason}`。能力状态默认 `unknown`；lifecycle 显式记录生成、是否随请求发送、是否被本版本处理。状态不明视为不可修改，不从 token 数或 seq 排序推断新鲜度。

- [ ] 先修纯函数：扣除标记 token；短预算不足容纳标记时原样返回并记录原因；不切断 Unicode surrogate pair；压缩后满足预算且再调用逐字节不变。
- [ ] 最新输出很短、旧输出很长时不得选旧消息；同一 pre-step 重入、重试和恢复会话不追加重复替换；已有压缩消息不重复记账。
- [ ] 有签名、opaque/encrypted replay 或未知 source 的消息保持原对象；不能通过删签名或修改签名规避协议要求。
- [ ] 默认 provider 能力表为空，不开放真实写入；可用假 provider 验证允许路径。只有经过该 provider 协议验证的明文 reasoning 才可进入实测候选。
- [ ] 删除“空闲超过 coldAfterMs 即可免费重写”的默认策略。保留旧 strategy 参数的迁移报错/说明，不静默改变含义。
- [ ] 将文本兼容、生命周期正确、服务端接受、缓存成本和任务质量分别验收；即使服务端接受，也不能据此宣布节省费用。

**验收命令：** `node --test test/reasoning-lifecycle.test.mjs`；`npm test`。完成离线修复后默认仍为 `never`；是否重新启用由任务 7 的独立实验决定，不以完成本任务作为启用依据。

## 任务 7：整任务收益实验与精简 skill

**新增：** `test/bench/tasks.json`、`test/bench/runner.mjs`、`docs/benchmarks/protocol.md`、`skills/token-efficient-workflow/SKILL.md`；修改 README。

**实验设计：** 固定 24 个可客观验收任务：日志定位、代码修改、跨文件搜索、结构化数据各 6 个。先从每类选 1 个做单次 A/B 小试，共 8 次任务运行；没有质量/兼容性失败且剩余预算足够，才进入每任务每组重复 3 次的完整实验，共 144 次任务运行，额外重试同样计入预算。固定模型版本、prompt、工具集、项目起点和步数上限，随机化 A/B 顺序；缓存冷暖状态分层记录，无法控制时报告实际 hit/miss，不把运行顺序造成的缓存收益归因于压缩。

- [ ] manifest 给每个任务列出输入 fixture、验收脚本、最大步数和禁止副作用；包含错误在中段、编辑依赖尾随空白、必须恢复原文、多块和长载荷等审查反例。
- [ ] runner 汇总成功/失败、总 input/output/reasoning usage、cached/uncached tokens、实际费用、工具调用数、恢复次数、编辑失败数和耗时。缺少 usage 的运行不进入“实测费用”结论。
- [ ] 第一步只离线跑 fixtures 和计费汇总。真实 API 执行需使用用户指定的模型/账户及明确总费用上限；本计划不代替该授权。
- [ ] 第一轮通过后才单独添加 reasoning 实验组，避免同时改变工具压缩和 reasoning 无法归因。再分别测试源头限量与二者组合。
- [ ] 质量门槛：确定性保护/恢复/协议断言零失败；paired 任务结果无可复现的压缩特有退步；报告成功率差异和区间，不把小样本无显著差异写成“证明无损”。
- [ ] 成本门槛：工具压缩组的总实测费用低于基线，按任务报告中位数、P95 和回归任务；不得只选压缩率最好的一类展示。
- [ ] skill 保持短小、按需加载：先缩小 rg 路径和输出，按区间读取，优先工具原生过滤，避免重复拉取已知内容；省略时按 artifact 范围读取，不重跑原命令。不要宣称 skill 能直接改写宿主工具输出或读取模型隐藏推理。
- [ ] skill 本文目标不超过 120 行，Windows 示例与 CLI 实际参数一致；长文、评测和 provider 特例放 references 并按需读取。打包是否支持某宿主必须有集成测试，不能仅凭有 shell 就宣称 hook 通用。

**验收命令：** 离线先运行 `node test/bench/runner.mjs --offline`；真实实验使用 `--live --model <用户指定模型> --max-cost <明确上限>`。这两个命令由本任务实现，当前尚不存在。实测报告注明日期、模型、版本、费率及所有失败案例。

## 发布、回退与完成标准

- [ ] 第一批合入前运行 `npm test`；记录 `node test/perf.mjs` 的 50 KiB、250 KiB、1 MiB 中位耗时和内存，对同机基线比较，不给跨机器绝对耗时承诺。
- [ ] 独立审查聚焦保护行完整性、恢复副作用、跨 agent 状态、计费分母和故障退回原文；发现失败先修对应任务，再重跑相关检查。
- [ ] 第一批发布工具输出修复、恢复和可信统计，reasoning 保持关闭。版本与配置迁移一起更新；保留旧源码副本及配置便于回退，原始恢复文件不随回退删除。
- [ ] 验收状态分别报告：已实现、离线测试通过、宿主集成验证、真实 API 验证、任务质量验证、实际成本验证。后四项未做时保持未验证。
- [ ] README 不再声称“关键内容一定保留”“首次出现就免费”“零 schema 成本即零恢复成本”或“跨 agent 无需适配”。精确描述已证明的行为边界。

## 参考依据

- [DeepSeek 缓存说明](https://api-docs.deepseek.com/guides/kv_cache/)：输出可能成为缓存前缀，缓存保留时间不能用固定 5 分钟推断。
- [DeepSeek reasoning 回传要求](https://api-docs.deepseek.com/guides/thinking_mode/)：接口协议与是否携带 tools 有关，不能把 reasoning 普遍视为可任意改写的普通文本。
- 本机源码定位：`importance.js:269`、`slim.js:423`、`reasoning.js:113`、`index.js:352`、`test/budget-swap.mjs:117`、`test/strategy.mjs:103`。实施过程中行号可能变化，以函数名与测试行为为准。
