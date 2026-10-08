/*
 * Bilibili 国际版 弹幕清理 (Loon http-response 脚本, 需要 binary-body-mode=true)
 *
 * 处理两个 gRPC 接口:
 *   1) bilibili.community.service.dm.v1.DM/DmView          (弹幕配置, 播放时调用)
 *   2) bilibili.app.viewunite.v1.View/ViewProgress         (播放进度/互动数据, 播放时调用)
 *
 * 功能 (抓包确认):
 *   A. 去除左上角「云视听小电视」徽章      DmView 第 18 号字段里 id=10011 的图片弹幕
 *   B. 去除互动弹幕弹窗 (你喜欢? 投票/关注/…)  DmView 第 22 号字段 + ViewProgress 第 4 号字段 (CommandDms)
 *   C. (可选, 默认关闭) 播放时默认关闭弹幕    改 DmView 第 6 号字段里的弹幕开关
 *
 * 没有命中任何要删除的内容时, 原样放行; 出错时也原样放行。
 */
const TAG = "[BiliDmClean] ";

// ===== 可自行修改 =====
const REMOVE_TV_BADGE = true;          // A
const BLOCK_IDS = [10011];             // A: 要删除的推广图片弹幕 id
const REMOVE_COMMAND_DMS = true;       // B: 去除互动弹幕弹窗
// B: 要去掉的互动弹幕类型; "*" = 全部。例如只去投票: ["#VOTE#"]
// 已见到的类型: #VOTE#(投票) #ATTENTION#(关注)
const BLOCK_COMMANDS = ["*"];
const DISABLE_DANMAKU_DEFAULT = true; // C: 默认关闭弹幕 (实验性, 见说明)
// =====================

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
function ascii(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}
// 解析一层 protobuf: 返回 [{f, w, start, tagEnd, end, payload?, value?}]
function parseMsg(msg) {
  const items = [];
  let i = 0;
  while (i < msg.length) {
    const start = i;
    let k; [k, i] = readVarint(msg, i);
    const f = Math.floor(k / 8), w = k & 7;
    const tagEnd = i;
    const it = { f: f, w: w, start: start, tagEnd: tagEnd };
    if (w === 0) { let v; [v, i] = readVarint(msg, i); it.value = v; }
    else if (w === 1) i += 8;
    else if (w === 5) i += 4;
    else if (w === 2) { let l; [l, i] = readVarint(msg, i); it.payload = msg.subarray(i, i + l); i += l; }
    else throw new Error("unsupported wire type " + w);
    it.end = i;
    items.push(it);
  }
  return items;
}
// 逐字段处理: handler(item) 返回 undefined=保留, null=删除, Uint8Array=替换 payload, {varint:n}=替换整数
function editMsg(msg, handlers) {
  const items = parseMsg(msg);
  const parts = [];
  let changed = 0;
  items.forEach((it) => {
    const h = handlers[it.f];
    const r = h ? h(it) : undefined;
    if (r === undefined) { parts.push(msg.subarray(it.start, it.end)); return; }
    changed++;
    if (r === null) return;
    if (r instanceof Uint8Array) {
      parts.push(msg.subarray(it.start, it.tagEnd), writeVarint(r.length), r);
    } else if (r && r.varint !== undefined) {
      parts.push(msg.subarray(it.start, it.tagEnd), writeVarint(r.varint));
    }
  });
  return { msg: changed ? concat(parts) : msg, changed: changed };
}

// ---------- 业务逻辑 ----------
let stat = { badge: 0, cmd: 0, switchOff: 0 };

// CommandDms 包装: 里面是 repeated CommandDm(f1), 每个 CommandDm 的 f4 是类型字符串
function filterCommandDms(wrapper) {
  const items = parseMsg(wrapper);
  const keep = [];
  let removed = 0;
  items.forEach((it) => {
    if (it.f === 1 && it.w === 2) {
      let cmd = "";
      parseMsg(it.payload).forEach((x) => { if (x.f === 4 && x.w === 2) cmd = ascii(x.payload); });
      if (BLOCK_COMMANDS.indexOf("*") >= 0 || BLOCK_COMMANDS.indexOf(cmd) >= 0) { removed++; return; }
    }
    keep.push(wrapper.subarray(it.start, it.end));
  });
  stat.cmd += removed;
  return { removed: removed, bytes: keep.length ? concat(keep) : null };
}

