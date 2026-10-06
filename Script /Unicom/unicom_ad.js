/*
 * 中国联通 App (iphone_c@12.01) 去广告脚本
 * 依据抓包文件分析生成，处理 m.client.10010.com 下的广告/营销接口
 * 兼容 Loon / Surge / Quantumult X / Shadowrocket
 */
const url = $request.url;
let body = $response.body;
let obj;
try { obj = JSON.parse(body); } catch (e) { $done({}); }

// 1. 首页弹窗（截图中的 HUAWEI Mate 90 弹窗）
if (/mobileService\/activity\/homePopUpActivityNew\.htm/.test(url)) {
  obj = { status: "0000", msg: "成功",
    data: { popData: null, bannerPopData: null, popType: "0", qkActId: null, extendInfo: null, productH5Url: null } };

// 2. 开屏广告：账户列表接口里夹带的 startup_adv
} else if (/mobileService\/customer\/accountListData\.htm/.test(url)) {
  if (obj.adv) {
    for (const k of Object.keys(obj.adv)) {
      if (obj.adv[k] && Array.isArray(obj.adv[k].advCntList)) obj.adv[k].advCntList = [];
    }
  }

// 3. 首页顶部主题背景/Banner（华为新品主题日）
} else if (/clientIndex\/homefusion\/fuInter/.test(url)) {
  if (obj["HomeFusion.backGroundQuery"]) obj["HomeFusion.backGroundQuery"].result = [];

// 4. 首页信息流（机型推荐、套餐升档、宽带、权益超市等）
} else if (/clientIndex\/api\/v1\/index\/queryIndexWaterfall/.test(url)) {
  if (obj.data && obj.data.liuCeDto) { obj.data.liuCeDto.pageList = []; obj.data.liuCeDto.totalPages = 0; }

// 5. 首页 OMO 推荐位（会员月月领/套餐升档/魔方/语音特惠）
} else if (/clientIndex\/api\/v1\/index\/queryOMO\//.test(url)) {
  if (obj.data) obj.data.listOMOInfo = [];

// 6. 新人专享 / 热销靓号 / 宽带升级
} else if (/clientIndex\/api\/v1\/index\/queryIndexExclusiveOffers/.test(url)) {
  if (obj.data) { obj.data.left = []; obj.data.right = []; obj.data.largeMarket = []; }

// 7. 服务页营销位
} else if (/homeService\/getServiceHomeMarketingBits/.test(url)) {
  if (obj.data) { obj.data.topList = []; obj.data.bottomList = []; obj.data.hiddenTop = true; obj.data.hiddenBottom = true; }

// 8. "服务提醒" 整个模块：返回失败码 + data=null，客户端会整块不渲染
//    （data 为 {} 时 App 仍会画出空的提醒框，所以不能用空对象）
} else if (/clientIndex\/v1\/api\/serviceReminder/.test(url)) {
  obj = { code: "9999", data: null, desc: "fail" };

// 9. 搜索框轮播推广词（如"副卡0元领"）
} else if (/getDataFromService\?.*methodType=searchScroll/.test(url)) {
  for (const k of Object.keys(obj)) if (Array.isArray(obj[k])) obj[k] = [];

// 10. 517 活动浮层
} else if (/clientIndex\/v1\/api\/query517Active/.test(url)) {
  obj = { code: "0000", data: { carouselFlag: false, central: [], homeShowFlag: false, myShowFlag: false, searchShowFlag: false, top: [] }, desc: "success" };
}

$done({ body: JSON.stringify(obj) });
