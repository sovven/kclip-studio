# KCLIP Studio

韩流短视频 → 小红书双语字幕内容工作台。苹果风格，支持浅色和深色。

- **发现**：按栏目找韩国短视频（今日热点 / 韩网话题 / 综艺名场面 / 爱豆有梗 / 访谈金句 / 生活共鸣 / 热播韩剧），栏目可以自己增删（填搜索词或频道链接）。后端会拿栏目的搜索词自动去找「专门做有台词短视频」的频道（剪辑号、综艺切片），舞蹈、MV、挑战和没有韩语台词的一律过滤，体育和时政也不要。按「值得做」排序，可标记不感兴趣、隐藏已做。
- **贴链接直接做**：把视频链接粘贴进搜索框，直接打开制作面板。
- **AI 精选**：从所有候选里挑 8 条，写好中文标题、内容简介和推荐理由。
- **一键制作**：交给 Agent，调用 [xhs-bilingual-clip](https://github.com/sovven/xhs-bilingual-clip) skill 产出成片、3:4 封面（4 种样式，可自选高亮色）、小红书文案和剪映分层素材。
- **模板**：输入单词一键出「韩语快问快答」视频；分轨剪辑器可改文字、配图、配音和背景色，导出后进作品库。
- **制作 / 作品库**：拖动排序批量制作，查看流水线进度，可停止、重试、删除；页内播放成片、对文案；一键把成片、封面、文案打成 zip，下载或复制到系统剪贴板（Windows）。

需求文档见 [docs/PRD.md](docs/PRD.md)。

## 安装和运行

需要 [Node.js 22+](https://nodejs.org) 和 git。Windows、macOS、Linux 都可以（「复制 zip 到剪贴板」只有 Windows 有）。

```bash
git clone https://github.com/sovven/kclip-studio.git
cd kclip-studio
npm install
npm run setup    # 下载出片模板、装它的依赖，并列出还缺什么
npm start        # 构建页面并启动 → http://localhost:5291
```

打开页面后点左下角 **环境**：每一项缺什么、用哪条命令装、装好后路径填哪里，都写在那里，装完点「重新检查」。不用改代码，也不用把工具装到固定位置。

| 想用的功能 | 需要 |
| --- | --- |
| 发现（找视频、搜索、贴链接） | yt-dlp |
| AI 精选 | 上一行 + Claude Code CLI 或 Codex CLI（登录账号，或在左下角「…」里添加自己的 API 地址和 Key） |
| 制作双语字幕视频 | 以上 + ffmpeg、whisper.cpp 和一个 ggml 模型、出片模板 xhs-bilingual-clip、Noto Sans KR/SC 字体 |
| 模板（韩语快问快答） | AI + ffmpeg |

说明：

- 所有数据（作品、缓存、API Key、设置）都在本机的 `jobs/` 文件夹，不上传，也不进 git。
- 服务只监听本机（127.0.0.1）。它能让 AI 在你的电脑上执行命令，不要把它暴露到公网；确实要给局域网里别的设备用，自己设环境变量 `HOST=0.0.0.0`。
- 路径也可以用环境变量指定：`KCLIP_YTDLP`、`KCLIP_WHISPER`、`KCLIP_WHISPER_MODEL`、`KCLIP_SKILL`、`KCLIP_FONTS`；端口用 `PORT`。
- 制作一条视频要让 AI 跑 10–20 分钟，消耗的是你自己账号的额度。

前端：Vite + React + shadcn/ui（radix-nova）+ Lucide + Motion + react-resizable-panels + dnd-kit + Zustand。
