/*
 * Bilibili 国际版: 去除播放页左上角「云视听小电视 / 开电视 看B站TV版 / 同步播出」推广徽章
 *
 * 来源 (抓包确认): gRPC 接口 bilibili.community.service.dm.v1.DM/DmView 返回体里的第 18 号字段,
 *   内容是一段 JSON:
 *   {"id":10011,"start":0,"end":5,"raw_data":null,"picture":{"mime":"image","resource":"https://i0.hdslb.com/bfs/activity-plat/static/9bdd988a.../vBISHozSu0.png"}}
 *   即「视频开始 0~5 秒显示一张图片」, 图片内容就是云视听小电视徽章 (所以出现几秒后就消失)。
 *
 * 做法: 解开 gRPC(gzip) 帧 -> 在 protobuf 顶层删掉含有 BLOCK_IDS 的第 18 号字段 -> 重新封成未压缩帧。
 *       其它内容 (弹幕设置、投票弹幕、前方高能等) 完全保留。没有命中时不做任何修改。
 * 需要 binary-body-mode=true。
 */
const TAG = "[BiliDmViewTV] ";
const BLOCK_IDS = [10011];            // 要删除的 id, 以后出现新的推广图可以往这里加
const BLOCK_FIELD = 18;               // DmView 里存放这段 JSON 的字段号

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

// ---------- protobuf 顶层字段遍历 ----------
function readVarint(b, i) {
  let r = 0, mul = 1;
  for (;;) {
    const x = b[i++];
    r += (x & 0x7f) * mul;
    if (!(x & 0x80)) return [r, i];
    mul *= 128;
  }
}
function utf8(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);   // JSON 前缀为 ASCII, 足够匹配
  return s;
}
function stripField(msg) {
  const keep = [];
  let i = 0, removed = 0;
  while (i < msg.length) {
    const st = i;
    let k; [k, i] = readVarint(msg, i);
    const f = Math.floor(k / 8), w = k & 7;
    if (w === 0) { [, i] = readVarint(msg, i); }
    else if (w === 1) i += 8;
    else if (w === 5) i += 4;
    else if (w === 2) {
      let l; [l, i] = readVarint(msg, i);
      const payload = msg.subarray(i, i + l);
      i += l;
      if (f === BLOCK_FIELD) {
        const s = utf8(payload);
        if (BLOCK_IDS.some((id) => s.indexOf('"id":' + id + ",") >= 0 || s.indexOf('"id":' + id + "}") >= 0)) {
          removed++;
          continue;                      // 丢弃这个字段
        }
      }
    } else throw new Error("unsupported wire type " + w);
    keep.push(msg.subarray(st, i));
  }
  return { removed, keep };
}
function concat(parts) {
  let n = 0;
  parts.forEach((p) => (n += p.length));
  const out = new Uint8Array(n);
  let o = 0;
  parts.forEach((p) => { out.set(p, o); o += p.length; });
  return out;
}

try {
  const body = $response.body;
  if (!body || body.length < 5) { $done({}); }
  else {
    const frames = [];
    let i = 0, totalRemoved = 0;
    while (i + 5 <= body.length) {
      const flag = body[i];
      const len = ((body[i + 1] << 24) | (body[i + 2] << 16) | (body[i + 3] << 8) | body[i + 4]) >>> 0;
      let payload = body.subarray(i + 5, i + 5 + len);
      i += 5 + len;
      if (flag === 1) payload = gunzip(payload);
      const r = stripField(payload);
      totalRemoved += r.removed;
      const newMsg = r.removed ? concat(r.keep) : payload;
      const hdr = new Uint8Array(5);
      hdr[0] = 0;                         // 未压缩帧
      hdr[1] = (newMsg.length >>> 24) & 255; hdr[2] = (newMsg.length >>> 16) & 255;
      hdr[3] = (newMsg.length >>> 8) & 255;  hdr[4] = newMsg.length & 255;
      frames.push(hdr, newMsg);
    }
    if (!totalRemoved) { $done({}); }     // 没有推广, 原样放行
    else {
      const headers = {};
      Object.keys($response.headers || {}).forEach((k) => {
        if (k.toLowerCase() !== "content-length") headers[k] = $response.headers[k];
      });
      console.log(TAG + "removed " + totalRemoved + " promo picture field(s)");
      $done({ headers: headers, body: concat(frames) });
    }
  }
} catch (e) {
  console.log(TAG + "error, passthrough: " + e);
  $done({});
}

