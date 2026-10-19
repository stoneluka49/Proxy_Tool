/*
 * Bilibili: 从源头剔除 MCDN / PCDN 节点, 只保留官方 CDN (UPOS) 地址  (Loon http-response 脚本)
 *
 * 抓包确认的播放地址下发位置 (全部处理):
 *   1) JSON  /x/v2/feed/index、/feed/index/story、/feed/index/relate/story
 *        每个视频 uri 里的 player_preload=<URL编码JSON>, dash.video/audio[].base_url + backup_url[]
 *   2) gRPC  bilibili.app.playerunite.v1.Player/PlayViewUnite
 *        protobuf 里每条轨道: 字段1=base_url, 字段2(重复)=backup_url
 *   3) gRPC  bilibili.app.viewunite.v1.View/View
 *        protobuf 字符串字段里嵌着 bilibili://video/...&player_preload=<URL编码JSON>
 *
 * 判定为 PCDN/MCDN 的节点 (见 BLOCK_OS):
 *   os=mcdn (含 mcdnid=, *.mcdn.bilivideo.cn)  -- B站 MCDN
 *   os=302ppio (upos-sz-302ppio.bilivideo.com -> *.nexusedgeio.com) -- PPIO 派欧云 PCDN
 *   os=bcache  -- 自建缓存/边缘节点 (IP 直连), 是否过滤由 BLOCK_OS 决定
 *
 * 做法: 每条轨道把 base_url + backup_url 合并, 剔除 PCDN, 剩下的按
 *       "upos 域名(按 PREFER_HOSTS) > 官方 IP 节点" 排序, 第一个作 base_url, 其余作 backup_url。
 *       某条轨道如果全是 PCDN (没有官方地址可替换), 保持原样, 避免该轨道无法播放。
 * 出错一律原样放行。
 *
 * 需要: JSON 接口用普通模式; gRPC 接口必须 binary-body-mode=true (见插件)。
 */
const TAG = "[BiliNoMCDN] ";

// ===== 可自行修改 =====
const BLOCK_OS = ["mcdn", "302ppio", "bcache"]; // 要剔除的节点 os 值; 不想过滤 bcache 就删掉它
const KEEP_OFFICIAL_IP_NODES = true;   // true: 保留 os 不在 BLOCK_OS 里的 IP 直连官方节点; false: 只保留 upos-*.bilivideo.com 域名
const PREFER_HOSTS = [                  // 优先使用的官方域名关键字 (按顺序), 不想指定就留空数组
  "mirrorcos", "estgcos", "mirrorali", "mirroralib",
];
// =====================

