import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Image as ImageIcon, Music, Type, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Assets, Clip, Project, Track } from "./render";

const ROW_H: Record<Track["kind"], number> = { text: 30, media: 52, audio: 40 };
const HEAD_W = 104;
const MIN_DUR = 0.1;

const CLIP_STYLE: Record<Track["kind"], string> = {
  text: "bg-[#c8604a] text-white",
  media: "bg-[#3d4a5c] text-white",
  audio: "bg-[#2f6f9f] text-white",
};

function Wave({ peaks, offset, dur, width, height }: { peaks?: number[]; offset: number; dur: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !peaks) return;
    const w = Math.max(1, Math.round(width));
    cv.width = w;
    cv.height = height;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = "rgba(255,255,255,.55)";
    for (let x = 0; x < w; x += 2) {
      const i = Math.floor(((offset + (x / w) * dur)) * 40);
      const v = peaks[i] ?? 0;
      const h = Math.max(1, Math.min(1, v * 1.6) * height);
      ctx.fillRect(x, height - h, 1, h);
    }
  }, [peaks, offset, dur, width, height]);
  return <canvas ref={ref} className="pointer-events-none absolute inset-x-0 bottom-0" style={{ width, height }} />;
}

type Props = {
  project: Project;
  assets: Assets;
  assetsTick: number;
  time: number;
  zoom: number;
  selectedId: string | null;
  duration: number;
  onSelect: (id: string | null) => void;
  onSeek: (t: number) => void;
  onChange: (fn: (p: Project) => Project, commit?: boolean) => void;
  onCommit: () => void;
};

