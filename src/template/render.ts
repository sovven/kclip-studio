// 预览和导出共用同一个绘制函数，所见即所得
export type TrackKind = "text" | "media" | "audio";
export type Track = { id: string; name: string; kind: TrackKind; hidden?: boolean; muted?: boolean };
export type Clip = {
  id: string;
  track: string;
  kind: TrackKind;
  start: number;
  dur: number;
  item?: string;
  // 文字
  text?: string;
  x?: number;
  y?: number;
  size?: number;
  color?: string;
  weight?: number;
  label?: boolean;
  maxW?: number;
  anim?: "wipe";
  // 配图
  src?: string;
  mediaType?: "image" | "video";
  w?: number;
  h?: number;
  fit?: "cover" | "contain";
  // 音频（视频也用 offset / srcDur）
  offset?: number;
  srcDur?: number;
  volume?: number;
  name?: string;
  voiceText?: string;
};
export type Project = {
  id: string;
  name: string;
  status: "building" | "ready" | "failed";
  error?: string;
  w: number;
  h: number;
  fps: number;
  bg: string;
  voice?: string;
  tracks: Track[];
  clips: Clip[];
  caption: string;
  items?: { id: string; ko: string; zh: string; en?: string; prompt?: string; promptZh?: string; verified?: boolean; source?: string; alternatives?: string[]; note?: string; koDraft?: string }[];
  cover?: string;
  jobId?: string;
  updatedAt: number;
};

const WIPE = 0.25;
export const projectDuration = (p: Project) => p.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);

let fontsReady: Promise<unknown> | null = null;
export function loadFonts() {
  if (!fontsReady) {
    const kr = new FontFace("KCLIP KR", "url(/api/tpl/font/kr)", { weight: "100 900" });
    const sc = new FontFace("KCLIP SC", "url(/api/tpl/font/sc)", { weight: "100 900" });
    fontsReady = Promise.all([kr.load(), sc.load()]).then((faces) => faces.forEach((f) => document.fonts.add(f)));
  }
  return fontsReady;
}

export class Assets {
  images = new Map<string, HTMLImageElement>();
  videos = new Map<string, HTMLVideoElement>();
  buffers = new Map<string, AudioBuffer>();
  peaks = new Map<string, number[]>();
  private audioCtx?: AudioContext;

  get ctx() {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    return this.audioCtx;
  }
  async load(p: Project, onChange?: () => void) {
    await Promise.all(p.clips.map(async (c) => {
      if (!c.src) return;
      if (c.kind === "media" && c.mediaType === "video") return this.loadVideo(c.src);
      if (c.kind === "media") return this.loadImage(c.src);
      if (c.kind === "audio") return this.loadAudio(c.src);
    }));
    onChange?.();
  }
  loadImage(src: string) {
    if (this.images.has(src)) return Promise.resolve();
    return new Promise<void>((res) => {
      const img = new Image();
      img.onload = () => { this.images.set(src, img); res(); };
      img.onerror = () => res();
      img.src = src;
    });
  }
  loadVideo(src: string) {
    if (this.videos.has(src)) return Promise.resolve();
    return new Promise<void>((res) => {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.onloadeddata = () => { this.videos.set(src, v); res(); };
      v.onerror = () => res();
      v.src = src;
    });
  }
  async loadAudio(src: string) {
    if (this.buffers.has(src)) return;
    try {
      const buf = await this.ctx.decodeAudioData(await (await fetch(src)).arrayBuffer());
      this.buffers.set(src, buf);
      const data = buf.getChannelData(0);
      const step = Math.max(1, Math.floor(buf.sampleRate / 40)); // 每秒 40 个点
      const peaks: number[] = [];
      for (let i = 0; i < data.length; i += step) {
        let m = 0;
        for (let j = i; j < Math.min(i + step, data.length); j += 8) m = Math.max(m, Math.abs(data[j]));
        peaks.push(m);
      }
      this.peaks.set(src, peaks);
    } catch { /* 坏文件不影响其它素材 */ }
  }
}

const family = '"KCLIP KR","KCLIP SC",sans-serif';
const fitSize = (ctx: CanvasRenderingContext2D, c: Clip) => {
  const lines = (c.text || "").split("\n");
  let size = c.size || 80;
  ctx.font = `${c.weight || 500} ${size}px ${family}`;
  if (c.maxW) {
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if (widest > c.maxW) {
      size = (size * c.maxW) / widest;
      ctx.font = `${c.weight || 500} ${size}px ${family}`;
    }
  }
  return { lines, size, lineH: size * (c.label ? 1.28 : 1.2) };
};

