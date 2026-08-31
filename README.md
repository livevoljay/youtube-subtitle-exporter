# YouTube Subtitle Exporter

一个可直接加载的 Chrome Manifest V3 扩展。它读取当前 YouTube 视频播放器已经提供的字幕轨道，允许选择原字幕或 YouTube 自动翻译，并导出为 UTF-8 `.txt`、`.srt`、`.vtt` 或 `.json` 文件。所有处理都在浏览器本地完成，不需要后端。

## 功能

- 识别普通 `watch`、Shorts、Live/回放等包含有效视频 ID 的 YouTube 地址。
- 列出播放器提供的人工字幕和自动生成字幕。
- 保留语言名称和语言代码；同语言多轨会标明“人工字幕”或“自动生成”。
- 支持从播放器提供的目标语言中选择 YouTube 自动翻译；翻译请求失败时自动回退原字幕并明确提示。
- 支持 YouTube JSON3，并兼容 XML、WebVTT/SRT 风格的字幕响应；`timedtext` 返回空内容时会回退当前页面的 transcript 接口及新旧两版文字稿面板。
- 删除时间戳、序号、HTML/XML 标签并解码 HTML Entity。
- 对自动字幕的逐步增长、相邻重复和显著首尾重叠进行去重。
- TXT 支持“段落间空行”“合并为自然段”“每句一行”，并可选择保留时间戳。
- 支持 TXT、SRT、WebVTT 和带视频/语言元数据的结构化 JSON。
- 生成 `视频标题_语言.扩展名`，清理非法字符并限制长度，保留中文、日文等 Unicode。
- 每次打开 Popup 都重新读取当前 URL 和播放器数据，兼容 YouTube SPA 视频切换。
- 点击导出后任务在页面内容脚本中继续，Popup 失去焦点关闭不会中断。
- Chrome 确认字幕文件下载完成后发送系统通知、工具栏勾标和 YouTube 页面内提示；失败也会提示原因。系统通知被操作系统关闭时，后两种提示仍可用。

## 项目目录

```text
youtube-subtitle-exporter/
├── .gitignore                 # 忽略本地、依赖与打包文件
├── LICENSE                    # MIT 开源许可证
├── manifest.json              # MV3 清单与最小权限
├── popup.html                 # Popup 结构
├── popup.css                  # Popup 样式
├── popup.js                   # Popup 状态、导出流程
├── content.js                 # 隔离世界消息处理与 SPA 当前视频校验
├── main-world.js              # 从 YouTube 播放器读取轨道元数据
├── background.js              # 字幕请求与 Chrome 下载
├── utils/
│   ├── youtube.js             # URL、轨道、标题和文件名工具
│   └── subtitle.js            # 字幕解析、清洗和去重
├── icons/                     # 扩展图标
├── tests/
│   ├── static-check.js        # 清单、权限、资源和语法检查
│   └── run-tests.js           # 解析及去重测试
├── TESTING.md                 # 测试矩阵和手动验收步骤
└── README.md
```

## 安装

1. 下载或复制本项目文件夹。
2. 在 Chrome 地址栏打开 `chrome://extensions/`。
3. 开启右上角 **Developer mode / 开发者模式**。
4. 点击 **Load unpacked / 加载已解压的扩展程序**。
5. 选择包含 `manifest.json` 的项目根目录。
6. 可把扩展固定到工具栏，方便使用。

要求 Chrome 111 或更高版本（使用了 MV3 content script 的 `world: "MAIN"`）。

## 使用

1. 打开任意可正常播放的 YouTube 视频。
2. 点击工具栏中的 **YouTube Subtitle Exporter**。
3. 等待轨道读取成功并选择需要的字幕。
4. 如需翻译，在“自动翻译”中选择目标语言；保持“不翻译”则导出原字幕。
5. 选择 TXT、SRT、VTT 或 JSON。TXT 还可选择排版方式和是否保留时间戳。
6. 点击导出按钮；看到“后台导出已启动”后即可关闭 Popup 或把鼠标移开。
7. 文件会进入 Chrome 的默认下载目录；同名文件由 Chrome 自动避免覆盖。
8. Chrome 确认下载完成后会发送“字幕导出成功”系统通知。

默认 TXT 使用空行分隔整理后的字幕段落，不包含时间戳和序号，与旧版本行为一致。SRT、VTT 和 JSON 始终保留时间轴。

## 工作方式

