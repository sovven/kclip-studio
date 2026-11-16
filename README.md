# KCLIP Studio

韩流短视频 → 小红书双语字幕内容工作台。苹果风格，支持浅色和深色。

- **发现**：按栏目找韩国短视频（今日热点 / 韩网话题 / 综艺名场面 / 爱豆有梗 / 访谈金句 / 生活共鸣 / 热播韩剧），栏目可以自己增删（填搜索词或频道链接）。后端会拿栏目的搜索词自动去找「专门做有台词短视频」的频道（剪辑号、综艺切片），舞蹈、MV、挑战和没有韩语台词的一律过滤，体育和时政也不要。按「值得做」排序，可标记不感兴趣、隐藏已做。
- **贴链接直接做**：把视频链接粘贴进搜索框，直接打开制作面板。
- **AI 精选**：从所有候选里挑 8 条，写好中文标题、内容简介和推荐理由。
- **一键制作**：交给 Agent，调用 [xhs-bilingual-clip](https://github.com/sovven/xhs-bilingual-clip) skill 产出成片、3:4 封面（4 种样式，可自选高亮色）、小红书文案和剪映分层素材。
- **模板**：输入单词一键出「韩语快问快答」视频；分轨剪辑器可改文字、配图、配音和背景色，导出后进作品库。
- **制作 / 作品库**：拖动排序批量制作，查看流水线进度，可停止、重试、删除；页内播放成片、对文案；一键把成片、封面、文案打成 zip，下载或复制到系统剪贴板（Windows）。

需求文档见 [docs/PRD.md](docs/PRD.md)。

## 运行
```bash
npm i
npm run build
node server.mjs   # http://localhost:5291
```
依赖：Node 22+；`D:\Tools\yt-dlp\yt-dlp.exe`；whisper.cpp；ffmpeg；已登录的 Claude Code CLI（`claude` → `/login`）或 Codex CLI（`codex login`），在左下角切换，“…”菜单可添加自己的 API；skill 装在 `~/.claude/skills/xhs-bilingual-clip`。

前端：Vite + React + shadcn/ui（radix-nova）+ Lucide + Motion + react-resizable-panels + dnd-kit + Zustand。
