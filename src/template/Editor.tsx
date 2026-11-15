import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, ArrowLeft, BadgeCheck, Check, Copy, Download, ExternalLink, FolderOpen, ImagePlus, Loader2, Music, Pause, Play, Redo2, RefreshCw, Scissors, Search, Trash2, Type, Undo2, Upload, ZoomIn, ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useStudio } from "@/store";
import { Assets, clipBounds, drawFrame, frameKey, loadFonts, projectDuration, seekVideos, type Clip, type Project } from "./render";
import { Timeline } from "./Timeline";

const BG_PRESETS = ["#BBD0C9", "#F4EFE6", "#F2D9D5", "#CFDDEA", "#E7E2F2", "#FFFFFF", "#1F2421"];
const fmt = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}.${String(Math.floor((t % 1) * 10))}`;
const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const json = (data: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const toBlob = (cv: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error("画面生成失败"))), type, q));

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">{label}{children}</label>;
}
function NumberField({ label, value, step = 1, min, max, onChange }: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void }) {
  return (
    <Field label={label}>
      <Input type="number" className="h-8 text-sm text-foreground" value={Number.isFinite(value) ? Number(value.toFixed(2)) : 0} step={step} min={min} max={max} onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange(v); }} />
    </Field>
  );
}

export function Editor({ initial, autoExport, onBack }: { initial: Project; autoExport?: boolean; onBack: () => void }) {
  const { pollJobs, setPage } = useStudio();
  const [project, setProject] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(36);
  const [assetsTick, setAssetsTick] = useState(0);
  const [saved, setSaved] = useState(true);
  const [exporting, setExporting] = useState<null | { pct: number; label: string }>(null);
  const [result, setResult] = useState<null | { video: string; folder: string }>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [photos, setPhotos] = useState<null | { title: string; url: string; license: string }[]>(null);
  const [photoQuery, setPhotoQuery] = useState("");

  const assets = useRef(new Assets()).current;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const timeRef = useRef(0);
  timeRef.current = time;
  const history = useRef<{ past: Project[]; future: Project[]; last: Project }>({ past: [], future: [], last: initial });
  const sources = useRef<AudioBufferSourceNode[]>([]);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadMode = useRef<"media" | "audio" | "replace">("media");
  const autoStarted = useRef(false);

  const duration = useMemo(() => projectDuration(project), [project]);
  const selected = project.clips.find((c) => c.id === selectedId) || null;

  const commit = useCallback(() => {
    const h = history.current;
    if (h.last === projectRef.current) return;
    h.past.push(h.last);
    if (h.past.length > 100) h.past.shift();
    h.future = [];
    h.last = projectRef.current;
  }, []);
  const change = useCallback((fn: (p: Project) => Project, shouldCommit = true) => {
    const next = fn(projectRef.current);
    projectRef.current = next;
    setProject(next);
    setSaved(false);
    if (shouldCommit) commit();
  }, [commit]);
  const undo = () => {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(h.last);
    h.last = prev;
    projectRef.current = prev;
    setProject(prev);
    setSaved(false);
  };
  const redo = () => {
    const h = history.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(h.last);
    h.last = next;
    projectRef.current = next;
    setProject(next);
    setSaved(false);
  };
  const patchClip = (id: string, patch: Partial<Clip>, shouldCommit = true) => change((p) => ({ ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }), shouldCommit);

  // 自动保存
  const saveNow = useCallback(async () => {
    const p = projectRef.current;
    await api(`/api/tpl/projects/${p.id}`, { ...json({ name: p.name, bg: p.bg, caption: p.caption, tracks: p.tracks, clips: p.clips, cover: p.clips.find((c) => c.kind === "media" && c.mediaType === "image" && c.src)?.src }), method: "PUT" });
    setSaved(true);
  }, []);
  useEffect(() => {
    if (saved) return;
    const t = setTimeout(() => saveNow().catch((e) => toast.error(`保存失败：${e.message}`)), 700);
    return () => clearTimeout(t);
  }, [project, saved, saveNow]);

  // 画预览
  const paint = useCallback((t: number) => {
    const cv = canvasRef.current;
    if (!cv) return;
    drawFrame(cv.getContext("2d")!, projectRef.current, t, assets, cv.width / projectRef.current.w);
  }, [assets]);
  useEffect(() => { Promise.all([loadFonts(), assets.load(project)]).then(() => { setAssetsTick((n) => n + 1); }); }, [assets, project]);
  useEffect(() => {
    if (playing) return;
    seekVideos(project, time, assets).then(() => paint(time));
  }, [project, time, playing, assetsTick, paint, assets]);

  // 播放
  const stopAudio = () => { sources.current.forEach((s) => { try { s.stop(); } catch { /* 已经停了 */ } }); sources.current = []; };
  useEffect(() => {
    if (!playing) return;
    const p = projectRef.current;
    const ctx = assets.ctx;
    ctx.resume();
    const base = timeRef.current >= duration - 0.02 ? 0 : timeRef.current;
    const t0 = ctx.currentTime + 0.05;
    const muted = new Set(p.tracks.filter((x) => x.muted).map((x) => x.id));
    for (const c of p.clips) {
      if (c.kind !== "audio" || !c.src || muted.has(c.track) || c.start + c.dur <= base) continue;
      const buf = assets.buffers.get(c.src);
      if (!buf) continue;
      const s = ctx.createBufferSource();
      const g = ctx.createGain();
      g.gain.value = c.volume ?? 1;
      s.buffer = buf;
      s.connect(g).connect(ctx.destination);
      const skip = Math.max(0, base - c.start);
      s.start(t0 + Math.max(0, c.start - base), (c.offset || 0) + skip, c.dur - skip);
      sources.current.push(s);
    }
    const vids = p.clips.filter((c) => c.mediaType === "video");
    let raf = 0;
    const tick = () => {
      const t = base + Math.max(0, ctx.currentTime - t0);
      if (t >= duration) { setTime(duration); setPlaying(false); return; }
      for (const c of vids) {
        const v = assets.videos.get(c.src || "");
        if (!v) continue;
        const active = t >= c.start && t < c.start + c.dur;
        if (active) {
          const target = t - c.start + (c.offset || 0);
          if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
          if (v.paused) v.play().catch(() => {});
        } else if (!v.paused) v.pause();
      }
      setTime(t);
      paint(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); stopAudio(); vids.forEach((c) => assets.videos.get(c.src || "")?.pause()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // 片段操作
  const splitAtPlayhead = () => {
    const t = time;
    const target = selected && t > selected.start && t < selected.start + selected.dur ? selected : null;
    if (!target) { toast("先选中播放头所在的片段"); return; }
    const first = t - target.start;
    const second: Clip = { ...target, id: newId(), start: t, dur: target.dur - first, ...(target.srcDur != null ? { offset: (target.offset || 0) + first } : {}) };
    change((p) => ({ ...p, clips: [...p.clips.map((c) => (c.id === target.id ? { ...c, dur: first } : c)), second] }));
    setSelectedId(second.id);
  };
  const removeSelected = () => {
    if (!selected) return;
    change((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== selected.id) }));
    setSelectedId(null);
  };
  const duplicateSelected = () => {
    if (!selected) return;
    const copy: Clip = { ...selected, id: newId(), start: selected.start + selected.dur };
    change((p) => ({ ...p, clips: [...p.clips, copy] }));
    setSelectedId(copy.id);
  };
  const addText = () => {
    change((p) => {
      const has = p.tracks.some((x) => x.id === "extra");
      const c: Clip = { id: newId(), track: "extra", kind: "text", start: time, dur: Math.min(3, Math.max(1, duration - time)), text: "新文字", x: 540, y: 960, size: 80, weight: 500, color: "#1E3D2C", maxW: 1000 };
      setSelectedId(c.id);
      return { ...p, tracks: has ? p.tracks : [{ id: "extra", name: "文字", kind: "text" }, ...p.tracks], clips: [...p.clips, c] };
    });
  };
  const pickFile = (mode: "media" | "audio" | "replace", accept: string) => {
    uploadMode.current = mode;
    if (uploadRef.current) { uploadRef.current.accept = accept; uploadRef.current.value = ""; uploadRef.current.click(); }
  };
  const onFile = async (file: File) => {
    setBusy("upload");
    try {
      const r = await api<{ src: string; mediaType: "image" | "video" | "audio"; dur: number; name: string }>(`/api/tpl/projects/${project.id}/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      const mode = uploadMode.current;
      if (mode === "replace" && selected) {
        if (selected.kind === "audio" && r.mediaType === "audio") patchClip(selected.id, { src: r.src, srcDur: r.dur, dur: Math.min(selected.dur, r.dur) || r.dur, offset: 0, name: r.name, voiceText: undefined });
        else if (selected.kind === "media" && r.mediaType !== "audio") patchClip(selected.id, { src: r.src, mediaType: r.mediaType as "image" | "video", ...(r.mediaType === "video" ? { srcDur: r.dur, offset: 0, dur: Math.min(selected.dur, r.dur) } : { srcDur: undefined, offset: undefined }) });
        else toast.error("文件类型和这个片段不一致");
      } else if (r.mediaType === "audio") {
        const c: Clip = { id: newId(), track: mode === "audio" ? "bgm" : "bgm", kind: "audio", start: 0, dur: Math.min(r.dur, duration || r.dur), src: r.src, srcDur: r.dur, offset: 0, volume: 0.3, name: r.name };
        change((p) => ({ ...p, clips: [...p.clips, c] }));
        setSelectedId(c.id);
      } else {
        const c: Clip = { id: newId(), track: "media", kind: "media", start: time, dur: r.mediaType === "video" ? r.dur : 3, src: r.src, mediaType: r.mediaType, x: 155, y: 668, w: 770, h: 585, fit: "cover", ...(r.mediaType === "video" ? { srcDur: r.dur, offset: 0 } : {}) };
        change((p) => ({ ...p, clips: [...p.clips, c] }));
        setSelectedId(c.id);
      }
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  };
  const itemWords = (c: Clip) => {
    const ko = project.clips.find((x) => x.item === c.item && x.track === "ko")?.text;
    const zh = project.clips.find((x) => x.item === c.item && x.track === "zh")?.text;
    return { ko, zh };
  };
  const regenImage = async () => {
    if (!selected) return;
    const { zh, ko } = itemWords(selected);
    setBusy("image");
    try {
      const it = project.items?.find((x) => x.id === selected.item);
      const r = await api<{ src: string }>(`/api/tpl/projects/${project.id}/image`, json({ en: it?.en, prompt: it?.prompt, zh: zh || ko || "object" }));
      patchClip(selected.id, { src: r.src, mediaType: "image", srcDur: undefined, offset: undefined });
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  };
  const searchPhotos = async (q: string) => {
    setBusy("search");
    try { setPhotos(await api(`/api/tpl/search?q=${encodeURIComponent(q)}`)); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  };
  const usePhoto = async (url: string) => {
    if (!selected) return;
    setBusy("image");
    try {
      const r = await api<{ src: string }>(`/api/tpl/projects/${project.id}/image`, json({ url }));
      patchClip(selected.id, { src: r.src, mediaType: "image", srcDur: undefined, offset: undefined });
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  };
  const revoice = async (clip: Clip, text: string) => {
    setBusy("voice");
    try {
      const r = await api<{ src: string; dur: number }>(`/api/tpl/projects/${project.id}/tts`, json({ text, voice: project.voice }));
      patchClip(clip.id, { src: r.src, srcDur: r.dur, dur: r.dur, offset: 0, name: text, voiceText: text });
      toast.success("配音已更新");
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  };
  // 配图面板：每个词一行；一次拖多张时按文件名对应单词，对不上的按顺序补空位
  const words = useMemo(() => project.clips.filter((c) => c.track === "media" && c.item).sort((x, y) => x.start - y.start).map((c) => {
    const w = project.clips.filter((x) => x.item === c.item);
    return { clip: c, ko: w.find((x) => x.track === "ko")?.text || "", zh: w.find((x) => x.track === "zh")?.text || "", prompt: project.items?.find((x) => x.id === c.item)?.promptZh || "", info: project.items?.find((x) => x.id === c.item) };
  }), [project]);
  const missingImages = words.filter((w) => !w.clip.src).length;
  const copyPrompts = (text: string) => { navigator.clipboard.writeText(text).then(() => toast.success("提示词已复制")).catch(() => toast.error("复制失败，可以手动选中文字复制")); };
  const dropImages = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    setBusy("drop");
    try {
      const rest = [...words];
      const pairs: { file: File; clip: Clip }[] = [];
      const unmatched: File[] = [];
      for (const file of images) {
        const i = rest.findIndex((w) => (w.zh && file.name.includes(w.zh)) || (w.ko && file.name.includes(w.ko)));
        if (i >= 0) pairs.push({ file, clip: rest.splice(i, 1)[0].clip });
        else unmatched.push(file);
      }
      const empties = rest.filter((w) => !w.clip.src);
      unmatched.forEach((file, i) => { const w = empties[i]; if (w) pairs.push({ file, clip: w.clip }); });
      const done = await Promise.all(pairs.map(async ({ file, clip }) => {
        const r = await api<{ src: string }>(`/api/tpl/projects/${project.id}/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
        return { id: clip.id, src: r.src };
      }));
      change((p) => ({ ...p, clips: p.clips.map((c) => { const d = done.find((x) => x.id === c.id); return d ? { ...c, src: d.src, mediaType: "image" as const } : c; }) }));
      toast.success(`已放好 ${done.length} 张图`);
    } catch (err) { toast.error((err as Error).message); }
    finally { setBusy(null); }
  };
  const linkedVoice = selected?.item && selected.track === "ko" ? project.clips.find((c) => c.kind === "audio" && c.item === selected.item) : null;

  // 导出：逐帧画好传给后端，相同画面只传一次
  const runExport = useCallback(async (scale: number) => {
    const blank = projectRef.current.clips.filter((c) => c.track === "media" && !c.src).length;
    if (blank) { toast.warning(`还有 ${blank} 张图没配好，先补上再导出`); return; }
    setPlaying(false);
    setResult(null);
    setExporting({ pct: 0, label: "准备中" });
    try {
      await saveNow();
      const p = projectRef.current;
      await Promise.all([loadFonts(), assets.load(p)]);
      const cv = document.createElement("canvas");
      cv.width = p.w * scale;
      cv.height = p.h * scale;
      const ctx = cv.getContext("2d")!;
      const total = Math.ceil(projectDuration(p) * p.fps);
      await api(`/api/tpl/projects/${p.id}/export/start`, json({ fps: p.fps }));
      let pending: Blob | null = null, repeat = 0, lastKey: string | null = null;
      const flush = async () => {
        if (pending) await api(`/api/tpl/projects/${p.id}/export/frame?repeat=${repeat}`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: pending });
      };
      for (let f = 0; f < total; f++) {
        const t = f / p.fps;
        const key = frameKey(p, t, p.fps);
        if (key === lastKey) { repeat++; continue; }
        await flush();
        await seekVideos(p, t, assets);
        drawFrame(ctx, p, t, assets, scale);
        pending = await toBlob(cv, "image/jpeg", 0.98);
        repeat = 1;
        lastKey = key;
        setExporting({ pct: Math.round((f / total) * 85), label: "渲染画面" });
      }
      await flush();
      // 3:4 封面：取第一题倒计时开始前的画面，不露数字和答案；从顶部裁到配图下方，上下留白基本相等
      const firstCount = p.clips.filter((c) => c.track === "count").sort((a, b) => a.start - b.start)[0];
      const coverT = firstCount ? Math.max(0, firstCount.start - 0.2) : 0;
      await seekVideos(p, coverT, assets);
      drawFrame(ctx, p, coverT, assets, scale);
      const coverCv = document.createElement("canvas");
      coverCv.width = cv.width;
      coverCv.height = Math.round((cv.width * 4) / 3);
      coverCv.getContext("2d")!.drawImage(cv, 0, 0);
      await api(`/api/tpl/projects/${p.id}/export/cover`, { method: "POST", body: await toBlob(coverCv, "image/jpeg", 0.95) });
      setExporting({ pct: 92, label: "合成音频和视频" });
      const r = await api<{ video: string; folder: string }>(`/api/tpl/projects/${p.id}/export/finish`, { method: "POST" });
      setResult(r);
      pollJobs();
      toast.success("导出完成，已放进作品库");
    } catch (e) { toast.error(`导出失败：${(e as Error).message}`); }
    finally { setExporting(null); }
  }, [assets, pollJobs, saveNow]);

  useEffect(() => {
    if (autoExport && !autoStarted.current) { autoStarted.current = true; runExport(2); }
  }, [autoExport, runExport]);

  // 快捷键
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea,select")) return;
      if (e.code === "Space") { e.preventDefault(); setPlaying((x) => !x); }
      else if ((e.key === "Delete" || e.key === "Backspace") && selected) removeSelected();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); splitAtPlayhead(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  // 在画面上点选、拖动
  const onCanvasDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current!;
    const rect = cv.getBoundingClientRect();
    const k = project.w / rect.width;
    const mx = (e.clientX - rect.left) * k, my = (e.clientY - rect.top) * k;
    const ctx = cv.getContext("2d")!;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let hit: Clip | null = null;
    for (const tr of project.tracks) {
      if (tr.hidden || tr.kind === "audio") continue;
      for (const c of project.clips) {
        if (c.track !== tr.id || time < c.start || time >= c.start + c.dur) continue;
        const b = clipBounds(ctx, c);
        if (b && mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) { hit = c; break; }
      }
      if (hit) break;
    }
    ctx.restore();
    setSelectedId(hit?.id || null);
    if (!hit) return;
    const orig = hit;
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      patchClip(orig.id, { x: Math.round((orig.x || 0) + (ev.clientX - e.clientX) * k), y: Math.round((orig.y || 0) + (ev.clientY - e.clientY) * k) }, false);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) commit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toolBtn = "grid size-8 place-items-center rounded-lg text-foreground/80 transition-colors hover:bg-secondary disabled:opacity-35 [&_svg]:size-4";
  const t = selected;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background text-foreground">
      <input ref={uploadRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
      {/* 顶栏 */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <button aria-label="返回" onClick={() => saveNow().finally(onBack)} className={toolBtn}><ArrowLeft /></button>
        <input aria-label="项目名称" className="h-8 w-52 min-w-0 rounded-lg bg-transparent px-2 text-sm font-semibold outline-none hover:bg-secondary focus:bg-secondary" value={project.name} onChange={(e) => change((p) => ({ ...p, name: e.target.value }), false)} onBlur={commit} />
        <span className="hidden text-xs text-muted-foreground sm:inline">{saved ? "已保存" : "保存中…"}</span>
        <div className="ml-auto flex items-center gap-1">
          <button aria-label="撤销" onClick={undo} className={toolBtn}><Undo2 /></button>
          <button aria-label="重做" onClick={redo} className={toolBtn}><Redo2 /></button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="ml-2 rounded-full" disabled={!!exporting}><Download />导出</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => runExport(2)}>4K 竖屏（2160×3840，和系列一样）</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => runExport(1)}>1080P 竖屏（更快）</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* 预览 + 属性 */}
      <div className="flex min-h-0 flex-[1.2]">
        <div className="relative flex min-w-0 flex-1 flex-col items-center justify-center gap-2 bg-secondary/50 p-3">
          <canvas ref={canvasRef} width={540} height={960} onPointerDown={onCanvasDown} className="min-h-0 max-w-full flex-1 cursor-pointer rounded-md shadow-card" style={{ aspectRatio: "9 / 16", objectFit: "contain" }} />
        </div>
        <aside className="w-72 shrink-0 overflow-y-auto border-l border-border bg-card p-4 text-sm">
          {!t && (
            <div className="space-y-4">
              {words.length > 0 && (
                <div className="space-y-2" onDragOver={(ev) => ev.preventDefault()} onDrop={(ev) => { ev.preventDefault(); dropImages([...ev.dataTransfer.files]); }}>
                  <div className="flex items-center gap-1.5">
                    <h3 className="font-semibold">配图</h3>
                    {busy === "drop" && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                    {missingImages > 0 && <span className="ml-auto flex items-center gap-1 text-xs text-[var(--warning)]"><AlertCircle className="size-3.5" />缺 {missingImages} 张</span>}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button variant="outline" size="sm" className="rounded-full" onClick={() => copyPrompts(words.map((w) => `${w.zh}：${w.prompt}`).join("\n"))}><Copy />复制提示词</Button>
                    <Button variant="outline" size="sm" className="rounded-full" asChild><a href="https://jimeng.jianying.com/ai-tool/generate" target="_blank" rel="noreferrer"><ExternalLink />打开即梦</a></Button>
                  </div>
                  <ul className="space-y-1">
                    {words.map((w) => (
                      <li key={w.clip.id} className="flex items-center gap-2 rounded-lg p-1 hover:bg-secondary">
                        <button aria-label={`选中${w.zh}的配图`} onClick={() => { setSelectedId(w.clip.id); setTime(w.clip.start); }} className="grid h-9 w-12 shrink-0 place-items-center overflow-hidden rounded bg-secondary text-muted-foreground">
                          {w.clip.src ? <img src={w.clip.src} alt={w.zh} className="size-full object-cover" /> : <ImagePlus className="size-4" />}
                        </button>
                        <span className="min-w-0 flex-1 truncate text-xs"><b className="font-medium">{w.ko}</b> <span className="text-muted-foreground">{w.zh}</span></span>
                        {w.info?.verified ? (
                          <a href={w.info.source} target="_blank" rel="noreferrer" aria-label={`${w.ko} 的韩网依据`} title={[w.info.note, w.info.alternatives?.length ? `也有人说：${w.info.alternatives.join("、")}` : ""].filter(Boolean).join("\n")} className="grid size-6 shrink-0 place-items-center rounded text-[var(--success)] [&_svg]:size-3.5"><BadgeCheck /></a>
                        ) : (
                          <span role="img" aria-label="没有查到韩网依据" title={w.info?.note || "没有查到韩网依据，请自己确认"} className="grid size-6 shrink-0 place-items-center text-[var(--warning)] [&_svg]:size-3.5"><AlertCircle /></span>
                        )}
                        <button aria-label={`复制${w.zh}的提示词`} title="复制这个词的提示词" onClick={() => copyPrompts(w.prompt)} className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground [&_svg]:size-3.5"><Copy /></button>
                      </li>
                    ))}
                  </ul>
                  <label className="block cursor-pointer rounded-xl border border-dashed border-border p-3 text-center text-xs text-muted-foreground hover:bg-secondary">
                    把图片拖到这里，或点击选择
                    <span className="block">文件名带单词会自动对应（如 插头.png）</span>
                    <input type="file" multiple accept="image/*" className="hidden" onChange={(ev) => { dropImages([...(ev.target.files || [])]); ev.target.value = ""; }} />
                  </label>
                </div>
              )}
              <h3 className="font-semibold">视频设置</h3>
              <Field label="背景颜色">
                <div className="flex flex-wrap items-center gap-1.5">
                  {BG_PRESETS.map((c) => (
                    <button key={c} aria-label={`背景 ${c}`} onClick={() => change((p) => ({ ...p, bg: c }))} className="grid size-7 place-items-center rounded-full border border-border" style={{ background: c }}>
                      {project.bg.toLowerCase() === c.toLowerCase() && <Check className="size-3.5" style={{ color: c === "#1F2421" ? "#fff" : "#1E3D2C" }} />}
                    </button>
                  ))}
                  <input aria-label="自定义背景色" type="color" className="size-7 cursor-pointer rounded-full bg-transparent" value={project.bg} onChange={(e) => change((p) => ({ ...p, bg: e.target.value }), false)} onBlur={commit} />
                </div>
              </Field>
              <Field label="小红书文案">
                <Textarea rows={8} className="text-sm text-foreground" value={project.caption} onChange={(e) => change((p) => ({ ...p, caption: e.target.value }), false)} onBlur={commit} />
              </Field>
              <Button variant="outline" size="sm" className="w-full rounded-full" onClick={() => { navigator.clipboard.writeText(project.caption); toast.success("文案已复制"); }}><Copy />复制文案</Button>
              <p className="text-xs leading-relaxed text-muted-foreground">点画面或轨道上的片段，可以改文字、换图、换配音。</p>
            </div>
          )}
          {t?.kind === "text" && (
            <div className="space-y-3">
              <h3 className="font-semibold">文字</h3>
              <Field label="内容"><Textarea rows={t.label ? 2 : 2} className="text-sm text-foreground" value={t.text} onChange={(e) => patchClip(t.id, { text: e.target.value }, false)} onBlur={commit} /></Field>
              {linkedVoice && <Button variant="outline" size="sm" className="w-full rounded-full" disabled={busy === "voice" || linkedVoice.voiceText === t.text} onClick={() => revoice(linkedVoice, t.text || "")}>{busy === "voice" ? <Loader2 className="animate-spin" /> : <RefreshCw />}按新文字重新配音</Button>}
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="字号" value={t.size || 80} min={12} onChange={(v) => patchClip(t.id, { size: v }, false)} />
                <NumberField label="粗细" value={t.weight || 500} step={100} min={100} max={900} onChange={(v) => patchClip(t.id, { weight: v }, false)} />
                <NumberField label="水平位置" value={t.x || 0} onChange={(v) => patchClip(t.id, { x: v }, false)} />
                <NumberField label="垂直位置" value={t.y || 0} onChange={(v) => patchClip(t.id, { y: v }, false)} />
              </div>
              <Field label="文字颜色"><input type="color" aria-label="文字颜色" className="h-8 w-full cursor-pointer rounded-lg bg-transparent" value={t.color || "#000000"} onChange={(e) => patchClip(t.id, { color: e.target.value }, false)} onBlur={commit} /></Field>
              <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><input type="checkbox" checked={!!t.label} onChange={(e) => patchClip(t.id, { label: e.target.checked })} />白色底条</label>
            </div>
          )}
          {t?.kind === "media" && (
            <div className="space-y-3">
              <h3 className="font-semibold">配图</h3>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" size="sm" className="rounded-full" disabled={busy === "image"} onClick={regenImage}>{busy === "image" ? <Loader2 className="animate-spin" /> : <RefreshCw />}重新生成</Button>
                <Button variant="outline" size="sm" className="rounded-full" onClick={() => pickFile("replace", "image/*,video/*")}><Upload />换成我的</Button>
              </div>
              <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (photoQuery.trim()) searchPhotos(photoQuery.trim()); }}>
                <Input className="h-8 text-sm" placeholder="搜免费实拍图（英文更准）" value={photoQuery} onChange={(e) => setPhotoQuery(e.target.value)} />
                <button aria-label="搜索图片" className={toolBtn} disabled={busy === "search"}>{busy === "search" ? <Loader2 className="animate-spin" /> : <Search />}</button>
              </form>
              {photos && (photos.length ? (
                <div className="grid grid-cols-2 gap-1.5">
                  {photos.map((ph) => <button key={ph.url} title={`${ph.title}（${ph.license}）`} onClick={() => usePhoto(ph.url)} className="aspect-[4/3] overflow-hidden rounded-md bg-secondary"><img src={ph.url} alt={ph.title} loading="lazy" className="size-full object-cover" /></button>)}
                </div>
              ) : <p className="text-xs text-muted-foreground">没有搜到可免费使用的图，换个词试试。</p>)}
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="水平位置" value={t.x || 0} onChange={(v) => patchClip(t.id, { x: v }, false)} />
                <NumberField label="垂直位置" value={t.y || 0} onChange={(v) => patchClip(t.id, { y: v }, false)} />
                <NumberField label="宽度" value={t.w || 0} min={10} onChange={(v) => patchClip(t.id, { w: v }, false)} />
                <NumberField label="高度" value={t.h || 0} min={10} onChange={(v) => patchClip(t.id, { h: v }, false)} />
              </div>
            </div>
          )}
          {t?.kind === "audio" && (
            <div className="space-y-3">
              <h3 className="font-semibold">音频</h3>
              <Field label={`音量 ${Math.round((t.volume ?? 1) * 100)}%`}><input aria-label="音量" type="range" min={0} max={2} step={0.05} value={t.volume ?? 1} onChange={(e) => patchClip(t.id, { volume: parseFloat(e.target.value) }, false)} onPointerUp={commit} /></Field>
              {t.voiceText != null && (
                <>
                  <Field label="配音文字"><Input className="h-8 text-sm text-foreground" value={t.voiceText} onChange={(e) => patchClip(t.id, { voiceText: e.target.value }, false)} onBlur={commit} /></Field>
                  <Button variant="outline" size="sm" className="w-full rounded-full" disabled={busy === "voice"} onClick={() => revoice(t, t.voiceText || "")}>{busy === "voice" ? <Loader2 className="animate-spin" /> : <RefreshCw />}重新配音</Button>
                </>
              )}
              <Button variant="outline" size="sm" className="w-full rounded-full" onClick={() => pickFile("replace", "audio/*")}><Upload />换成我的音频</Button>
            </div>
          )}
          {t && (
            <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-4">
              <NumberField label="开始（秒）" value={t.start} step={0.1} min={0} onChange={(v) => patchClip(t.id, { start: Math.max(0, v) }, false)} />
              <NumberField label="时长（秒）" value={t.dur} step={0.1} min={0.1} onChange={(v) => patchClip(t.id, { dur: Math.max(0.1, v) }, false)} />
            </div>
          )}
        </aside>
      </div>

      {/* 工具条 */}
      <div className="flex h-11 shrink-0 items-center gap-0.5 border-y border-border bg-card px-2">
        <button aria-label={playing ? "暂停" : "播放"} onClick={() => setPlaying((x) => !x)} className={toolBtn}>{playing ? <Pause /> : <Play />}</button>
        <span className="mr-2 text-xs tabular-nums text-muted-foreground">{fmt(time)} / {fmt(duration)}</span>
        <button aria-label="分割" title="分割（Ctrl+B）" onClick={splitAtPlayhead} className={toolBtn}><Scissors /></button>
        <button aria-label="复制片段" title="复制片段" disabled={!selected} onClick={duplicateSelected} className={toolBtn}><Copy /></button>
        <button aria-label="删除片段" title="删除（Delete）" disabled={!selected} onClick={removeSelected} className={toolBtn}><Trash2 /></button>
        <span className="mx-1 h-5 w-px bg-border" />
        <button aria-label="添加文字" title="添加文字" onClick={addText} className={toolBtn}><Type /></button>
        <button aria-label="添加图片或视频" title="添加图片或视频" onClick={() => pickFile("media", "image/*,video/*")} className={toolBtn}><ImagePlus /></button>
        <button aria-label="添加音乐" title="添加音乐" onClick={() => pickFile("audio", "audio/*")} className={toolBtn}><Music /></button>
        {busy === "upload" && <Loader2 className="ml-1 size-4 animate-spin text-muted-foreground" />}
        <div className="ml-auto flex items-center gap-0.5">
          <button aria-label="缩小时间轴" onClick={() => setZoom((z) => Math.max(8, z / 1.3))} className={toolBtn}><ZoomOut /></button>
          <button aria-label="放大时间轴" onClick={() => setZoom((z) => Math.min(240, z * 1.3))} className={toolBtn}><ZoomIn /></button>
        </div>
      </div>

      {/* 轨道 */}
      <div className="flex min-h-[220px] flex-1 flex-col">
        <Timeline project={project} assets={assets} assetsTick={assetsTick} time={time} zoom={zoom} selectedId={selectedId} duration={duration} onSelect={setSelectedId} onSeek={(x) => { setPlaying(false); setTime(Math.min(x, duration)); }} onChange={change} onCommit={commit} />
      </div>

      {/* 导出进度 / 结果 */}
      {(exporting || result) && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-3xl bg-card p-6 shadow-card">
            {exporting ? (
              <>
                <h3 className="font-semibold">正在导出</h3>
                <p className="mt-1 text-sm text-muted-foreground">{exporting.label}，请保持这个页面打开。</p>
                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${exporting.pct}%` }} /></div>
              </>
            ) : result && (
              <>
                <h3 className="font-semibold">导出完成</h3>
                <video src={result.video} controls className="mx-auto mt-3 max-h-80 rounded-xl bg-black" />
                <p className="mt-3 break-all text-xs text-muted-foreground"><FolderOpen className="mr-1 inline size-3.5" />{result.folder}</p>
                <div className="mt-4 flex gap-2">
                  <Button variant="outline" className="flex-1 rounded-full" onClick={() => setResult(null)}>继续修改</Button>
                  <Button className="flex-1 rounded-full" onClick={() => { setResult(null); saveNow().finally(() => { onBack(); setPage("library"); }); }}>去作品库</Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
