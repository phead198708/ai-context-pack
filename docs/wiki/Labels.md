# Issue Label Taxonomy

## 使用规则

每个 issue 至少包含：一个 type、一个 area、一个 priority、一个 phase、一个 size。只有在确实需要时添加 status 或 risk。颜色用于快速辨认维度；同一维度使用相近色系。

## Type：工作类型，必须且只能选一个

| Label | Color | 用途 |
|---|---:|---|
| type:epic | 3E4B9E | 跨多个 issue 的交付目标，只维护范围、依赖和 promotion gate |
| type:feature | 1D76DB | 用户可感知的新能力 |
| type:task | 0E8A16 | 明确的工程工作，不单独形成用户功能 |
| type:spike | FBCA04 | 有时限的技术验证，输出结论/ADR，不直接承诺生产实现 |
| type:bug | D73A4A | 已有行为偏离需求或发生回归 |
| type:docs | 0075CA | 产品、架构、开发或发布文档 |
| type:chore | BFD4F2 | 依赖、构建、维护和非功能性杂项 |

## Area：主要影响区域，至少一个，可多选

| Label | Color | 用途 |
|---|---:|---|
| area:architecture | 5319E7 | 模块边界、ADR、依赖与通用协议 |
| area:ios-app | 7057FF | 主 App 生命周期、导航和组装 |
| area:share-extension | 8B5CF6 | iOS Share Extension 与 App Group Inbox |
| area:ingestion | 006B75 | 导入、类型识别、manifest、hash |
| area:extraction | 008672 | OCR、PDF、文本和 URL 提取 |
| area:processing | 0B4F6C | 规范化、去重、估算和压缩 |
| area:privacy | B60205 | 敏感信息检测、审核、遮挡与日志安全 |
| area:export | D4C5F9 | Markdown、PDF、bundle、clipboard、share |
| area:persistence | BFDADC | SwiftData、文件存储、迁移、清理与恢复 |
| area:ui-ux | F9D0C4 | 编辑器、预览、onboarding、可访问性 |
| area:quality | C5DEF5 | 测试、fixture、性能、CI 与 release gate |
| area:release | 1D76DB | TestFlight、App Store、metadata 与隐私申报 |

## Priority：业务/交付优先级，必须且只能选一个

| Label | Color | 定义 |
|---|---:|---|
| priority:p0 | B60205 | 阻塞当前 phase 或涉及数据丢失/敏感信息泄漏，立即处理 |
| priority:p1 | D93F0B | 当前 phase 必须完成，不能带入 promotion |
| priority:p2 | FBCA04 | 重要但可在不破坏核心价值的前提下延期 |
| priority:p3 | C2E0C6 | 候选改进或 post-MVP |

## Phase：交付阶段，必须且只能选一个

| Label | Color | 用途 |
|---|---:|---|
| phase:0-foundation | 0052CC | 工程、架构、CI、App Group 与关键 spike |
| phase:1-ingest | 006B75 | 输入、提取、统一 manifest 和恢复 |
| phase:2-transform | 0E8A16 | 清洗、预算、隐私审核与导出 |
| phase:3-beta | 7057FF | 质量、真实任务、TestFlight 与 App Store |
| phase:post-mvp | D4C5F9 | 视频、Shortcuts、macOS、MCP 等扩展 |

## Size：预估工作量，必须且只能选一个

| Label | Color | 参考 |
|---|---:|---|
| size:xs | EDEDED | ≤ 半天，单一局部变更 |
| size:s | D4EED1 | 约 1 天，范围明确 |
| size:m | B7E4C7 | 2–3 天，少量跨模块协作 |
| size:l | 74C69D | 4–7 天，需要设计与多类测试 |
| size:xl | 40916C | >1 周，应优先拆分；epic 可使用 |

## Status：只表达异常或待决状态，可选

| Label | Color | 用途 |
|---|---:|---|
| status:blocked | B60205 | 受外部依赖或前置 issue 阻塞，正文必须写 blocker |
| status:needs-decision | FBCA04 | 缺少产品/架构决定，正文列出选项与截止点 |
| status:needs-design | F9D0C4 | 开发前需要 UX flow 或视觉确认 |

不创建 status:todo/in-progress/done；这些由 GitHub Projects/issue state 管理，避免两套状态漂移。

## Risk：跨领域高风险，可选

| Label | Color | 用途 |
|---|---:|---|
| risk:privacy | 8B0000 | 可能泄露、错误遮挡或不当保留用户内容 |
| risk:data-loss | D73A4A | 可能丢失、覆盖或产生不可恢复状态 |
| risk:performance | FFA500 | 时间、内存、磁盘或 Extension 限制风险 |
| risk:app-store | 6F42C1 | 审核、entitlement、隐私申报或上架风险 |

## 示例

“Implement Share Extension inbox ingestion” 应使用：

- type:feature
- area:share-extension
- area:ingestion
- priority:p0
- phase:1-ingest
- size:l
- risk:data-loss
- risk:performance

“Evaluate SwiftData recovery behavior” 应使用：

- type:spike
- area:architecture
- area:persistence
- priority:p0
- phase:0-foundation
- size:s
- status:needs-decision

