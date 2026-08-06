# Issue Label Taxonomy

## 使用规则

每个 issue 至少包含一个 `type:*`、一个 `area:*`、一个 `priority:*`、一个 `phase:*`、一个 `size:*`。

所有实现 issue 还必须包含至少一个 `platform:*`。涉及代码边界时添加一个或多个 `layer:*`。只有确实需要时添加 `status:*`、`risk:*` 或 `test:*`。

## Type：必须且只能选一个

| Label | Color | 用途 |
|---|---:|---|
| type:epic | 3E4B9E | 跨 issue 交付目标 |
| type:feature | 1D76DB | 用户可感知能力 |
| type:task | 0E8A16 | 明确工程工作 |
| type:spike | FBCA04 | 有时限的技术验证，输出证据与 ADR |
| type:bug | D73A4A | 已有行为偏离需求或回归 |
| type:docs | 0075CA | 产品、架构、开发或发布文档 |
| type:chore | BFD4F2 | 构建、依赖和维护工作 |

## Platform：实现 issue 至少一个，可多选

| Label | Color | 用途 |
|---|---:|---|
| platform:shared | 0969DA | 跨平台 TypeScript、schema、fixture 或产品行为 |
| platform:ios | A2AAAD | iOS/iPadOS、Swift、Xcode、Share Extension |
| platform:android | 3DDC84 | Android、Kotlin、Gradle、share intents |
| platform:desktop | 8B949E | macOS、浏览器扩展、MCP 或其他桌面工作流 |

仅加 `platform:shared` 表示没有平台原生实现；同时包含三者表示共享层与两端适配器都在范围内。

## Layer：按代码边界选择，可多选

| Label | Color | 用途 |
|---|---:|---|
| layer:react-native | 61DAFB | React Native UI、TypeScript domain 和 workflow |
| layer:native | 6E7781 | Swift/Kotlin 原生入口、模块或 renderer |

## Area：至少一个，可多选

| Label | Color | 用途 |
|---|---:|---|
| area:architecture | 5319E7 | 模块边界、ADR、依赖与协议 |
| area:mobile-app | 7057FF | React Native 主 App 生命周期、导航和组装 |
| area:ios-app | A2AAAD | iOS 专属 lifecycle、entitlement 与系统集成 |
| area:android-app | 3DDC84 | Android lifecycle、manifest、Gradle 与系统集成 |
| area:share-extension | 8B5CF6 | iOS Share Extension 与 App Group |
| area:android-share | 2DA44E | Android ACTION_SEND/MULTIPLE 与私有 Inbox |
| area:ingestion | 006B75 | 导入、类型识别、manifest、hash |
| area:extraction | 008672 | OCR、PDF、文本和 URL 提取 |
| area:processing | 0B4F6C | 规范化、去重、估算和压缩 |
| area:privacy | B60205 | 检测、审核、遮挡与日志安全 |
| area:export | D4C5F9 | Markdown、PDF、bundle、clipboard、share |
| area:persistence | BFDADC | SQLite、文件、迁移、清理与恢复 |
| area:ui-ux | F9D0C4 | 编辑器、预览、onboarding、可访问性 |
| area:quality | C5DEF5 | 测试、fixture、性能、CI 与 release gate |
| area:release | 1D76DB | TestFlight、Play Internal、App Store、Google Play |

## Priority：必须且只能选一个

| Label | Color | 定义 |
|---|---:|---|
| priority:p0 | B60205 | 阻塞 phase 或涉及数据丢失/隐私泄漏 |
| priority:p1 | D93F0B | 当前 phase 必须完成 |
| priority:p2 | FBCA04 | 重要但可延期 |
| priority:p3 | C2E0C6 | 候选或 post-MVP |

## Phase：必须且只能选一个

| Label | Color | 用途 |
|---|---:|---|
| phase:0-foundation | 0052CC | RN 工程、原生入口、CI、contract 与关键 spike |
| phase:1-ingest | 006B75 | 双端输入、提取、manifest 与恢复 |
| phase:2-transform | 0E8A16 | 清洗、预算、隐私审核与导出 |
| phase:3-beta | 7057FF | 质量、真实任务、双端 beta 与上架 |
| phase:post-mvp | D4C5F9 | 视频、自动化、macOS、MCP 等 |

## Size：必须且只能选一个

| Label | Color | 参考 |
|---|---:|---|
| size:xs | EDEDED | ≤半天 |
| size:s | D4EED1 | 约 1 天 |
| size:m | B7E4C7 | 2–3 天 |
| size:l | 74C69D | 4–7 天 |
| size:xl | 40916C | >1 周；除 epic 外应优先拆分 |

## Status：异常或待决状态，可选

| Label | Color | 用途 |
|---|---:|---|
| status:blocked | B60205 | 有明确外部 blocker |
| status:needs-decision | FBCA04 | 缺少产品/架构决定 |
| status:needs-design | F9D0C4 | 需要 UX/视觉决定 |

## Risk：可多选

| Label | Color | 用途 |
|---|---:|---|
| risk:privacy | 8B0000 | 内容泄漏或错误遮挡 |
| risk:data-loss | D73A4A | 丢失、覆盖或不可恢复状态 |
| risk:performance | FFA500 | 时间、内存、磁盘、热量或 Extension 限制 |
| risk:store-review | 6F42C1 | App Store/Google Play 审核、权限或申报 |
| risk:platform-parity | BF8700 | 双端行为、contract 或安全保证不一致 |
| risk:experimental-api | CF222E | 依赖实验性或非官方平台行为 |

## Test：特殊验收要求，可选

| Label | Color | 用途 |
|---|---:|---|
| test:device-required | 8250DF | 仅用于 v0.1 之外明确要求物理设备证据的工作 |
| test:contract | 1F6FEB | 两端必须通过同一 versioned contract fixture |

根据 [ADR-0003](../adr/0003-v0.1-virtual-device-verification.md)，`test:device-required` 不得应用于 v0.1 Epic #2 或 Issues #3–#24。该 label 保留给 post-MVP 或未来版本；v0.1 的特殊平台证据在 issue acceptance criteria 中写明 Simulator/Emulator/CI/store-processing 矩阵与限制。

## 示例

“Implement cross-platform share ingestion”：

- type:feature
- platform:shared
- platform:ios
- platform:android
- layer:react-native
- layer:native
- area:share-extension
- area:android-share
- area:ingestion
- priority:p0
- phase:1-ingest
- size:l
- risk:data-loss
- risk:performance
- risk:platform-parity
- test:contract