export function clipBounds(ctx: CanvasRenderingContext2D, c: Clip) {
  if (c.kind === "media") return { x: c.x || 0, y: c.y || 0, w: c.w || 0, h: c.h || 0 };
  if (c.kind !== "text") return null;
  const { lines, lineH } = fitSize(ctx, c);
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + (c.label ? 56 : 0);
  const h = lineH * lines.length;
  return { x: (c.x || 0) - w / 2, y: (c.y || 0) - h / 2, w, h };
}

function drawText(ctx: CanvasRenderingContext2D, c: Clip, t: number) {
  const { lines, lineH } = fitSize(ctx, c);
  const x = c.x || 0;
  const top = (c.y || 0) - (lineH * lines.length) / 2;
  ctx.save();
  if (c.anim === "wipe") {
    const p = (t - c.start) / WIPE;
    if (p < 1) {
      ctx.beginPath();
      ctx.rect(0, top, ctx.canvas.width * 4, lineH * lines.length * Math.max(0, p));
      ctx.clip();
    }
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (c.label) {
    ctx.fillStyle = "#ffffff";
    lines.forEach((l, i) => {
      const w = ctx.measureText(l).width + 56;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, top + i * lineH, w, lineH, 16);
      ctx.fill();
    });
  }
  ctx.fillStyle = c.color || "#000";
  lines.forEach((l, i) => ctx.fillText(l, x, top + (i + 0.5) * lineH));
  ctx.restore();
}

function drawMedia(ctx: CanvasRenderingContext2D, c: Clip, t: number, assets: Assets) {
  const x = c.x || 0, y = c.y || 0, w = c.w || 0, h = c.h || 0;
  const el = c.mediaType === "video" ? assets.videos.get(c.src || "") : assets.images.get(c.src || "");
  if (!el) {
    ctx.fillStyle = "rgba(0,0,0,.08)";
    ctx.fillRect(x, y, w, h);
    return;
  }
  const iw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
  const ih = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
  if (!iw || !ih) return;
  void t;
  if (c.fit === "contain") {
    const s = Math.min(w / iw, h / ih);
    ctx.drawImage(el, x + (w - iw * s) / 2, y + (h - ih * s) / 2, iw * s, ih * s);
  } else {
    const s = Math.max(w / iw, h / ih);
    const sw = w / s, sh = h / s;
    ctx.drawImage(el, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  }
}

// 轨道列表从上到下 = 图层从上到下，所以倒着画
export function drawFrame(ctx: CanvasRenderingContext2D, p: Project, t: number, assets: Assets, scale: number) {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, p.w, p.h);
  for (const track of [...p.tracks].reverse()) {
    if (track.hidden || track.kind === "audio") continue;
    for (const c of p.clips) {
      if (c.track !== track.id || t < c.start || t >= c.start + c.dur) continue;
      if (c.kind === "text") drawText(ctx, c, t);
      else if (c.kind === "media") drawMedia(ctx, c, t, assets);
    }
  }
}

// 画面没变化的帧只传一次，导出快很多
export function frameKey(p: Project, t: number, fps: number) {
  const hidden = new Set(p.tracks.filter((x) => x.hidden).map((x) => x.id));
  return p.clips.filter((c) => c.kind !== "audio" && !hidden.has(c.track) && t >= c.start && t < c.start + c.dur).map((c) => {
    if (c.mediaType === "video") return `${c.id}:${Math.round(t * fps)}`;
    if (c.anim === "wipe" && t - c.start < WIPE) return `${c.id}:${Math.round(t * fps)}`;
    return c.id;
  }).join("|");
}

export function seekVideos(p: Project, t: number, assets: Assets) {
  const jobs: Promise<void>[] = [];
  for (const c of p.clips) {
    if (c.mediaType !== "video" || !c.src || t < c.start || t >= c.start + c.dur) continue;
    const v = assets.videos.get(c.src);
    if (!v) continue;
    const target = t - c.start + (c.offset || 0);
    if (Math.abs(v.currentTime - target) < 1 / 120) continue;
    jobs.push(new Promise((res) => {
      v.onseeked = () => res();
      v.currentTime = target;
    }));
  }
  return Promise.all(jobs);
}
