/*
 * Bilibili: 修正 UPOS 节点返回的内部 302 (例如 upos-sz-estghw -> zzNN.yirujs.com)
 * Loon http-response 脚本, 不需要 MITM (视频流是 http)。
 *
 * 抓包确认: 请求 http://upos-sz-estghw.bilivideo.com/upgcxcode/... 时, 青岛联通缓存节点
 *   直接返回 302, Location 指向 http://zzNN.yirujs.com/upgcxcode/... (查询参数原样保留),
 *   App 再去请求 yirujs 节点 (中国移动·郑州)。
 *
 * 做法: 只在 301/302/307/308 且 Location 的主机是 *.yirujs.com 时, 把主机换成 TARGET_HOST,
 *       路径和全部查询参数原样保留, 状态码保持 302。其它响应一律不动。
 */
const TAG = "[BiliFix302] ";
const TARGET_HOST = "upos-sz-mirrorcos.bilivideo.com";   // 想换别的节点改这里
const MATCH = /^(https?):\/\/[a-zA-Z0-9-]+\.yirujs\.com(?::\d+)?(\/(?:v1\/resource\/)?upgcxcode\/.+)$/i;

try {
  const status = Number($response.status || $response.statusCode);
  if ([301, 302, 307, 308].indexOf(status) < 0) { $done({}); }
  else {
    const headers = Object.assign({}, $response.headers);
    let key = null;
    Object.keys(headers).forEach((k) => { if (k.toLowerCase() === "location") key = k; });
    const m = key && MATCH.exec(headers[key]);
    if (!m) { $done({}); }
    else {
      headers[key] = m[1] + "://" + TARGET_HOST + m[2].replace(/^\/v1\/resource/, "");
      console.log(TAG + "Location -> " + TARGET_HOST);
      $done({ status: status, headers: headers });
    }
  }
} catch (e) {
  console.log(TAG + "error, passthrough: " + e);
  $done({});
}

