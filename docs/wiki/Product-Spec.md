# Product Specification — AI Context Pack MVP

## 1. 版本与假设

- 目标版本：v0.1 MVP。
- 首发平台：iPhone、iPad 与 Android 手机/平板；iOS/iPadOS 16.4+，Android API 24+。
- 技术方向：React Native 0.86 + Expo SDK 57 modules + TypeScript strict；Swift/Kotlin 原生适配器；本地优先、无账号。
- 目标语言：首发 UI 支持英文和简体中文；OCR 使用系统支持的自动语言识别。
- 主要分发：TestFlight 与 Google Play Internal Testing；验收通过后提交 App Store 与 Google Play。
- 主要入口：iOS Share Extension 与 Android share intents；主 App 导入作为完整编辑入口。
- v0.1 验收环境：iOS Simulator 与 Android Emulator/AVD；不要求物理 iPhone、iPad 或 Android 设备。虚拟环境证据规则见 [ADR-0003](../adr/0003-v0.1-virtual-device-verification.md)。

## 2. 用户故事

- 作为程序员，我希望把报错截图、日志和需求文件一次性整理好，以便直接交给 AI 排查。
- 作为产品经理，我希望把多个来源按正确顺序组合并控制大小，以便 AI 能完整理解上下文。
- 作为隐私敏感用户，我希望在分享前发现并遮挡秘密和个人信息。
- 作为 AI 重度用户，我希望使用标准格式导出，不被绑定到某一个 AI 平台。
- 作为移动用户，我希望整个操作从系统分享菜单开始，不需要重复切换和逐个上传。

## 3. 功能需求

### FR-001：创建 Pack

- 用户可在主 App 创建空 Pack。
- 从 Share Extension 接收内容时自动创建 Pack，或追加到用户选择的现有 Draft。
- 默认标题由日期和首个来源生成，用户可修改。
- Pack 必须有稳定 UUID、创建时间、更新时间、状态和版本字段。

验收：终止并重新打开 App 后，Draft 及顺序完整保留。

### FR-002：系统分享接收

- iOS Share Extension 接收 image、PDF、plain text 与 URL，通过 NSItemProvider 读取并复制到 App Group Inbox。
- Android 接收 ACTION_SEND 与 ACTION_SEND_MULTIPLE，通过 ContentResolver 立即复制到 app-private Inbox。
- 两端支持一次分享多个 item，并显示已接收、拒绝和失败数量。
- 系统入口只做轻量复制、校验和 ImportManifestV1 写入，重处理交给主 App。
- iOS 不使用从 Extension 自动打开主 App 的非官方 API。
- 内存不足、超时、URI 权限失效或部分文件失败时，保留已成功项并提供可恢复错误。

验收：在对应 Simulator/Emulator 可用的 iOS Photos/Files/Safari 与 Android Photos/Files/Chrome 主机路径分别完成端到端测试；一次分享 20 张图片不丢项；两端 manifest 均通过同一 contract test。虚拟系统镜像缺少的主机 App 或 OS 集成必须记录为限制，不能静默算作通过。

### FR-003：主 App 导入

- React Native 主 App 支持多图、PDF、文本文件、纯文本和 URL。
- iOS 使用系统 Photos/Files picker，Android 使用系统 Photo Picker/Storage Access Framework。
- 导入前后显示类型、数量、大小和不支持项。
- 所有 provider URI 在授权窗口内复制到应用控制的文件目录。
- 取消选择不产生空 Pack，不支持格式不导致 App 崩溃。

验收：iOS 与 Android 的取消、部分失败、重复选择和权限失效场景均有自动化或可重复手工测试。

### FR-004：统一 Ingestion Manifest

- 每个输入项记录 source kind、原始类型、大小、hash、导入时间、原始文件引用和处理状态。
- 输入按到达顺序保存，用户可重新排序。
- 完全相同的二进制文件被标记为 duplicate，但不自动删除。
- 临时文件采用原子移动，重复启动可幂等恢复。

验收：模拟进程在复制中断后重启，不产生半写文件或重复 item。

### FR-005：图片 OCR

- iOS 使用 Apple Vision；Android 使用 ML Kit Text Recognition v2。
- Android MVP 打包 Latin 与 Chinese 模型，确保首次使用和飞行模式可工作。
- 两端统一输出 OCRResultV1：完整文本、block、归一化 bounding box、可选语言与置信度、engine/revision 和耗时。
- 支持旋转方向和常见截图尺寸，低置信度文本在 UI 中标记。
- JS/原生边界只传文件 URI 与结构化结果，不传图片字节。
- 用户可选择只导出原图、只导出 OCR 或两者。

