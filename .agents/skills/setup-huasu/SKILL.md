---
name: setup-huasu
description: 为当前项目写入华速协作规范：AGENTS.md、.gitignore tmp/；用于项目初始化或补齐。
---

# 华速协作规范初始化

在目标项目根目录创建或更新 `AGENTS.md` 与 `.gitignore`，使用 `apply_patch` 完成修改。保留项目其他内容；已有“全程中文交流”和“自动 Code Review”区块时原位更新，缺失时追加，不重复写入。结束前核对这两个区块各只有一组，且 `tmp/` 已被忽略。

写入前确认已安装并可读取 `code-review` skill，优先检查目标项目中的入口：

`.agents/skills/code-review/SKILL.md`

若入口不在此处，使用宿主技能列表中实际安装的 `code-review` 路径；均不可用时停止写入，提示先执行 `npx skills@latest add huasu-dev/skills`。

## 1. `AGENTS.md`

```markdown
## 全程中文交流

## 自动 Code Review

- 每次用户请求中，若新增、修改或删除了代码、配置或测试文件，在实现和验证完成后，自动调用一次 `code-review` skill 审查当前未提交变更；纯问答、只读分析或仅修改文档时不触发。
- 同一次用户请求最多自动审查一次；只审查并报告，不自动修复。用户后续明确要求修复时，视为新的请求。
- 审查分工、规则计划、调度与恢复、报告及清理均遵循 `code-review` 的 `SKILL.md`，不在此重复定义。
- 最终答复简要说明审查结果；发现问题时按 skill 格式报告，审查未完成时如实说明。
- Standards 与五条 AI 规则分别委派给独立宿主原生 worker，继承当前选中模型；该委派已授权，直接执行，不重复确认。并发容量不足时按 skill 调度；原生委派不可用时如实报告未完成。

```

## 2. `.gitignore`

若项目根目录的 `tmp/` 尚未被忽略，追加以下内容；已有等效忽略规则时不重复追加，已有取消忽略规则时调整相关规则使其生效：

```
# code-review 临时产物
tmp/
```
