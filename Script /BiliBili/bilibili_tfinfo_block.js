
/*
 * Bilibili 国际版: 去除播放页右下角「我要免流 / B站大会员+15G专属流量 / 首月低至1分钱」推广
 *
 * 来源 (抓包确认): gRPC 接口 bilibili.app.view.v1.View/TFInfo
 *   返回内容: 我要免流 + https://www.bilibili.com/blackboard/activity-new-freedata.html
 *   播放视频时被反复调用 (走 grpc.biliapi.net / app.bilibili.com / app.biliapi.com / app.biliapi.net)
 *
 * 做法: 把响应体替换成"空的 gRPC 消息" (5 字节: 00 00 00 00 00), grpc-status 保持 0。
 *       App 解析到的是默认值 -> 不显示推广。
 * 需要 binary-body-mode=true。
 */
const TAG = "[BiliTFInfo] ";
try {
  const empty = new Uint8Array([0, 0, 0, 0, 0]);
  const headers = {
    "Content-Type": "application/grpc",
    "grpc-status": "0",
    "grpc-message": "",
  };
  console.log(TAG + "replace TFInfo response with empty gRPC message");
  $done({ status: 200, headers: headers, body: empty });
} catch (e) {
  console.log(TAG + "error " + e);
  $done({});
}
