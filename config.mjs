// 环境配置：不写死任何一台电脑的路径。
// 每个工具按这个顺序找：环境变量 → jobs/config.json（页面「环境」里填的）→ PATH → 常见位置。
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const WIN = process.platform === "win32", MAC = process.platform === "darwin";
const isFile = (p) => { try { return !!p && statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return !!p && statSync(p).isDirectory(); } catch { return false; } };

export function which(cmd) {
  const exts = WIN ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const f = path.join(dir, cmd + ext.toLowerCase());
      if (isFile(f)) return f;
      const g = path.join(dir, cmd + ext);
      if (isFile(g)) return g;
    }
  }
  return "";
}

const FONT_DIRS = WIN
  ? ["C:/Windows/Fonts", path.join(os.homedir(), "AppData/Local/Microsoft/Windows/Fonts")]
  : MAC ? [path.join(os.homedir(), "Library/Fonts"), "/Library/Fonts"]
  : [path.join(os.homedir(), ".local/share/fonts"), path.join(os.homedir(), ".fonts"), "/usr/share/fonts/truetype/noto", "/usr/share/fonts/noto", "/usr/share/fonts"];
export const FONT_FILES = { kr: "NotoSansKR-VF.ttf", sc: "NotoSansSC-VF.ttf" };

// 可以在页面上填的项目：key → 说明
const EDITABLE = {
  ytdlp: "file", whisper: "file", whisperModel: "file", skill: "dir", fonts: "dir",
  claudeOfficialDir: "any", claudeApiDir: "any", seriesDir: "any",
};

