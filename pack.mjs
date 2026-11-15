// 作品打包：成片 + 封面 + 文案打成 zip，下载或复制到系统剪贴板
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";

const PACK_FILES = ["成片.mp4", "封面.jpg", "封面_3比4.png", "小红书文案.txt"];

// 视频和图片本身已经压缩过，这里只存不压；文件名用 UTF-8，中文不会乱码
export function makeZip(files) {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const n = Buffer.from(name);
    const crc = crc32(data);
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0);
    common.writeUInt16LE(0x0800, 2);
    common.writeUInt16LE(0, 4);
    common.writeUInt16LE(time, 6);
    common.writeUInt16LE(date, 8);
    common.writeUInt32LE(crc, 10);
    common.writeUInt32LE(data.length, 14);
    common.writeUInt32LE(data.length, 18);
    common.writeUInt16LE(n.length, 22);
    const sig = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
    locals.push(sig(0x04034b50), common, n, data);
    const tail = Buffer.alloc(14); // 备注长度、磁盘号、内部/外部属性都是 0，最后 4 字节是本地头偏移
    tail.writeUInt32LE(offset, 10);
    const made = Buffer.alloc(2);
    made.writeUInt16LE(20);
    centrals.push(sig(0x02014b50), made, common, tail, n);
    offset += 4 + common.length + n.length + data.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

// 路径走环境变量，不拼进命令，中文和特殊字符都安全
const setClipboardFile = (file) => new Promise((res, rej) => {
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -LiteralPath $env:KCLIP_ZIP"], { env: { ...process.env, KCLIP_ZIP: file }, windowsHide: true, timeout: 20000 }, (e, _out, err) => (e ? rej(new Error(String(err || e.message).slice(0, 200))) : res()));
});

export function createPackApi({ jobs, outputsOf, send, body }) {
  const pack = (id) => {
    const j = jobs.find((x) => x.id === id);
    if (!j || j.status !== "done") throw new Error("找不到这条作品");
    const out = path.join(j.dir, "out");
    const files = PACK_FILES.filter((f) => existsSync(path.join(out, f))).map((name) => ({ name, data: readFileSync(path.join(out, name)) }));
    if (!files.some((f) => f.name === PACK_FILES[0])) throw new Error("这条作品还没有成片");
    const o = outputsOf(j);
    const title = o.summary?.title || j.title || j.id;
    const base = String(title).replace(/[\\/:*?"<>|？\r\n]/g, "").trim().slice(0, 60) || j.id;
    return { zip: makeZip(files), base, out };
  };

  return async function handle(req, res, u) {
    if (!u.pathname.startsWith("/api/pack")) return false;
    if (u.pathname === "/api/pack" && req.method === "GET") {
      const { zip, base } = pack(u.searchParams.get("id"));
      res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length, "content-disposition": `attachment; filename="kclip.zip"; filename*=UTF-8''${encodeURIComponent(base)}.zip` });
      res.end(zip);
      return true;
    }
    if (u.pathname === "/api/pack/copy" && req.method === "POST") {
      // 只接受工作台自己的页面，别的网站不能改本机剪贴板
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) { send(res, 403, { error: "来源不对" }); return true; }
      const { zip, base, out } = pack((await body(req)).id);
      // zip 留在作品的 out 文件夹：粘贴时系统要去读这个文件
      const file = path.join(out, `${base}.zip`);
      writeFileSync(file, zip);
      await setClipboardFile(file);
      send(res, 200, { ok: true, name: `${base}.zip`, sizeMB: Number((zip.length / 1048576).toFixed(1)) });
      return true;
    }
    return false;
  };
}
