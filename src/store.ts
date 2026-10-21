import { create } from "zustand";

export type Video = {
  id: string;
  url: string;
  title: string;
  channel: string;
  views: number;
  duration: number | null;
  thumb: string;
  platform: string;
  category: string;
  ai?: { zh_title: string; summary: string; why: string; tags: string[]; cover_style: CoverStyle; score: number };
};
export type CoverStyle = "band" | "poster" | "card" | "reels";
export type Draft = { video: Video; coverStyle: CoverStyle; note: string; accent?: string };
export type Job = {
  id: string;
  vid: string;
  url: string;
  title: string;
  coverStyle: CoverStyle;
  status: "queued" | "running" | "done" | "failed";
  steps: number;
  stage?: number;
  createdAt?: number;
  last: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  outputs: { video?: string | null; cover?: string | null; caption?: string | null; summary?: { title?: string; summary?: string; uncertain?: string[] } | null; folder?: string };
};

const api = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, init);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};

export type Page = "discover" | "studio" | "library";
export type Theme = "light" | "dark" | "system";

const applyTheme = (t: Theme) => {
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
};
const savedTheme = (() => { try { return (localStorage.getItem("kclip-theme") as Theme) || "light"; } catch { return "light" as Theme; } })();
applyTheme(savedTheme);

type State = {
  page: Page;
  setPage: (p: Page) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  loggedIn: boolean | null;
  query: string;
  searching: boolean;
  results: Video[];
  search: (q: string) => Promise<void>;
  detail: Video | null;
  openDetail: (v: Video | null) => void;
  retry: (id: string) => Promise<void>;
  categories: { id: string; label: string }[];
  selected: string[];
  videos: Record<string, Video[]>;
  loading: Record<string, boolean>;
  picks: Video[];
  picking: boolean;
  drafts: Draft[];
  jobs: Job[];
  error: string | null;
  init: () => Promise<void>;
  toggleCat: (ids: string[]) => void;
  fetchCats: () => Promise<void>;
  recommend: () => Promise<void>;
  addDraft: (v: Video) => void;
  updateDraft: (id: string, patch: Partial<Draft>) => void;
  removeDraft: (id: string) => void;
  reorder: (from: number, to: number) => void;
  produce: (drafts?: Draft[]) => Promise<void>;
  pollJobs: () => Promise<void>;
};

export const useStudio = create<State>((set, get) => ({
  page: "discover",
  setPage: (page) => set({ page }),
  theme: savedTheme,
  setTheme: (theme) => { try { localStorage.setItem("kclip-theme", theme); } catch { /* 无痕模式 */ } applyTheme(theme); set({ theme }); },
  loggedIn: null,
  query: "",
  searching: false,
  results: [],
  search: async (q) => {
    set({ query: q });
    if (!q.trim()) return set({ results: [] });
    set({ searching: true });
    try { set({ results: await api<Video[]>(`/api/search?q=${encodeURIComponent(q)}`) }); }
    catch (e) { set({ error: (e as Error).message }); }
    finally { set({ searching: false }); }
  },
  detail: null,
  openDetail: (detail) => set({ detail }),
  retry: async (id) => { await api("/api/retry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }); get().pollJobs(); },
  categories: [],
  selected: ["wys", "funny", "speech"],
  videos: {},
  loading: {},
  picks: [],
  picking: false,
  drafts: [],
  jobs: [],
  error: null,

  init: async () => {
    try {
      set({ categories: await api("/api/categories") });
      get().pollJobs();
      api<{ loggedIn: boolean }>("/api/health").then((h) => set({ loggedIn: h.loggedIn })).catch(() => {});
      api<{ picks: Video[] }>("/api/picks").then((p) => p.picks?.length && set({ picks: p.picks })).catch(() => {});
      get().fetchCats();
    } catch (e) {
      set({ error: `后端没连上：${(e as Error).message}` });
    }
  },
  toggleCat: (ids) => { set({ selected: ids }); get().fetchCats(); },

  fetchCats: async () => {
    const cats = get().selected;
    await Promise.all(
      cats.filter((c) => !get().videos[c] && !get().loading[c]).map(async (c) => {
        set((s) => ({ loading: { ...s.loading, [c]: true } }));
        try {
          const list = await api<Video[]>(`/api/discover?cat=${c}`);
          set((s) => ({ videos: { ...s.videos, [c]: list } }));
        } catch (e) {
          set({ error: (e as Error).message });
        } finally {
          set((s) => ({ loading: { ...s.loading, [c]: false } }));
        }
      }),
    );
  },

  recommend: async () => {
    set({ picking: true, error: null });
    try {
      set({ picks: await api<Video[]>(`/api/recommend?cats=${get().selected.join(",")}`) });
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ picking: false });
    }
  },

  addDraft: (v) =>
    set((s) => (s.drafts.some((d) => d.video.id === v.id) ? s : { drafts: [...s.drafts, { video: v, coverStyle: v.ai?.cover_style || "band", note: "" }] })),
  updateDraft: (id, patch) => set((s) => ({ drafts: s.drafts.map((d) => (d.video.id === id ? { ...d, ...patch } : d)) })),
  removeDraft: (id) => set((s) => ({ drafts: s.drafts.filter((d) => d.video.id !== id) })),
  reorder: (from, to) =>
    set((s) => {
      const d = [...s.drafts];
      const [m] = d.splice(from, 1);
      d.splice(to, 0, m);
      return { drafts: d };
    }),

  produce: async (drafts) => {
    const list = drafts || get().drafts;
    if (!list.length) return;
    await api("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: list.map((d) => ({ id: d.video.id, url: d.video.url, title: d.video.ai?.zh_title || d.video.title, coverStyle: d.coverStyle, note: d.note, accent: d.accent })),
      }),
    });
    if (!drafts) set({ drafts: [] });
    else set((s) => ({ drafts: s.drafts.filter((d) => !list.some((x) => x.video.id === d.video.id)) }));
    get().pollJobs();
  },

  pollJobs: async () => {
    try {
      set({ jobs: (await api<Job[]>("/api/jobs")).reverse() });
    } catch {
      /* 后端暂时没响应，下次再试 */
    }
  },
}));
