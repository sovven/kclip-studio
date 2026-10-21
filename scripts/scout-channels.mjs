// 频道侦察：给一批 YouTube 频道 handle 打分（最新 12 条 Shorts 的播放量中位数 / 最高值），
// 并从标题、话题标签里统计爱豆名字的热度。用来挑"更新勤、看的人多"的素材频道。
// 用法：node scripts/scout-channels.mjs handle1 handle2 ...   → 输出排行；加 --json 输出 JSON
import { execFile } from "node:child_process";

const YTDLP = "D:/Tools/yt-dlp/yt-dlp.exe";
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const handles = args.filter((a) => a !== "--json");

const fetchShorts = (h) =>
  new Promise((res) =>
    execFile(YTDLP, ["--flat-playlist", "-J", "--playlist-end", "12", `https://www.youtube.com/@${h}/shorts`], { maxBuffer: 1e8, timeout: 120000 }, (e, out) => {
      try {
        const pl = JSON.parse(out);
        res({ handle: h, name: pl.channel || pl.uploader || h, entries: (pl.entries || []).map((x) => ({ id: x.id, title: x.title || "", views: x.view_count || 0 })) });
      } catch {
        res({ handle: h, name: null, entries: [] });
      }
    }),
  );

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const results = [];
for (let i = 0; i < handles.length; i += 8) results.push(...(await Promise.all(handles.slice(i, i + 8).map(fetchShorts))));

const ok = results.filter((r) => r.entries.length);
const table = ok
  .map((r) => ({ handle: r.handle, name: r.name, n: r.entries.length, median: median(r.entries.map((e) => e.views)), max: Math.max(...r.entries.map((e) => e.views)) }))
  .sort((a, b) => b.median - a.median);

// 话题标签热度（播放量加权）：#StrayKids、#리노 这类
const tags = new Map();
for (const r of ok) for (const e of r.entries) for (const t of new Set(e.title.match(/#[^\s#]+/g) || [])) tags.set(t, (tags.get(t) || 0) + e.views);
const topTags = [...tags].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t, v]) => ({ tag: t, views: v }));

if (asJson) console.log(JSON.stringify({ channels: table, failed: results.filter((r) => !r.entries.length).map((r) => r.handle), topTags }, null, 2));
else {
  const w = (n) => (n >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : String(n));
  console.log("中位数\t最高\t频道");
  for (const t of table) console.log(`${w(t.median)}\t${w(t.max)}\t@${t.handle}  ${t.name}`);
  console.log("\n找不到：", results.filter((r) => !r.entries.length).map((r) => r.handle).join(" "));
  console.log("\n热门话题标签：", topTags.slice(0, 30).map((t) => `${t.tag}(${w(t.views)})`).join(" "));
}