export function createConfig({ ROOT, JOBS }) {
  const FILE = path.join(JOBS, "config.json");
  let saved = {};
  try { saved = JSON.parse(readFileSync(FILE, "utf8")); } catch {}
  const env = (k) => process.env[`KCLIP_${k.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}`] || "";
  const first = (...xs) => xs.find(Boolean) || "";

  const cfg = {
    get ytdlp() { return first(env("ytdlp"), isFile(saved.ytdlp) && saved.ytdlp, which("yt-dlp")); },
    get ffmpeg() { return which("ffmpeg"); },
    get ffprobe() { return which("ffprobe"); },
    get whisper() { return first(env("whisper"), isFile(saved.whisper) && saved.whisper, which("whisper-cli"), which("whisper-cpp")); },
    get whisperModel() {
      const given = first(env("whisperModel"), isFile(saved.whisperModel) && saved.whisperModel);
      if (given) return given;
      // 没填就在 whisper 程序附近和 models 文件夹里找一个 ggml 模型
      const w = cfg.whisper;
      for (const dir of [w && path.dirname(w), w && path.resolve(path.dirname(w), ".."), w && path.resolve(path.dirname(w), "../.."), path.join(ROOT, "models"), path.join(os.homedir(), ".cache/whisper")].filter(Boolean)) {
        for (const name of ["ggml-large-v3-turbo-q5_0.bin", "ggml-large-v3-turbo.bin", "ggml-large-v3.bin", "ggml-medium.bin"]) if (isFile(path.join(dir, name))) return path.join(dir, name);
      }
      return "";
    },
    get skill() {
      const ok = (d) => isFile(path.join(d, "SKILL.md")) && isDir(path.join(d, "template"));
      return first(...[env("skill"), saved.skill, path.join(ROOT, "vendor/xhs-bilingual-clip"), path.resolve(ROOT, "../xhs-bilingual-clip"), path.join(os.homedir(), ".claude/skills/xhs-bilingual-clip")].filter((d) => d && ok(d)));
    },
    get skillModules() { const d = cfg.skill && path.join(cfg.skill, "template/node_modules"); return isDir(d && path.join(d, "remotion")) ? d : ""; },
    get fonts() {
      const has = (d) => Object.values(FONT_FILES).every((f) => isFile(path.join(d, f)));
      return first(...[env("fonts"), saved.fonts, path.join(ROOT, "fonts"), ...FONT_DIRS].filter((d) => d && has(d)));
    },
    get claude() { return which("claude"); },
    get codex() { return which("codex"); },
    // 官方账号 / 自定义 API 各用一个独立的配置目录，不动 ~/.claude
    get claudeOfficialDir() { return first(env("claudeOfficialDir"), saved.claudeOfficialDir, path.join(os.homedir(), ".kclip/claude-official")); },
    get claudeApiDir() { return first(env("claudeApiDir"), saved.claudeApiDir, path.join(os.homedir(), ".kclip/claude-api")); },
    // 以前做过的系列素材文件夹（可选）：模板出词时避开用过的词
    get seriesDir() { return first(env("seriesDir"), saved.seriesDir); },
  };

  const install = (win, mac, linux) => (WIN ? win : MAC ? mac : linux);
  // 环境检查清单：need 说明缺了它哪个功能用不了
  cfg.checks = () => {
    const node = Number(process.versions.node.split(".")[0]);
    const skill = cfg.skill;
    return [
      { id: "node", label: "Node.js 22+", need: "运行", ok: node >= 22, detail: `v${process.versions.node}`, url: "https://nodejs.org" },
      { id: "ytdlp", label: "yt-dlp", need: "发现、制作", ok: !!cfg.ytdlp, detail: cfg.ytdlp, edit: "ytdlp", cmd: install("winget install yt-dlp.yt-dlp", "brew install yt-dlp", "pipx install yt-dlp"), hint: "找视频、下载视频都靠它" },
      { id: "ai", label: "AI（Claude Code 或 Codex）", need: "AI 精选、制作、模板", ok: !!(cfg.claude || cfg.codex), detail: [cfg.claude && "claude", cfg.codex && "codex"].filter(Boolean).join(" + "), cmd: "npm i -g @anthropic-ai/claude-code", hint: "装好后在终端运行 claude 登录；或者在左下角「…」里添加自己的 API" },
      { id: "ffmpeg", label: "ffmpeg", need: "制作、模板", ok: !!(cfg.ffmpeg && cfg.ffprobe), detail: cfg.ffmpeg, cmd: install("winget install Gyan.FFmpeg", "brew install ffmpeg", "sudo apt install ffmpeg"), hint: "装完要重开终端再启动工作台" },
      { id: "whisper", label: "whisper.cpp（听写）", need: "制作", ok: !!cfg.whisper, detail: cfg.whisper, edit: "whisper", cmd: install("", "brew install whisper-cpp", ""), url: "https://github.com/ggml-org/whisper.cpp/releases", hint: install("下载 Release 里的 whisper-bin-x64.zip 解压，把 whisper-cli.exe 的路径填到这里", "", "按仓库说明编译，把 whisper-cli 的路径填到这里") },
      { id: "whisperModel", label: "听写模型（ggml）", need: "制作", ok: !!cfg.whisperModel, detail: cfg.whisperModel, edit: "whisperModel", url: "https://huggingface.co/ggerganov/whisper.cpp/tree/main", hint: "推荐 ggml-large-v3-turbo-q5_0.bin（约 550MB），下载后把文件路径填到这里" },
      { id: "skill", label: "xhs-bilingual-clip（出片模板）", need: "制作", ok: !!skill, detail: skill, edit: "skill", cmd: "npm run setup", hint: "会把模板仓库下载到 vendor/ 并装好依赖" },
      { id: "skillModules", label: "出片模板的依赖（Remotion）", need: "制作", ok: !!cfg.skillModules, detail: cfg.skillModules, cmd: skill ? `npm i --prefix "${path.join(skill, "template")}"` : "npm run setup", hint: "第一次要下载几百 MB" },
      { id: "fonts", label: "字体 Noto Sans KR / SC（可变字体）", need: "制作、模板", ok: !!cfg.fonts, detail: cfg.fonts, edit: "fonts", url: "https://fonts.google.com/noto/specimen/Noto+Sans+KR", hint: `需要 ${FONT_FILES.kr} 和 ${FONT_FILES.sc} 两个文件。从 Google Fonts 下载后装进系统，或者放进工作台的 fonts 文件夹` },
    ];
  };
  cfg.set = (key, value) => {
    const kind = EDITABLE[key];
    if (!kind) throw new Error("这一项不能改");
    const v = String(value || "").trim().replace(/^"|"$/g, "");
    if (v && kind === "file" && !isFile(v)) throw new Error("找不到这个文件，检查一下路径");
    if (v && kind === "dir" && !isDir(v)) throw new Error("找不到这个文件夹，检查一下路径");
    if (v) saved[key] = v; else delete saved[key];
    writeFileSync(FILE, JSON.stringify(saved, null, 1));
  };
  cfg.platform = process.platform;
  return cfg;
}

// 给 Agent 的一句话：工具都在哪
export const toolLines = (cfg) => [
  `yt-dlp：${cfg.ytdlp || "（没找到，用 PATH 里的 yt-dlp）"}`,
  `ffmpeg / ffprobe：在 PATH 里`,
  `whisper.cpp：${cfg.whisper || "（没找到）"}，模型 ${cfg.whisperModel || "（没找到）"}`,
  `字体文件夹：${cfg.fonts || "（没找到）"}（${Object.values(FONT_FILES).join("、")}）`,
].join("\n  ");

export const isReady = (cfg, ids) => cfg.checks().filter((c) => ids.includes(c.id)).every((c) => c.ok);