function handleDmView(msg) {
  const handlers = {};
  if (REMOVE_TV_BADGE) {
    handlers[18] = (it) => {
      if (it.w !== 2) return undefined;
      const s = ascii(it.payload);
      if (BLOCK_IDS.some((id) => s.indexOf('"id":' + id + ",") >= 0 || s.indexOf('"id":' + id + "}") >= 0)) { stat.badge++; return null; }
      return undefined;
    };
  }
  if (REMOVE_COMMAND_DMS) {
    handlers[22] = (it) => {
      if (it.w !== 2) return undefined;
      const r = filterCommandDms(it.payload);
      if (!r.removed) return undefined;
      return r.bytes;               // null 时整个字段删除
    };
  }
  if (DISABLE_DANMAKU_DEFAULT) {
    // f6 = 弹幕播放器配置: f1.f4 = 默认配置里的弹幕开关, f2.f1 = 用户配置里的弹幕开关
    handlers[6] = (it) => {
      if (it.w !== 2) return undefined;
      let n = 0;
      const r = editMsg(it.payload, {
        1: (a) => {
          if (a.w !== 2) return undefined;
          const x = editMsg(a.payload, { 4: (c) => { if (c.w === 0 && c.value !== 0) { n++; return { varint: 0 }; } } });
          return x.changed ? x.msg : undefined;
        },
        2: (a) => {
          if (a.w !== 2) return undefined;
          const x = editMsg(a.payload, { 1: (c) => { if (c.w === 0 && c.value !== 0) { n++; return { varint: 0 }; } } });
          return x.changed ? x.msg : undefined;
        },
      });
      stat.switchOff += n;
      return r.changed ? r.msg : undefined;
    };
  }
  return editMsg(msg, handlers);
}

function handleViewProgress(msg) {
  if (!REMOVE_COMMAND_DMS) return { msg: msg, changed: 0 };
  return editMsg(msg, {
    4: (it) => {
      if (it.w !== 2) return undefined;
      const r = filterCommandDms(it.payload);
      if (!r.removed) return undefined;
      return r.bytes;
    },
  });
}

function main() {
  const url = $request.url;
  const isDmView = /\/bilibili\.community\.service\.dm\.v1\.DM\/DmView/.test(url);
  const isVP = /\/bilibili\.app\.viewunite\.v1\.View\/ViewProgress/.test(url);
  const body = $response.body;
  if ((!isDmView && !isVP) || !body || body.length < 5) return $done({});

  const frames = [];
  let i = 0, anyChanged = 0;
  while (i + 5 <= body.length) {
    const flag = body[i];
    const len = ((body[i + 1] << 24) | (body[i + 2] << 16) | (body[i + 3] << 8) | body[i + 4]) >>> 0;
    let payload = body.subarray(i + 5, i + 5 + len);
    i += 5 + len;
    if (flag === 1) payload = gunzip(payload);
    const r = isDmView ? handleDmView(payload) : handleViewProgress(payload);
    anyChanged += r.changed;
    const m = r.msg;
    const hdr = new Uint8Array([0, (m.length >>> 24) & 255, (m.length >>> 16) & 255, (m.length >>> 8) & 255, m.length & 255]);
    frames.push(hdr, m);
  }
  if (!anyChanged) return $done({});
  const headers = {};
  Object.keys($response.headers || {}).forEach((k) => {
    const lk = k.toLowerCase();
    if (lk !== "content-length") headers[k] = $response.headers[k];
  });
  console.log(TAG + (isDmView ? "DmView" : "ViewProgress") + " badge=" + stat.badge + " commandDm=" + stat.cmd + " danmakuSwitchOff=" + stat.switchOff);
  $done({ headers: headers, body: concat(frames) });
}

try { main(); } catch (e) { console.log(TAG + "error, passthrough: " + e); $done({}); }