扩展优先读取 YouTube 当前播放器的 player response 中的 `captionTracks`，而不是一开始就抓取页面可见文本。轨道中的 `baseUrl` 是 YouTube 为当前视频动态生成的字幕请求地址；代码会先在页面上下文发起同源 JSON3 请求，并回退轨道原始格式。自动翻译只在当前轨道标记为可翻译时，把页面提供的目标语言代码作为 `tlang` 加入该动态地址；翻译请求失败后会重新请求不带 `tlang` 的原轨道。若 YouTube 只暴露原轨道、却让 `timedtext` 返回空正文，扩展会尝试当前页面动态提供的 `get_transcript` 参数和 Innertube 上下文；如果该内部接口也受签名限制，则最后自动打开 YouTube 官方“显示文字稿”面板，优先读取面板绑定的完整数据，再回退读取旧版 `ytd-transcript-segment-renderer` 或新版 `PAmodern_transcript_view` 中的 `transcript-segment-view-model` 字幕段落。URL、API key、签名及临时参数均来自当前页面，没有写死固定 token。

主世界脚本只把当前视频 ID、标题、字幕语言、字幕类型和动态字幕地址传给扩展隔离世界。页面上下文请求会使用浏览器对 YouTube 的正常同源会话，但扩展不会读取、复制或保存 Cookie。字幕下载后只在内存中解析，随后交给 Chrome 下载 API。

## 权限与隐私

扩展只申请：

- `activeTab`：用户点击扩展时确认并读取当前标签页。
- `downloads`：可靠地保存生成的 TXT，并使用 Chrome 的冲突处理避免覆盖文件。
- `notifications`：后台导出真正完成或失败时发送 Chrome 系统通知。
- `https://www.youtube.com/*` 主机权限：在 YouTube 页面读取当前播放器的字幕轨道，并请求该页面给出的 `api/timedtext` 字幕地址。

扩展不申请 Cookie、History、Storage 或 Google 账户权限，不收集、上传或持久保存浏览历史、账户信息、观看记录、视频信息或字幕内容，也不连接任何自有服务器。

## 异常处理

- 非 YouTube 视频页：提示“当前页面不是 YouTube 视频”。
- 播放器未初始化或视频不可用：提示无法获取视频信息，可稍后或刷新重试。
- 无字幕/字幕被禁用：显示无可用字幕并禁用按钮。
- 网络、签名过期、字幕响应为空或下载失败：显示具体错误类型。点击导出时会再次读取播放器的实时轨道地址，以避免使用过期签名。
- 自动翻译失败：不中断导出，自动回退原轨道；文件名和成功提示均按实际导出的原语言显示。
- SPA 切换期间：当前 URL 的视频 ID 必须与播放器响应一致；旧视频数据会被拒绝并短暂重试。

## 已知限制

- YouTube 没有为普通网页提供稳定、长期兼容的公开字幕导出 API。播放器配置字段、`api/timedtext` 响应格式、签名或反自动化策略变化都可能影响兼容性。
- 私密、年龄限制、会员、付费、地区限制或需要登录的视频，能否导出取决于当前页面是否已获得可用字幕轨道和有效请求地址。
- 直播中的实时字幕可能尚未形成完整轨道；建议直播结束并生成回放字幕后导出。
- “自动翻译”使用 YouTube 页面当前提供的非公开能力，目标语言列表和成功率可能随视频、地区、账号状态或页面版本变化；失败时只保证回退原字幕。
- 去重算法保守处理相邻滚动字幕，避免误删正常重复表达；极少数自动字幕仍可能有重复，或刻意重复的台词可能被合并。
- 超长字幕通过 Chrome `data:` 下载 URL 传递。日常长视频可正常使用；若遇到浏览器实现限制，后续可改用离屏文档生成 Blob URL。

## 测试

```bash
npm run check
```

自动化和手动测试矩阵见 [TESTING.md](TESTING.md)。自动化测试覆盖旧版默认 TXT、翻译 URL、时间轴、三种 TXT 排版和四种文件格式，不访问网络，也不依赖固定公开视频。

## 后续开发建议

1. 提供按标点和停顿智能合并自然段，而不仅按字幕 cue 合并。
2. 增加双语字幕输出和原文/译文上下排列模式。
3. 为超长字幕使用 offscreen document + Blob 流式下载。
4. 建立定期的 YouTube 页面兼容性冒烟测试，并对 player response 字段变化提供备用解析器。

## 开发说明

项目没有运行时第三方依赖，也没有构建步骤。修改源码后在 `chrome://extensions/` 点击扩展卡片上的刷新按钮，再刷新 YouTube 页面即可测试。

## 许可证

本项目采用 [MIT License](LICENSE)。
