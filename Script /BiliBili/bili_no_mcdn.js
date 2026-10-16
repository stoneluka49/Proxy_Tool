/*
 * Bilibili: 从源头剔除 MCDN 节点, 只保留官方 CDN (UPOS) 地址 (Loon http-response 脚本)
 *
 * 抓包确认:
 *   首页/Story 信息流接口会把"预加载播放地址"直接塞进每个视频的 uri 里:
 *     bilibili://story/xxx?cid=...&player_preload=<URL编码的JSON>
 *   JSON 里 dash.video[] / dash.audio[] 每条轨道都有 base_url + backup_url[];
 *   其中 os=mcdn (并带 mcdnid=) 的就是 MCDN 节点 (IP:8000 或 IP:4480, 路径 /v1/resource/upgcxcode/...)。
 *   App 优先使用 base_url, 所以首选节点经常是 MCDN。
 *
 * 做法: 对每条轨道把 base_url + backup_url 合并后剔除 MCDN, 剩下的按
 *       "upos 域名 > 官方 IP 节点" 排序, 第一个作为 base_url, 其余作为 backup_url。
 *       某条轨道如果全是 MCDN (没有官方地址可替换), 则保持原样不动, 避免该轨道无法播放。
 *
 * 适用接口 (见插件): /x/v2/feed/index, /x/v2/feed/index/story, /x/v2/feed/index/relate/story
 * 出错时原样放行。
 */
const TAG = "[BiliNoMCDN] ";

// ===== 可自行修改 =====
const KEEP_OFFICIAL_IP_NODES = true;   // true: 保留 os 不是 mcdn 的 IP 直连官方节点; false: 只保留 upos-*.bilivideo.com 域名
const PREFER_HOSTS = [                  // 优先使用的官方域名关键字 (按顺序), 不想指定就留空数组
  "mirrorcos", "estgcos", "mirrorali", "mirroralib",
];
// =====================

function isMcdn(u) {
  return /[?&]os=mcdn(?:&|$)/i.test(u) || /[?&]mcdnid=/i.test(u) || /\.mcdn\./i.test(u) || /^https?:\/\/[\d.]+:4480\//i.test(u);
}
function isUposHost(u) {
  return /^https?:\/\/upos-[a-z0-9-]+\.bilivideo\.com\//i.test(u) || /^https?:\/\/upos-[a-z0-9-]+\.akamaized\.net\//i.test(u);
}
function isIpNode(u) {
  return /^https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\//.test(u);
}
function rank(u) {
  if (isUposHost(u)) {
    for (let i = 0; i < PREFER_HOSTS.length; i++) if (u.indexOf(PREFER_HOSTS[i]) >= 0) return i;
    return PREFER_HOSTS.length;
  }
  return PREFER_HOSTS.length + 1;      // 官方 IP 节点排在域名之后
}

let stat = { tracks: 0, changed: 0, allMcdn: 0, removed: 0 };

function fixTrack(tr) {
  stat.tracks++;
  const all = [];
  if (tr.base_url) all.push(tr.base_url);
  (tr.backup_url || []).forEach((u) => { if (u) all.push(u); });
  const good = all.filter((u) => !isMcdn(u) && (isUposHost(u) || (KEEP_OFFICIAL_IP_NODES && isIpNode(u))));
  const bad = all.length - good.length;
  if (!bad) return false;                       // 本来就没有 MCDN
  if (!good.length) { stat.allMcdn++; return false; }   // 全是 MCDN, 保持原样
  // 稳定排序: 先按 rank, 同级保持原顺序
  const sorted = good.map((u, i) => ({ u: u, i: i, r: rank(u) }))
    .sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.u);
  // 去重
  const uniq = sorted.filter((u, i) => sorted.indexOf(u) === i);
  tr.base_url = uniq[0];
  tr.backup_url = uniq.slice(1);
  stat.removed += bad;
  stat.changed++;
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
  ["video", "audio"].forEach((k) => {
    (dash[k] || []).forEach((tr) => { if (fixTrack(tr)) changed = true; });
  });
  if (!changed) return uri;
  return uri.substring(0, s) + encodeURIComponent(JSON.stringify(pre)) + uri.substring(e);
}

function walk(o) {
  if (Array.isArray(o)) { o.forEach(walk); return; }
  if (o && typeof o === "object") {
    Object.keys(o).forEach((k) => {
      const v = o[k];
      if (typeof v === "string") {
        if (v.indexOf("player_preload=") >= 0 && v.indexOf("bilibili://") === 0) o[k] = fixUri(v);
      } else walk(v);
    });
  }
}

try {
  const j = JSON.parse($response.body);
  walk(j);
  if (!stat.changed) { console.log(TAG + "no change (tracks=" + stat.tracks + ", allMcdn=" + stat.allMcdn + ")"); $done({}); }
  else {
    console.log(TAG + "tracks=" + stat.tracks + " changed=" + stat.changed + " removedMcdnUrls=" + stat.removed + " allMcdnKept=" + stat.allMcdn);
    $done({ body: JSON.stringify(j) });
  }
} catch (e) {
  console.log(TAG + "error, passthrough: " + e);
  $done({});
}

