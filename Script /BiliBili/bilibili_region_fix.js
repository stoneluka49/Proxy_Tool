/*
 * v2: Loon 的 $httpClient timeout 单位是毫秒, 之前写 10 实际只有 10ms 导致必然超时。
 * Bilibili 国际版 3.20.1 「分区」页 网络错误 修复 (Loon http-response 脚本)
 *
 * 原因: App 请求 https://app.bilibili.com/x/v2/channel/region/list 时,
 *       服务器直接返回 404 (openresty), 与 Loon 无关。
 * 做法: 仅当该接口返回 404 时介入, 依次尝试:
 *       1) 同一路径换到 app.biliapi.net (国际站网关)
 *       2) 改用仍然正常的 /x/v2/region/index (签名只与参数有关, 与路径无关, 可复用)
 *       成功后把响应改成 200 + 分区 JSON, 接口恢复正常时脚本不会改动任何内容。
 */

// ===== 可自行修改 =====
// 国际版 3.20.1 不识别 bilibili://pgc/bangumi、bilibili://pgc/domestic, 点击后没有任何反应
// (抓包显示它的首页标签里也没有番剧入口)。
// MODE: "region" = 番剧/国创 改成 App 原生的分区页 bilibili://region/<tid> (默认, 与 剧情 的打开方式相同)
//       "web"    = 改成网页链接 (在内置浏览器打开)
//       "remove" = 直接删除打不开的入口
//       "off"    = 不处理, 原样返回
const MODE = "region";
// 想自己试其它跳转地址时, 在这里填(优先级最高), 例如 13: "bilibili://pgc/home"
const URI_OVERRIDE = {
  // 13: "",   // 番剧
  // 167: "",  // 国创
};
const WEB_URLS = {
  13: "https://www.bilibili.com/anime/",
  167: "https://www.bilibili.com/guochuang/",
};
// 没有 uri 的入口 (如 剧情 tid=85) 补成 bilibili://region/<tid>
// =====================
const TAG = "[BiliRegionFix] ";
const log = (...a) => console.log(TAG + a.join(" "));

const status = $response.status || $response.statusCode;
if (Number(status) !== 404) {
  $done({});
} else {
  run();
}

function run() {
  const url = $request.url;
  const q = url.indexOf("?") >= 0 ? url.substring(url.indexOf("?")) : "";

  // 复制原请求头, 去掉会导致冲突的字段
  const headers = {};
  Object.keys($request.headers || {}).forEach((k) => {
    const lk = k.toLowerCase();
    if (["host", "content-length", "accept-encoding", "connection", ":authority", ":path", ":method", ":scheme"].includes(lk)) return;
    headers[k] = $request.headers[k];
  });

  // 给 region/index 的结果补充常见别名字段, 提高兼容性
  const adapt = (json) => {
    const fix = (it) => {
      if (!it || typeof it !== "object") return it;
      if (it.id === undefined && it.tid !== undefined) it.id = it.tid;
      if (it.icon === undefined && it.logo !== undefined) it.icon = it.logo;
      if (Array.isArray(it.children)) it.children = it.children.map(fix);
      return it;
    };
    if (Array.isArray(json.data)) {
      json.data = json.data.map(fix);
      if (MODE !== "off") {
        const out = [];
        json.data.forEach((it) => {
          const uri = it.uri || "";
          const dead = uri.indexOf("bilibili://pgc/") === 0;
          if (dead) {
            if (MODE === "remove") return;
            if (URI_OVERRIDE[it.tid]) {
              it.uri = URI_OVERRIDE[it.tid];
            } else if (MODE === "web" && WEB_URLS[it.tid]) {
              it.uri = WEB_URLS[it.tid];
            } else {
              it.uri = "bilibili://region/" + it.tid;
            }
            it.type = 0;
            it.is_bangumi = 0;
          } else if (!uri && it.tid !== undefined) {
            if (MODE === "remove") return;
            it.uri = "bilibili://region/" + it.tid;
          }
          out.push(it);
        });
        json.data = out;
      }
    }
    return json;
  };

  const candidates = [
    { name: "app.biliapi.net 同路径", url: "https://app.biliapi.net/x/v2/channel/region/list" + q, adapt: null },
    { name: "region/index 回退", url: "https://app.bilibili.com/x/v2/region/index" + q, adapt: adapt },
  ];

  let i = 0;
  const next = () => {
    if (i >= candidates.length) {
      log("所有方案均失败, 保持原 404 响应");
      return $done({});
    }
    const c = candidates[i++];
    log("尝试:", c.name);
    $httpClient.get({ url: c.url, headers: headers, timeout: 6000 }, (err, resp, data) => {
      if (err || !resp || Number(resp.status || resp.statusCode) !== 200) {
        log("失败:", c.name, err || (resp && (resp.status || resp.statusCode)));
        return next();
      }
      let json;
      try {
        json = JSON.parse(data);
      } catch (e) {
        log("非 JSON:", c.name);
        return next();
      }
      if (json.code !== 0 || !Array.isArray(json.data) || json.data.length === 0) {
        log("返回内容无效:", c.name, (data || "").substring(0, 150));
        return next();
      }
      if (c.adapt) json = c.adapt(json);
      const body = JSON.stringify(json);
      log("成功:", c.name, "条目数", json.data.length);
      $done({
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: body,
      });
    });
  };
  next();
}