验收：英文/中文 fixture 在两端达到各自阈值；不要求两种引擎逐字相同，但 contract、坐标合法性和关键字符串结果必须稳定。

### FR-006：PDF 提取

- iOS 使用 PDFKit 提取嵌入文本，无文本或低密度页面渲染后交给 Vision OCR。
- Android API 35+ 优先使用 PdfRenderer 文本内容；API 24–34 与扫描页采用逐页渲染后交给 ML Kit。
- 不在内存中保留整份 PDF 的位图；逐页处理、限制并发并支持取消/checkpoint。
- 逐页记录提取方式、字符数、engine revision 和失败状态。
- 加密、损坏、超页数或超大小 PDF 给出可理解错误，不绕过保护。
- MVP 默认限制为单个 PDF 25 页、50 MB；修改限制必须有基准证据。

验收：文本、扫描、混合、损坏与超限 PDF 均有 fixture；Android API 24/35+ 和 iOS 分别验证。

### FR-007：文本与 URL 规范化

- 统一 UTF-8、换行和不可见控制字符。
- 保留代码缩进，不对代码块做破坏性空白压缩。
- URL 保存 scheme、host、path 和原始 URL；展示时默认隐藏查询参数中的潜在敏感值。
- MVP 不通过开发者服务器抓取 URL；Safari 已提供的标题或选中文本可保存。

验收：代码、中文、emoji 和超长 URL 往返导出不丢失。

### FR-008：去重与顺序

- SHA-256 标记完全重复文件。
- 图片使用感知哈希生成近似重复提示。
- OCR 文本使用规范化指纹提示高相似项。
- 自动结果只作为建议；用户确认前不删除。
- 拖拽排序结果写入持久化层并进入导出顺序。

验收：重复检测有 precision/recall fixture；误报可一键保留。

### FR-009：大小与 token 估算

- 展示输入/输出字节数、字符数、图片数、PDF 页数和估算 token。
- 估算算法与版本写入 Pack manifest。
- 支持 Quality、Balanced、Compact 三个预设和自定义最大文件大小。
- 预算优化必须保持最低分辨率和文字可读性阈值。

验收：相同输入和预设生成稳定输出；估算值明确标记为 estimate。

### FR-010：图片压缩

- 保留原始文件，派生处理版本。
- 支持最长边调整、JPEG/HEIC 质量调整和必要时格式转换。
- 透明 PNG 不应静默转换为有损且丢失透明度的格式。
- 处理结果记录尺寸、质量、编码格式和节省比例。

验收：输出可被系统预览和主流目标 App 打开；图片中文字通过可读性测试。

### FR-011：敏感信息检测

- 首批规则：常见 API Key、Bearer Token、JWT、私钥头、URL credential、邮箱、手机号、IPv4/IPv6 和银行卡候选。
- 每个命中记录类型、范围、置信度、来源 item 和检测器版本。
- 高误报类型标记为“需要确认”，不默认遮挡。
- 检测引擎不得把原文写入普通日志。

验收：维护正例、难例和负例语料；安全关键模式的回归测试必须进入 CI。

### FR-012：遮挡审核

- 文本命中可替换为统一占位符，例如 [REDACTED_API_KEY]。
- 图片命中可依据 OCR 坐标生成遮挡区域，也允许用户手工框选。
- 用户可按命中、按类型进行保留或遮挡，并可撤销。
- 导出的图片必须 flatten，无法通过移除图层恢复原像素。

验收：对导出结果再次 OCR 或像素检查，原敏感文本不可恢复。

### FR-013：Pack 编辑器

- 显示处理状态、失败项、风险项和预算状态。
- 支持标题、任务说明、item 顺序、包含模式、重命名、删除和重试。
- 删除默认仅从 Pack 移除；是否删除本地原件需二次确认。
- 在数据未保存完成前提供明确进度，不允许误以为已完成。

验收：VoiceOver 与 TalkBack 均可完成核心流程；所有 destructive action 均可取消或撤销。

### FR-014：Markdown 输出

- 输出包含 manifest 头、用户说明、目录、item 来源、结构化正文和附件索引。
- 代码文本使用 fenced code block，动态选择 fence 长度避免内容破坏结构。
- 文件名使用安全 slug 并保证唯一。
- 用户可预览、复制、保存或分享 Markdown。

验收：导出的 Markdown 通过 parser round-trip 测试；内容顺序与预览一致。

### FR-015：PDF 与附件包输出

