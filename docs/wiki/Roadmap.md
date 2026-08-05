# Implementation Roadmap

## 总体策略

先证明一条 iOS/Android 都可用、隐私安全、可恢复的完整路径，再扩展格式和自动化。每个 Phase 都有 promotion gate；共享功能只有在两端达到明确验收后才算完成。

v0.1 的平台验收统一使用 iOS Simulator 和 Android Emulator/AVD，不要求物理设备。虚拟设备结果必须注明 runtime/API、profile、host/toolchain 与限制，不能当作物理硬件性能或兼容性声明；完整规则见 [ADR-0003](../adr/0003-v0.1-virtual-device-verification.md)。

## Phase 0 — Cross-platform foundation

目标：得到可编译、可测试、可持续集成的 React Native 双端工程，并验证最危险的原生边界。

交付：

- React Native 0.86 + Expo SDK 57 modules + TypeScript strict。
- `ios/`、`android/` 纳入版本控制，Development Build 可运行。
- iOS Share Extension + App Group Inbox。
- Android ACTION_SEND/ACTION_SEND_MULTIPLE + app-private Inbox。
- ImportManifestV1 跨平台 contract。
- Vision/ML Kit OCR adapter spike。
- PDFKit/PdfRenderer + OCR fallback spike。
- SQLite/file storage、recovery、CI、privacy-safe logging。
- ADR：React Native 架构、原生边界、系统版本和 upgrade policy。

Promotion gate：

- clean checkout 可构建 iOS 主 App、iOS Extension 与 Android App。
- 两端均可导入至少一张图片并生成通过同一 schema 的 manifest。
- 两端 OCR adapter 返回合法 OCRResultV1。
- Android PDF fallback 有基准结果和明确限制。
- 无用户内容进入日志。
- 不使用 Expo 实验性 iOS 入站分享或非官方自动打开主 App 行为。

## Phase 1 — Ingest and extract

目标：可靠接收所有 MVP 输入，并在两个平台生成统一、可恢复的提取结果。

交付：

- iOS/Android 多 item 系统分享接收。
- 主 App 的 Photos/Files/Text/URL 导入。
- 图片 OCR、PDF 文本提取与扫描页 OCR fallback。
- 统一 manifest、hash、checkpoint、item 级错误。
- React Native Pack 列表、详情、导入预览和状态展示。

Promotion gate：

- iOS Simulator 上可用的 Photos/Files/Safari 与 Android Emulator 上可用的 Photos/Files/Chrome 导入通过；镜像缺失能力有显式限制记录。
- 两端一次分享 20 张截图不丢项。
- 文本/扫描/混合/损坏/超限 PDF 有确定结果。
- API 24 与 API 35+ Android PDF 路径均验证。
- 中断恢复不重复、不丢失、不产生半写文件。
- 所有失败项可见并可重试。

## Phase 2 — Transform, privacy and export

目标：将输入变成安全、紧凑、可发送的跨平台上下文包。

交付：

- 共享 TypeScript 规范化、规则检测、预算估算和 Markdown。
- 原生感知 hash、图片压缩和不可逆像素遮挡。
- 敏感信息检测、审核、手工框选和文本替换。
- React Native Pack Editor 与最终预览。
- Markdown、PDF、attachment bundle 与系统分享。

Promotion gate：

- 典型 10 张截图在固定 Simulator/Emulator 配置预算内完成，UI 保持可响应，或有明确 release-risk 决定。
- 两端 Markdown/manifest 相同 fixture 结果一致。
- PDF、bundle/hash/path traversal 测试通过。
- 高风险 finding 未决时，两端均默认阻止正常导出。
- flatten 后敏感像素/文本不可恢复。
- 平台差异有文档，不存在静默功能降级。

## Phase 3 — Beta and store readiness

目标：通过真实任务、虚拟设备性能/资源基线和隐私审查，达到 TestFlight、Google Play Internal Testing、App Store 与 Google Play 的发布质量。

交付：

- 历史、删除、空间管理、迁移和生命周期清理。
- onboarding、权限解释、空状态和错误恢复。
- VoiceOver/TalkBack、Dynamic Type/font scaling、英文/中文。
- 双端 Simulator/Emulator 性能矩阵、崩溃、低内存、低磁盘与资源测试，并记录无法由虚拟环境证明的硬件限制。
- 隐私政策、store privacy/data safety 回答、beta build、release checklist。

Promotion gate：

- 至少 20 个真实任务，并在 iOS Simulator 与 Android Emulator 上覆盖两个平台；任务完成率 ≥80%。
- P0/P1 bug 为 0。
- 两端在 Simulator/Emulator 的飞行模式或等效网络禁用配置下核心流程通过。
- 隐私、日志、依赖/license 和平台权限审计通过。
- TestFlight 与 Play Internal 的签名、上传、处理、metadata/policy 和 track readiness 通过；单独构建的 Release 配置 Simulator/Emulator artifact 完成支持的安装、升级、删除、导入、导出和数据清理验证。

## Phase 4 — Post-MVP

- 屏幕录制：双端关键帧抽取、转录和重复帧删除。
- iOS App Intents/Shortcuts 与 Android App Shortcuts/intent integrations。
- ChatGPT、Claude、Codex 目标预设，同时保持标准输出。
- macOS、浏览器扩展与跨设备 workflow。
- MCP Server：仅让桌面 AI 读取用户明确选择的 Pack。
- 可选云同步与端到端加密共享。

进入条件：MVP 有稳定使用证据，且真实失败明确指向该扩展。

## 建议开发顺序

1. Issue #3：双端工程与可行性 spike。
2. Shared domain、schema、SQLite 与 Inbox recovery。
3. iOS Share Extension + Android share receiver。
4. OCR/PDF adapter 与完整输入矩阵。
5. React Native Pack UI。
6. normalization、duplicate、budget 与 compression。
7. privacy detection/review/native redaction。
8. Markdown → bundle → PDF export。
9. recovery、storage、accessibility、localization。
10. performance、双端 beta、store release。