function osOf(u) { const m = /[?&]os=([^&]*)/i.exec(u); return m ? m[1].toLowerCase() : ""; }
function isPcdn(u) {
  const os = osOf(u);
  if (os && BLOCK_OS.indexOf(os) >= 0) return true;
  if (BLOCK_OS.indexOf("mcdn") >= 0 && (/[?&]mcdnid=/i.test(u) || /\.mcdn\./i.test(u) || /^https?:\/\/[\d.]+:4480\//i.test(u))) return true;
  if (BLOCK_OS.indexOf("302ppio") >= 0 && /(?:302ppio|nexusedgeio)/i.test(u.split("?")[0])) return true;
  return false;
}
function isUposHost(u) {
  return /^https?:\/\/upos-[a-z0-9-]+\.bilivideo\.com\//i.test(u) || /^https?:\/\/upos-[a-z0-9-]+\.akamaized\.net\//i.test(u);
}
function isIpNode(u) { return /^https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\//.test(u); }
function rank(u) {
  if (isUposHost(u)) {
    for (let i = 0; i < PREFER_HOSTS.length; i++) if (u.indexOf(PREFER_HOSTS[i]) >= 0) return i;
    return PREFER_HOSTS.length;
  }
  return PREFER_HOSTS.length + 1;
}
// 从一组候选地址里挑出官方地址并排序; 返回 null 表示"不需要改"或"没有可替换的"
let stat = { tracks: 0, changed: 0, allPcdn: 0, removed: 0 };
function pickGood(all) {
  stat.tracks++;
  const good = all.filter((u) => !isPcdn(u) && (isUposHost(u) || (KEEP_OFFICIAL_IP_NODES && isIpNode(u))));
  const bad = all.length - good.length;
  if (!bad) return null;
  if (!good.length) { stat.allPcdn++; return null; }
  const sorted = good.map((u, i) => ({ u: u, i: i, r: rank(u) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.u);
  const uniq = sorted.filter((u, i) => sorted.indexOf(u) === i);
  stat.removed += bad;
  stat.changed++;
  return uniq;
}

// ---------- JSON: player_preload ----------
function fixTrack(tr) {
  const all = [];
  if (tr.base_url) all.push(tr.base_url);
  (tr.backup_url || []).forEach((u) => { if (u) all.push(u); });
  const uniq = pickGood(all);
  if (!uniq) return false;
  tr.base_url = uniq[0];
  tr.backup_url = uniq.slice(1);
  return true;
}
function fixUri(uri) {
  const key = "player_preload=";
  const p = uri.indexOf(key);
  if (p < 0) return uri;
  const s = p + key.length;
  let e = uri.indexOf("&", s);
  if (e < 0) e = uri.length;
  let pre;
  try { pre = JSON.parse(decodeURIComponent(uri.substring(s, e))); } catch (x) { return uri; }
  const dash = pre && pre.dash;
  if (!dash) return uri;
  let changed = false;
  ["video", "audio"].forEach((k) => { (dash[k] || []).forEach((tr) => { if (fixTrack(tr)) changed = true; }); });
  if (!changed) return uri;
  return uri.substring(0, s) + encodeURIComponent(JSON.stringify(pre)) + uri.substring(e);
}
function walkJson(o) {
  if (Array.isArray(o)) { o.forEach(walkJson); return; }
  if (o && typeof o === "object") {
    Object.keys(o).forEach((k) => {
      const v = o[k];
      if (typeof v === "string") {
        if (v.indexOf("player_preload=") >= 0 && v.indexOf("bilibili://") === 0) o[k] = fixUri(v);
      } else walkJson(v);
    });
  }
}

// ---------- 最小 inflate (移植自 zlib puff.c, 仅解 raw deflate) ----------
function inflateRaw(src, start) {
  let pos = start, bitbuf = 0, bitcnt = 0;
  const out = [];
  const bits = (need) => {
    let val = bitbuf;
    while (bitcnt < need) {
      if (pos >= src.length) throw new Error("eof");
      val |= src[pos++] << bitcnt;
      bitcnt += 8;
    }
    bitbuf = val >>> need;
    bitcnt -= need;
    return val & ((1 << need) - 1);
  };
  const construct = (lengths, n) => {
    const count = new Array(16).fill(0), symbol = new Array(n).fill(0), offs = new Array(16).fill(0);
    for (let s = 0; s < n; s++) count[lengths[s]]++;
    for (let l = 1; l < 15; l++) offs[l + 1] = offs[l] + count[l];
    for (let s = 0; s < n; s++) if (lengths[s] !== 0) symbol[offs[lengths[s]]++] = s;
    return { count, symbol };
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count; first += count; first <<= 1; code <<= 1;
    }
    throw new Error("bad code");
  };
  const LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const LEXT = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const DEXT = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const codes = (lc, dc) => {
    for (;;) {
      let sym = decode(lc);
      if (sym < 256) out.push(sym);
      else if (sym === 256) return;
      else {
        sym -= 257;
        if (sym >= 29) throw new Error("bad len");
        const len = LBASE[sym] + bits(LEXT[sym]);
        const ds = decode(dc);
        const dist = DBASE[ds] + bits(DEXT[ds]);
        if (dist > out.length) throw new Error("bad dist");
        for (let k = 0; k < len; k++) out.push(out[out.length - dist]);
      }
    }
  };
  let fixed = null;
  const getFixed = () => {
    if (fixed) return fixed;
    const l = new Array(288);
    for (let s = 0; s < 144; s++) l[s] = 8;
    for (let s = 144; s < 256; s++) l[s] = 9;
    for (let s = 256; s < 280; s++) l[s] = 7;
    for (let s = 280; s < 288; s++) l[s] = 8;
    fixed = { lc: construct(l, 288), dc: construct(new Array(30).fill(5), 30) };
    return fixed;
  };
  const ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0; bitcnt = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      for (let k = 0; k < len; k++) out.push(src[pos++]);
    } else if (type === 1) {
      const f = getFixed(); codes(f.lc, f.dc);
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      const lengths = new Array(320).fill(0);
      for (let k = 0; k < ncode; k++) lengths[ORDER[k]] = bits(3);
      const lencode = construct(lengths.slice(0, 19), 19);
      let idx = 0;
      const ll = new Array(nlen + ndist).fill(0);
      while (idx < nlen + ndist) {
        let sym = decode(lencode);
        if (sym < 16) ll[idx++] = sym;
        else {
          let len = 0, rep;
          if (sym === 16) { len = ll[idx - 1]; rep = 3 + bits(2); }
          else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          while (rep--) ll[idx++] = len;
        }
      }
      codes(construct(ll.slice(0, nlen), nlen), construct(ll.slice(nlen), ndist));
    } else throw new Error("bad block");
  } while (!last);
  return new Uint8Array(out);
}
function gunzip(buf) {
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) throw new Error("not gzip");
  const flg = buf[3];
  let p = 10;
  if (flg & 4) { p += 2 + (buf[p] | (buf[p + 1] << 8)); }
  if (flg & 8) { while (buf[p++] !== 0); }
  if (flg & 16) { while (buf[p++] !== 0); }
  if (flg & 2) p += 2;
  return inflateRaw(buf, p);
}

// ---------- protobuf 工具 ----------
function readVarint(b, i) {
  let r = 0, mul = 1;
  for (;;) {
    if (i >= b.length) throw new Error("varint eof");
    const x = b[i++];
    r += (x & 0x7f) * mul;
    if (!(x & 0x80)) return [r, i];
    mul *= 128;
  }
}
function writeVarint(n) {
  const out = [];
  while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return new Uint8Array(out);
}
function concat(parts) {
  let n = 0;
  parts.forEach((p) => (n += p.length));
  const out = new Uint8Array(n);
  let o = 0;
  parts.forEach((p) => { out.set(p, o); o += p.length; });
  return out;
}
function bytesToStr(b) { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
function strToBytes(s) {            // ASCII 字符串 (URL 已百分号编码, 全是 ASCII)
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}
// 严格解析一层 protobuf, 失败返回 null
function parseMsg(msg) {
  const items = [];
  let i = 0;
  try {
    while (i < msg.length) {
      const start = i;
      let k; [k, i] = readVarint(msg, i);
      const f = Math.floor(k / 8), w = k & 7;
      if (f < 1 || f > 536870911) return null;
      const tagEnd = i;
      const it = { f: f, w: w, start: start, tagEnd: tagEnd };
      if (w === 0) { [, i] = readVarint(msg, i); }
      else if (w === 1) { i += 8; if (i > msg.length) return null; }
      else if (w === 5) { i += 4; if (i > msg.length) return null; }
      else if (w === 2) {
        let l; [l, i] = readVarint(msg, i);
        if (i + l > msg.length) return null;
        it.payload = msg.subarray(i, i + l); i += l;
      } else return null;
      it.end = i;
      items.push(it);
    }
  } catch (e) { return null; }
  return items;
}
function isNodeUrl(p) {
  if (p.length < 20 || p[0] !== 104 /* h */ || p[1] !== 116 || p[2] !== 116 || p[3] !== 112) return false;
  const s = bytesToStr(p);
  return /^https?:\/\//.test(s) && s.indexOf("/upgcxcode/") > 0;
}
function reLen(tagBytes, payload) { return [tagBytes, writeVarint(payload.length), payload]; }

// 递归改写一条 protobuf 消息; 返回 Uint8Array(有改动) 或 null(无改动)
function rewriteMsg(msg, depth) {
  const items = parseMsg(msg);
  if (!items) return null;

  // 1) 本层的节点地址组 (PlayViewUnite: 字段1=base_url, 字段2 重复=backup_url)
  const urlItems = items.filter((it) => it.w === 2 && isNodeUrl(it.payload));
  if (urlItems.length) {
    const uniq = pickGood(urlItems.map((it) => bytesToStr(it.payload)));
    if (uniq) {
      const parts = [];
      let baseDone = false, backupDone = false;
      items.forEach((it) => {
        if (it.w === 2 && isNodeUrl(it.payload)) {
          if (!baseDone) {
            baseDone = true;
            parts.push.apply(parts, reLen(msg.subarray(it.start, it.tagEnd), strToBytes(uniq[0])));
          } else if (!backupDone) {
            backupDone = true;
            uniq.slice(1).forEach((u) => parts.push.apply(parts, reLen(msg.subarray(it.start, it.tagEnd), strToBytes(u))));
          }
          return;                        // 其余原地址字段丢弃
        }
        parts.push(msg.subarray(it.start, it.end));
      });
      // 子消息里可能还有别的地址, 继续处理 (一般没有)
      return concat(parts);
    }
  }

  // 2) 下探子消息 / 处理嵌在字符串里的 player_preload
  let changed = false;
  const parts = [];
  items.forEach((it) => {
    if (it.w === 2 && it.payload.length > 8) {
      const p = it.payload;
      // bilibili://...player_preload=...
      if (p[0] === 98 /* b */ && p[1] === 105 && p[2] === 108 && p[3] === 105) {
        const s = bytesToStr(p);
        if (s.indexOf("bilibili://") === 0 && s.indexOf("player_preload=") > 0) {
          let ns = s;
          try { ns = fixUri(s); } catch (e) { ns = s; }
          if (ns !== s) {
            changed = true;
            parts.push.apply(parts, reLen(msg.subarray(it.start, it.tagEnd), strToBytes(ns)));
            return;
          }
        }
      } else if (depth < 12) {
        const sub = rewriteMsg(p, depth + 1);
        if (sub) {
          changed = true;
          parts.push.apply(parts, reLen(msg.subarray(it.start, it.tagEnd), sub));
          return;
        }
      }
    }
    parts.push(msg.subarray(it.start, it.end));
  });
  return changed ? concat(parts) : null;
}

function handleGrpc(body) {
  const frames = [];
  let i = 0, any = false;
  while (i + 5 <= body.length) {
    const flag = body[i];
    const len = ((body[i + 1] << 24) | (body[i + 2] << 16) | (body[i + 3] << 8) | body[i + 4]) >>> 0;
    let payload = body.subarray(i + 5, i + 5 + len);
    i += 5 + len;
    if (flag === 1) payload = gunzip(payload);
    const r = rewriteMsg(payload, 0);
    const m = r || payload;
    if (r) any = true;
    frames.push(new Uint8Array([0, (m.length >>> 24) & 255, (m.length >>> 16) & 255, (m.length >>> 8) & 255, m.length & 255]), m);
  }
  if (!any) return null;
  return concat(frames);
}

function main() {
  const body = $response.body;
  if (typeof body === "string") {            // JSON 信息流
    const j = JSON.parse(body);
    walkJson(j);
    if (!stat.changed) { console.log(TAG + "json no change (tracks=" + stat.tracks + ", allPcdn=" + stat.allPcdn + ")"); return $done({}); }
    console.log(TAG + "json tracks=" + stat.tracks + " changed=" + stat.changed + " removedUrls=" + stat.removed + " allPcdnKept=" + stat.allPcdn);
    return $done({ body: JSON.stringify(j) });
  }
  if (!body || body.length < 5) return $done({});
  const out = handleGrpc(body);              // gRPC (binary-body-mode)
  if (!out) { console.log(TAG + "grpc no change (tracks=" + stat.tracks + ", allPcdn=" + stat.allPcdn + ")"); return $done({}); }
  const headers = {};
  Object.keys($response.headers || {}).forEach((k) => { if (k.toLowerCase() !== "content-length") headers[k] = $response.headers[k]; });
  console.log(TAG + "grpc tracks=" + stat.tracks + " changed=" + stat.changed + " removedUrls=" + stat.removed + " allPcdnKept=" + stat.allPcdn);
  $done({ headers: headers, body: out });
}

try { main(); } catch (e) { console.log(TAG + "error, passthrough: " + e); $done({}); }