export function Timeline({ project, assets, assetsTick, time, zoom, selectedId, duration, onSelect, onSeek, onChange, onCommit }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<null | { id: string; mode: "move" | "l" | "r"; startX: number; orig: Clip; moved: boolean }>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  void assetsTick;

  const span = Math.max(duration + 8, (scrollRef.current?.clientWidth || 800) / zoom);
  const width = span * zoom;
  const ticks = useMemo(() => {
    const step = zoom >= 60 ? 1 : zoom >= 24 ? 2 : zoom >= 12 ? 5 : 10;
    const out: number[] = [];
    for (let s = 0; s <= span; s += step) out.push(s);
    return out;
  }, [zoom, span]);

  // 贴靠：其它片段的首尾和播放头
  const snap = (value: number, self: string) => {
    let best = value, dist = 7 / zoom;
    const pts = [0, time];
    for (const c of project.clips) if (c.id !== self) pts.push(c.start, c.start + c.dur);
    for (const pt of pts) if (Math.abs(pt - value) < dist) { dist = Math.abs(pt - value); best = pt; }
    return best;
  };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const dt = (e.clientX - drag.startX) / zoom;
      const o = drag.orig;
      let next: Partial<Clip> = {};
      let snapped: number | null = null;
      const maxSrc = o.srcDur ? o.srcDur : Infinity;
      if (drag.mode === "move") {
        let start = Math.max(0, o.start + dt);
        const s1 = snap(start, o.id), s2 = snap(start + o.dur, o.id) - o.dur;
        if (s1 !== start) { start = s1; snapped = s1; }
        else if (s2 !== start) { start = s2; snapped = s2 + o.dur; }
        next = { start };
        // 拖到同类型的其它轨道
        const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-track]");
        if (under && under.dataset.kind === o.kind) next.track = under.dataset.track;
      } else if (drag.mode === "l") {
        let start = Math.max(0, o.start + dt);
        const sn = snap(start, o.id);
        if (sn !== start) { start = sn; snapped = sn; }
        start = Math.min(start, o.start + o.dur - MIN_DUR);
        let delta = start - o.start;
        if (o.srcDur != null) { delta = Math.max(delta, -(o.offset || 0)); start = o.start + delta; }
        next = { start, dur: o.dur - delta, ...(o.srcDur != null ? { offset: (o.offset || 0) + delta } : {}) };
      } else {
        let end = o.start + o.dur + dt;
        const sn = snap(end, o.id);
        if (sn !== end) { end = sn; snapped = sn; }
        end = Math.max(end, o.start + MIN_DUR);
        if (o.srcDur != null) end = Math.min(end, o.start + maxSrc - (o.offset || 0));
        next = { dur: end - o.start };
      }
      if (Math.abs(e.clientX - drag.startX) > 2) drag.moved = true;
      setSnapAt(snapped);
      onChange((p) => ({ ...p, clips: p.clips.map((c) => (c.id === o.id ? { ...c, ...next } : c)) }), false);
    };
    const up = () => {
      if (drag.moved) onCommit();
      setDrag(null);
      setSnapAt(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, zoom, time, project.clips]);

  const seekFromEvent = (e: React.PointerEvent) => {
    const rect = scrollRef.current!.getBoundingClientRect();
    const toTime = (x: number) => Math.max(0, (x - rect.left + scrollRef.current!.scrollLeft) / zoom);
    onSeek(toTime(e.clientX));
    const move = (ev: PointerEvent) => onSeek(toTime(ev.clientX));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const setTrack = (id: string, patch: Partial<Track>) => onChange((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  const iconOf = (k: Track["kind"]) => (k === "text" ? <Type /> : k === "media" ? <ImageIcon /> : <Music />);

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto overscroll-contain bg-card select-none">
      {/* 轨道头 */}
      <div className="sticky left-0 z-20 shrink-0 border-r border-border bg-card" style={{ width: HEAD_W }}>
        <div className="sticky top-0 z-10 h-7 border-b border-border bg-card" />
        {project.tracks.map((t) => (
          <div key={t.id} className="flex items-center gap-1.5 border-b border-border/60 px-2 text-xs text-muted-foreground" style={{ height: ROW_H[t.kind] }}>
            <span className="[&_svg]:size-3.5">{iconOf(t.kind)}</span>
            <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">{t.name}</span>
            <button
              aria-label={t.kind === "audio" ? (t.muted ? "取消静音" : "静音") : t.hidden ? "显示" : "隐藏"}
              onClick={() => setTrack(t.id, t.kind === "audio" ? { muted: !t.muted } : { hidden: !t.hidden })}
              className="grid size-5 place-items-center rounded hover:bg-secondary hover:text-foreground [&_svg]:size-3.5"
            >
              {t.kind === "audio" ? (t.muted ? <VolumeX /> : <Volume2 />) : t.hidden ? <EyeOff /> : <Eye />}
            </button>
          </div>
        ))}
      </div>
      {/* 时间轴 */}
      <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="relative" style={{ width }}>
          <div className="sticky top-0 z-10 h-7 cursor-ew-resize border-b border-border bg-card" onPointerDown={seekFromEvent}>
            {ticks.map((s) => (
              <div key={s} className="absolute top-0 h-full border-l border-border pl-1 text-[10px] leading-7 tabular-nums text-muted-foreground" style={{ left: s * zoom }}>
                {`${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`}
              </div>
            ))}
          </div>
          {project.tracks.map((t) => (
            <div
              key={t.id}
              data-track={t.id}
              data-kind={t.kind}
              className={cn("relative border-b border-border/60", (t.hidden || t.muted) && "opacity-45")}
              style={{ height: ROW_H[t.kind] }}
              onPointerDown={(e) => { if (e.target === e.currentTarget) { onSelect(null); seekFromEvent(e); } }}
            >
              {project.clips.filter((c) => c.track === t.id).map((c) => {
                const w = c.dur * zoom;
                return (
                  <div
                    key={c.id}
                    data-clip={c.id}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      onSelect(c.id);
                      setDrag({ id: c.id, mode: "move", startX: e.clientX, orig: c, moved: false });
                    }}
                    className={cn(
                      "absolute inset-y-[3px] cursor-grab overflow-hidden rounded-[5px] text-[11px] leading-none active:cursor-grabbing",
                      CLIP_STYLE[c.kind],
                      selectedId === c.id && "ring-2 ring-primary ring-offset-1 ring-offset-card",
                    )}
                    style={{ left: c.start * zoom, width: Math.max(w, 2) }}
                  >
                    {c.kind === "media" && c.src && c.mediaType !== "video" && (
                      <div className="absolute inset-0 opacity-90" style={{ backgroundImage: `url("${c.src}")`, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x" }} />
                    )}
                    {c.kind === "audio" && c.src && <Wave peaks={assets.peaks.get(c.src)} offset={c.offset || 0} dur={c.dur} width={Math.max(w, 2)} height={24} />}
                    <span className="pointer-events-none relative block truncate px-1.5 pt-1.5 drop-shadow-sm">{c.kind === "text" ? c.text?.replace(/\n/g, " ") : c.kind === "audio" ? c.name : ""}</span>
                    {w > 14 && (
                      <>
                        <div onPointerDown={(e) => { e.stopPropagation(); onSelect(c.id); setDrag({ id: c.id, mode: "l", startX: e.clientX, orig: c, moved: false }); }} className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/40" />
                        <div onPointerDown={(e) => { e.stopPropagation(); onSelect(c.id); setDrag({ id: c.id, mode: "r", startX: e.clientX, orig: c, moved: false }); }} className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/40" />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {snapAt != null && <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-[var(--warning)]" style={{ left: snapAt * zoom }} />}
          <div className="pointer-events-none absolute inset-y-0 z-30 w-px bg-primary" style={{ left: time * zoom }}>
            <div className="absolute -left-[5px] top-0 size-[11px] rotate-45 rounded-[2px] bg-primary" />
          </div>
        </div>
      </div>
    </div>
  );
}