- PDF 适合人类阅读，包含目录、页码和来源信息。
- Attachment bundle 包含 README.md、manifest.json 和处理后附件。
- ZIP 内不得包含原始未遮挡派生物或临时文件。
- 支持保存到 iOS Files、Android Documents 与系统 Share Sheet。

验收：解压后的 manifest 引用均存在，哈希校验正确，无路径穿越文件名。

### FR-016：历史与生命周期

- 主界面列出 Draft、Ready、Exported 和 Failed Pack。
- 支持复制 Pack、重新导出和删除。
- 临时 Inbox 有明确过期策略；清理任务幂等。
- 用户可查看各 Pack 占用空间并手工清理派生文件。

验收：清理不删除仍被 Pack 引用的文件；删除结果在重启后保持。

### FR-017：错误与恢复

- 每个 pipeline stage 使用可重试状态和结构化错误码。
- 单 item 失败不阻塞其他 item，但导出前必须明确提示不完整。
- 崩溃或系统终止后从最后一个一致 checkpoint 恢复。
- 用户能够重新运行某个 stage，而不必重新导入所有内容。

验收：注入每个 stage 的失败并验证恢复路径。

## 4. 非功能需求

### NFR-001：隐私

- MVP 核心流程在飞行模式下可运行。
- 不收集用户内容、OCR 原文或检测命中原文。
- 任何未来网络能力默认关闭并需要独立同意。

### NFR-002：性能

- 10 张常见手机截图在固定的最低支持与当前 Simulator/Emulator 验收配置上 15 秒内完成 OCR 与基础处理，或取得明确 release-risk 决定。
- 主线程不执行 OCR、PDF 渲染、hash 或压缩。
- 大任务显示 item 级进度并支持取消。
- 所有时间、内存和资源数据必须注明虚拟配置与宿主环境，不得作为物理硬件性能、热量、电池或兼容性声明。

### NFR-003：资源限制

- iOS Share Extension 与 Android share receiver 避免重处理并尽快完成复制。
- Pipeline 设置并发上限，针对内存警告降级。
- 磁盘空间不足时在写入前失败并保留可恢复状态。

### NFR-004：安全

- 文件名和归档路径经过规范化。
- 日志经过隐私审查。
- 导出目录从 allowlist 构建，不遍历临时目录。

### NFR-005：可访问性与本地化

- Dynamic Type/Android font scaling、VoiceOver/TalkBack、足够颜色对比度。
- 用户可见字符串进入共享 i18n catalog；平台原生 target 的字符串进入对应资源。
- 英文和简体中文 UI 在 Beta 前完成。

### NFR-006：跨平台一致性

- 共享领域协议和 manifest 必须版本化。
- 每个功能 issue 明确 shared、iOS、Android 的职责与验收。
- 平台结果允许实现差异，但不得静默缺失功能或降低隐私保障。
- 支持矩阵至少覆盖 iOS 16.4、当前 iOS，以及 Android API 24、35、36。

### NFR-007：可测试性

- 核心 pipeline 使用协议和纯数据模型，可在无 UI 环境测试。
- 测试 fixture 不包含真实凭据或个人信息。
- 每个导出生成 manifest 与 hash，便于 golden test。

## 5. 数据模型

### ContextPack

- id、schemaVersion、title、userInstruction、createdAt、updatedAt。
- status、selectedPreset、budget、estimatedTokens。
- ordered item references、export records、warnings。

### ContextItem

- id、sourceType、uniformType、originalFilename、originalHash。
- localOriginalReference、derivedArtifactReferences。
- extraction status/result、risk findings、inclusion mode、sortIndex。

### RiskFinding

- id、detectorVersion、category、confidence、text range 或 image region。
- decision：pending、keep、redact。
- 禁止在非加密日志中复制 matched secret。

### ExportRecord

- id、format、createdAt、preset、manifest hash、artifact references。
- success/failure status 与不含用户内容的结构化错误。

## 6. Definition of Done

- 功能需求对应自动化或可重复手工验收证据。
- 新代码通过 lint、单元测试和相关 UI 测试。
- 不引入用户内容日志或未声明网络请求。
- 错误、空状态、取消和恢复路径已覆盖。
- 更新文档、变更日志和必要的隐私说明。
- 在最低支持与当前 iOS Simulator runtime，以及 Android API 24/35/36 Emulator/AVD 矩阵上验证；若 API 36 system image 尚不可用，必须记录工具链限制和 release-risk 决定。
- 物理 iPhone、iPad 或 Android 设备不属于 v0.1 验收；虚拟环境不支持的主机 App、传感器、热量或 store-install 场景必须作为限制记录，不能标记为已通过。
