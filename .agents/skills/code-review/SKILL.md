---
name: code-review
description: '审查 branch、tag、commit 或工作区变更，排除文档与 *.test.mjs。Standards 与五条 AI 规则均由独立宿主原生 worker 使用当前模型审查。'
---

只审查并报告问题，不修改被审查代码。主会话负责材料准备、规则委派、调度、候选核查与汇总，不代审规则；委派已授权，不重复询问。

## 1. 构建快照

在被审查项目目录执行 `node <skill绝对路径>/scripts/build-review-manifest.mjs [--base <fixed-point>]`，保持 cwd 指向目标项目，不切换到 skill 安装目录；核对返回 manifest 的 `repositoryRoot` 与目标仓库一致。未指定固定点时仅审 staged、unstaged、untracked；用户指定 branch、tag、commit 等 git ref 时传 `--base`，同时审该点到 HEAD 的提交和未提交变更。不改变扫描范围。

以本次实际执行 helper 的退出码、stdout 和 stderr 判断快照是否成功；失败报告附执行命令、skill 绝对路径、被审查仓库路径及相关 stderr。历史报告、测试中的模拟失败和源码中的错误字符串不能作为本次失败证据。诊断中的 patch「字节数 0」表示 Git 输出为空，不代表源文件为 0 字节；空文件本身是合法变更，由 helper 生成并校验 patch，不据此提前停止。

资源路径相对本次加载的 skill 目录解析，只检查当前正文实际引用的资源。规则委派与等待恢复分别按第 3、4 节执行，流程已内联，无需旧版的外部流程文档。

stdout 返回 manifest 绝对路径，读取该文件及非空 patch。ignored 路径、`*.md`、`docs/**`、`.docs/**`、`*.test.mjs` 不作为审查对象，不进入 finding；规则正文和 `standardSources` 是审核依据，不审查这些文档本身。不查找外部需求 Spec。

helper 失败或固定点无效时停止并报告。`textFileCount === 0` 时不启动 worker，删除准确 `tempDirectory`，报告没有可审查文本变更。所有 worker 直接读取此 manifest 及其指向的 patch；`review_plan_required` 是批次 helper 的规划标记，不要求本流程生成批次或子 manifest。

## 2. Worker 分工

| 任务 | 委派与模型 | 材料与权限 |
| --- | --- | --- |
| Standards，必跑 | 独立宿主原生 worker，继承当前模型，不覆盖 model | `references/standards.md`、全部 patch、`standardSources`；可读必要仓库依赖，不修改代码、不做复现实验。`sizeEligibleForLightReview` 为 true 时跳过 Fowler 异味 |
| 五条 AI 规则，各自必跑 | 独立宿主原生 worker，继承当前模型，不覆盖 model | 同一 manifest 绝对路径、该规则路径、全部可审查文件完整 patch；worker 自行读取材料，两轮均不修改代码、不做复现实验 |

一个 Standards 任务与全部五个 AI 规则任务并发启动。宿主并发容量不足时保留独立任务、按容量调度，不合并或换模型；等待启动计入整场预算。原生委派不可用时，报告对应任务未完成，继续可执行任务，不代审、不 fallback。

先提交全部可启动任务并保存身份，再进入等待循环；禁止启动一个后等它完成才启动下一个。spawn 调用先后返回不代表串行执行，worker 应在执行时间上重叠。

任务只含同一 manifest 绝对路径、项目用途、各自规则路径、审查用途与边界，不贴 patch、不要求主会话代审。所有 worker 只报高置信度 findings；无问题输出单独一行 `NO_FINDINGS`，有问题须提供严重程度、文件、行号、关键代码、触发条件及影响。不用固定字数限制截断必要 findings。

## 3. 直接按规则委派

主会话读取 manifest、patch 和 `ruleCatalog`，不读取 AI 规则正文。目录 `references/ai_review_rules/` 的五条规则全部运行：architect、devops、product_contract、runtime_performance、security。每条一个独立原生 worker，由 worker 自行读取自己的规则正文及全部可审查文件的完整 patch；不因认为规则不适用而省略任务。worker 仅检查其规则相关机制，不强行寻找问题。

保留所有变更层、原始行号与重命名关联。全部六个首轮任务共享同一份完整快照，禁止按功能、业务模块、目录或文件组拆分审查；不拆批、不生成子 manifest、批次索引或计划文件，不调用 `build-review-batches.mjs`。每个任务覆盖 manifest 的全部 `textFiles`，仅规则职责不同。材料超过宿主可处理的上下文限制时，报告对应任务未完成，不截断材料或自动分片。

