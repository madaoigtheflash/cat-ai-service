# 对话收敛版设计收尾记录 · 2026-09-30

## 结论与边界

这是既有粉色对话功能框架的扩展，不是新品牌或新视觉世界。依据 [BRIEF.md](BRIEF.md)、项目 `PRODUCT.md`、`DESIGN.md` 及 `cat-miniapp-ui` 规范，核对首页、我的数据、本机地图的当前源码和最终七张模拟器截图。

本记录遵循 impeccable document 的“从实际实现提取、不凭空建立规则、不得静默覆盖既有系统”原则。用户未授权重写全局设计系统，因此 **保留根目录 `DESIGN.md` 与 `.impeccable/design.json`，不刷新或生成 sidecar**；下列页面局部值不升级为新的全局规范。

## 继承与页面局部调整

| 范围 | 当前实现与规范的对应 |
|---|---|
| 中文字体 | 三页继承 `miniapp/app.wxss` 的 `-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`，未引入远程字体。正文采用 27–28rpx、辅助说明 23–24rpx；数据与地图大标题为 42rpx/700/1.35。首页邀请标题局部收紧为 40rpx/700/1.4，角色名为 30rpx/600；未使用分数字重。 |
| 色彩与层次 | 延续 `#FFF7FA` 页面底、白色卡片、`#FFF0F5` 柔粉表面、`#3E2D35` 主文字和 `#6F5A64` 正文。首页确认/发送与数据页选中态使用既有樱花变体的深玫红 `#B94768`；全局主按钮继续使用原粉色渐变。不是所有卡片都使用高饱和填充。 |
| 局部色值 | 首页普通操作文字 `#91415D`、输入/确认卡边框 `#E7CBD6`、用户气泡 `#FBE5EE` 及状态提示底色属于此页实现值。数据/地图错误与警告沿用 `#B94955` / `#A66A20`；首页失败提示使用局部暖色 `#844B20` / `#FFF0E0`。这些只作实现记录，不宣称已收敛为全局 token。 |
| 卡片与排版 | 数据/地图复用全局 `.page` 的 32rpx 横向留白及 `.card` 的 30rpx 内距、28rpx 圆角、粉灰细边框与单层轻阴影。首页改为对话滚动区和独立输入区：对话横向 28rpx、确认卡内距/圆角 24rpx；没有新增插画层覆盖文字。 |
| 自然换行 | 首页角色标题、输入框，数据行文本和地图行文本均使用 `min-width: 0`；消息、错误、说明和记录文本配置自然换行/`word-break`，未给重要正文设置固定高度或单行省略。确认操作可换行排列。输入框 `auto-height`，局部最大高度为 200rpx；其超长输入体验未在截图中穷尽。 |
| 88rpx 触控 | 首页按钮基类和输入框 `min-height: 88rpx`，历史按钮宽度 88rpx，发送按钮宽度 112rpx，确认字段/选择器 `min-height: 96rpx`。数据页分类按钮 88rpx、统计按钮 144rpx、档案行 120rpx、入口行 104rpx；地图记录行 104rpx，其余操作继承全局 88rpx 主/次按钮。图标自身大小不被当作触控区域。此为源码下限核对，不是全部控件的实机命中区域测量。 |
| 安全区与键盘 | 数据/地图保留 `calc(112rpx + env(safe-area-inset-bottom))` 底部留白。首页用 `100vh - 120rpx - env(safe-area-inset-bottom) - keyboardHeight` 分配可用高度，输入区不随对话内容滚动；既有自定义 Tab Bar 含安全区 padding。键盘高度非零时局部隐藏角色行、快捷操作和模式切换，保留输入/发送；只验证过 290px 的 handler 模拟状态。 |
| 安全与范围提示 | 首页明确“虚拟猫”“本地引导 · 固定规则，不是自由对话”，确认卡同时提供保存和暂不登记，提示本机存储、不自动上传/分享。数据页区分历史回执与当前记录；地图说明约 2 公里粗区域且不表示实时位置。医疗提示仍为独立正文，未游戏化或隐藏为微标签。 |

源码对应：`miniapp/app.wxss`、`miniapp/custom-tab-bar/index.wxss`，以及 `miniapp/pages/home/`、`miniapp/pages/companion-data/`、`miniapp/pages/companion-map/` 下的 `index.wxml`、`index.wxss`、`index.js`。三页未整体启用 `.sakura-theme`，而是继承基础样式并复用部分既有樱花配色。

## 可见验证证据

已逐张打开 [previews](previews/) 中 01–07 的最终截图，环境由 [native-report.json](previews/native-report.json) 记录为微信开发者工具 **390×753、fontSizeSetting=16**：

- `01-home-empty`：虚拟身份、本地规则说明、输入/发送与底部导航可见。
- `02-confirm-cat`、`03-relationship`：确认字段、保存/暂不登记及关系方向说明在各自截图中可见。
- `04-history`：本机数据范围、分类和确认回执的历史属性可见；不是全历史列表的逐屏检查。
- `05-map`：原生地图、模糊区域提示及所选记录可见；文字列表仅见入口，不据此宣称其完整滚动状态通过。
- `06-keyboard-height-simulated`：290px 键盘高度状态下输入/发送仍可见；截图没有实体键盘。
- `07-message-failure-recovery`：注入消息写入失败后，确认/取消、原输入和失败说明可见；不代表生产事故。

独立 finish review 的最终 verdict 为 **ship**，仅涵盖已报告的两条修复和已检查开发视口；具体回归与编译记录见 [VALIDATION.md](VALIDATION.md)。本文件不把该结论扩展为全设备、全状态或生产发布通过。

## 素材与未验证项

无新增 shipping raster。界面复用 `miniapp/components/icon/` 的既有 SVG 图标和 `miniapp/assets/tabbar/` 的现有导航位图；地图 marker 复用 `archive-selected.png`。用户选择的照片是运行时内容，不是本轮新增的设计素材。01–07 截图是合成测试数据的验证证据，不作为产品图片交付，也不据此创建新的素材来源声明。

**尚未验证：**320/375/430px 视口、系统大字号、实体手机键盘、所有长文本及完整滚动状态、真机安全区表现。源码中的窄屏媒体查询和安全区处理仅证明存在适配实现，不证明上述环境已经通过。实际相机/位置权限、真实云端服务和线上发布也不在本设计检查结论内。
