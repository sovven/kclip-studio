# KCLIP Studio

韩流短视频 → 小红书双语字幕内容工作台。苹果风格，支持浅色和深色。

- **发现**：按板块抓取 YouTube 上的韩国 Shorts（综艺搞笑、梗、K-POP、舞蹈、获奖感言、韩剧名场面、外研社同款来源等），也可以搜索关键词。会自动过滤体育和时政内容。
- **今日推荐**：Claude 挑 8 条，写好内容简介、共鸣点和推荐度。
- **一键制作**：交给 Agent，调用 [xhs-bilingual-clip](https://github.com/sovven/xhs-bilingual-clip) skill 产出成片、3:4 封面（4 种样式，可自选高亮色）、小红书文案和剪映分层素材。
- **制作 / 作品库**：拖动排序批量制作，查看流水线进度，播放成片，复制文案。

需求文档见 [docs/PRD.md](docs/PRD.md)。

## 运行
```bash
npm i
npm run build
node server.mjs   # http://localhost:5291
```
依赖：Node 22+；`D:\Tools\yt-dlp\yt-dlp.exe`；whisper.cpp；ffmpeg；已登录的 Claude Code CLI（`claude` → `/login`）；skill 装在 `~/.claude/skills/xhs-bilingual-clip`。

前端：Vite + React + shadcn/ui（radix-nova）+ Lucide + Motion + react-resizable-panels + dnd-kit + Zustand。