默认无第二轮。仅具体待核实风险可触发单规则核实任务，不能因失败、超时或没有结论追加任务。直接传入同一 manifest 路径、该规则路径、具体风险、相关文件与前置任务身份；只核实指定风险，不重启首轮。前置任务须取得宿主确认的有效终态；前置失败不会被第二轮成功抵消。

核实任务可补充最多六个唯一仓库内依赖文件。读取前检查规范相对路径及真实路径，拒绝越界、链接逃逸、别名重复、目录、缺失、ignored、文档与 `*.test.mjs` 路径。

## 4. 调度、等待与恢复

按规则任务 ID、agent ID 维护 pending/active/terminal 表，保存各自启动时间、截止和异常计数。同一任务只启动一次；禁止自动重试、换模型或 shell 空等。首轮必要任务数为六个（一个 Standards 加五个 AI 规则）；未触发第二轮不计入，激活后再增加。至少每分钟更新一次进度，轮转处理 active，不让等待某个任务错过其他任务截止。

单任务执行预算 600000ms（10 分钟）；整场从第一次委派前计时，1800000ms（30 分钟）停止启动与执行，最多再留 30 秒收尾；后启动任务取单任务预算和整场剩余预算的较小值，重复等待不重置。全部由主会话按宿主等待、状态和取消接口管理。只使用宿主提供的实际终态与耗时，缺少耗时写不可用，不自行估算。

用户明确停止时退出等待与恢复，不自动重启。全部六路首轮并发；未确认停止的旧任务仍占名额。启动身份不明时停止安排新任务并保留恢复信息，不能重复 spawn。

## 5. 核查、报告与清理

主会话核实候选对应 manifest patch 的变更，读取相关文件确认最终工作区仍有问题，剔除 ignored/文档/`*.test.mjs`、后续层已修复或证据不足的候选。问题必须可由材料和具体触发条件推导，不做复现实验。合并跨 worker 重复 finding，不因重复提高严重程度。Critical 为严重安全、数据或可用性损害；Major 为正常场景功能错误或显著回归；Minor 为有限但值得修正的问题。不输出评分、表扬、泛化建议或默认修复代码。

报告分别列 Standards、AI Review Rules 和 Summary：每个任务列适用文件、实际状态、可用真实耗时与核实 findings；AI 规则另列实际规则路径。Summary 说明总 findings、最高严重程度、剔除/合并数量及整体完成情况；墙钟等待与 worker 执行时长分开，不估算缺失终态耗时。

只有正常完成且输出有效（NO_FINDINGS 或可核实 findings）的任务，才能写“未发现问题”；候选全部被剔除时记录数量。completed 但输出不可解析或截断记 `completed / invalid_output`。failed、cancelled、未启动、状态未知或缺有效输出一律未完成；任一必要任务未完成，整体也未完成，保留其他任务已核实 findings。

失败报告抄真实终态与可用耗时；未取得终态则写审查未完成，并附身份信息。区分超时、取消与宿主报错，不把等待中断说成已完成。

只在全部原生任务按宿主接口确认停止、且无启动身份不明任务后，删除 helper 的准确 `tempDirectory`。否则保留目录并报告身份及材料路径。没有再次运行 helper 时不自动清理。

## 规则适用目录

以下唯一 JSON 区块由 `scripts/rule-catalog.mjs` 读取；增删 AI 规则时同步修改，键与实际规则目录一一对应。用于说明规则职责，不用于跳过规则，也不是规则正文。

<!-- ai-rule-catalog:start -->
```json
{
  "architect.md": "模块职责、依赖方向、共享抽象、状态归属或公共接口变化。",
  "devops.md": "构建、依赖、CI/CD、部署、配置、启动、日志或平台兼容变化。",
  "product_contract.md": "用户、管理员或外部调用方可观察的行为与契约变化；不含保持行为的内部重构。",
  "runtime_performance.md": "实际运行路径的查询、循环、并发、缓存、计算或资源占用变化；不含一次性维护代码。",
  "security.md": "输入信任边界、权限、租户隔离、敏感信息、文件访问或解释执行变化。"
}
```
<!-- ai-rule-catalog:end -->
