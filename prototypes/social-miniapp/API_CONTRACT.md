# 社交版隔离验证契约 v1

这是一个独立的开发验证项目，不是已上线的公开社区。本轮云函数部署名为 `catSocialStaging`，源目录为 `cloudfunctions/catSocial`。现有 `miniapp/`、原云函数及旧用户集合均不在修改范围。

## 数据边界与身份

- `SOCIAL_MODE=staging` 时，从 `wxContext.OPENID` 获取调用者，计算 SHA-256；仅 `SOCIAL_STAGING_OPENID_HASHES` 逗号分隔允许名单可访问测试世界。
- `identity` 仅向真实登录调用者返回自己的 `openidHash / allowed / mode / schemaVersion`，不返回 OPENID。无登录身份不能自助通过允许名单。
- 每位允许名单调用者的数据文档为 `ci_social_staging_v1/staging_<openidHash>`；同一调用者可切换两个明确标记为模拟的角色 `A`（小禾）和 `B`（阿桃）。这证明角色隔离逻辑，**不是两个真实微信账号联机的证据**。
- 云数据库集合规则必须由部署工具设置为 `{ "read": false, "write": false }`。仅服务端 SDK 可读写。源码目录中的规则文件不会自动使集合权限生效，部署后必须核验。
- 设置 `SOCIAL_ENV_ID=cloud1-d6gpjpxunc74669d7`，`mediaContext` 才能签发当前调用者的演示图片前缀。每张最大5MB、每次最多3张；客户端在选择后校验并上传新文件，不修改现有云存储权限。云端图片引用强制属于此环境和此调用者前缀，拒绝其他账号/旧档案的文件ID及路径穿越；源代码还在写入前复验云对象的可读取性、实际Buffer字节数和支持的图片文件头，待下次部署及真实云验证后方可认定已在线生效。
- 测试照片只引用独立演示资产，不扫描、不读取、不迁移当前用户猫咪/健康/目击资料。素材版权须保留原清单。
- `SOCIAL_MODE=production` 默认不可用；未显式设置 `SOCIAL_PRODUCTION_ENABLED=true` 时拒绝。真实模式不允许 `role`，使用服务端派生身份；文本经 `security.msgSecCheck` fail-closed 审核，图片在完整审核管线配置之前拒绝。本轮不得开启真实模式。
- 单世界单文档事务是有容量上限的隔离验证架构，不宣称是无限规模生产社区。上限触发明确报错，不自动删除内容/幂等记录；真实上线需要分集合事务、审核闭环、举报处置和类目核实。

## 调用与返回

```js
wx.cloud.callFunction({
  name: 'catSocialStaging',
  data: {
    action: 'commentCreate',
    role: 'A',
    requestId: 'unique-and-stable-across-retries',
    input: { postId: 'post-windowsill', text: '它有名字吗？' }
  }
})
// result: {ok:true,data:...} | {ok:false,error:{code,message}}
```

`requestId` 对所有写操作必填、最长100字符。客户端在发起写操作前生成，失败后重试必须复用，不可每次重试新建。相同用户、相同编号不同内容返回 `IDEMPOTENCY_CONFLICT`；同内容重试不重复创建帖子、评论或消息。私信会话状态持久保留，隐藏/删除会话不是删除限额。

成功读取直接返回对象；写操作返回 `{snapshot,value}`。`snapshot` 是当前操作者有权查看的最新页面数据。通常幂等重放的 `value` 为 `{id,replayed:true}`，私密原文不盲目重放；详情调用专用读接口再次进行权限检查。邀请重试在重新验证创建者权限和有效期后返回相同邀请码，私信/提醒重试按当前权限重新生成视图，均附 `replayed:true`。

## 读取动作

| action | input | 返回 |
|---|---|---|
| `health` | `{}` | schemaVersion、mode、service、是否真实消息模式；不返回用户数据 |
| `identity` | `{}` | 当前调用者的允许名单申请所需 hash；无登录拒绝 |
| `mediaContext` | `{}` | 允许名单调用者的 `{environmentId,uploadPrefix,maxPhotoBytes:5242880,maxPhotos:3}`；仅staging |
| `snapshot` | `{feed?:'discover'\|'following',cursor?:string,limit?:1..50}` | 当前用户、公开用户卡、公开猫卡、授权动态、广场分页、可见小屋、自己的会话/提醒/喜欢/关注 |
| `postDetail` | `{postId}` | 完整动态、全部评论及作者；无权限直接拒绝 |
| `roomDetail` | `{roomId}` | 成员可读内部讨论；公开目录非成员仅简介/申请状态；邀请制非成员拒绝 |
| `conversationDetail` | `{peerId}` | 当前双方会话状态、文字消息；引用按双方当前权限重新裁剪 |
| `profileDetail` | `{userId}` | 公开用户资料、公开动态、当前关注/拉黑状态 |
| `catDetail` | `{catId}` | 公开猫咪名片及主动公开关联动态，无私人健康资料 |

`snapshot.feed` 才是广场信息流，仅 `scope=public`；`snapshot.posts` 包含成员授权可见的小屋动态，不能直接当作广场。`posts` 每项包含 `author / cat / room / comments`（最多两条预览）、`commentCount / liked`；没有伪造热度。主键字段是 `id`。

```js
{
  schemaVersion: 1, revision: 2, mode: 'demo',
  me: {id:'A',nickname:'小禾',avatar:'A',bio:'...',allowStrangers:true,blockedUserIds:[]},
  users: [], cats: [], posts: [], feed: [], nextCursor: null,
  rooms: [], conversations: [], notifications: [], follows: [], likedPostIds: []
}
```

## 写动作

| action | input（省略共同 requestId） |
|---|---|
| `postCreate` | `{text,photos?:string[0..3],scope:'public'\|'room',roomId?,catId?,topic?}` |
| `commentCreate` | `{postId,text,parentId?}`，parentId 必须属于同条动态 |
| `postLike` | `{postId,liked:boolean}`，明确目标状态 |
| `userFollow` | `{userId,followed:boolean}`，明确目标状态 |
| `profileUpdate` | `{nickname?,bio?,allowStrangers?:boolean}`，不接受修改他人身份 |
| `roomCreate` | `{name,description,visibility:'public'\|'invite'}`；创建者自动为成员 |
| `roomRequestJoin` | `{roomId}`；仅公开目录小屋可申请 |
| `roomApproveJoin` | `{roomId,userId}`；仅创建者可批准 |
| `roomInvite` | `{roomId}`；仅创建者可生成，返回 `inviteCode / expiresAt`；云端随机凭证24小时有效 |
| `roomJoin` | `{inviteCode}`；必须有效，小屋成员变化后重验邀请者身份 |
| `roomLeave` | `{roomId}`；撤销当前阅读权限，创建者有其他成员时移交创建者角色；最后一位成员退出则归档小屋，不再显示在目录/接受申请 |
| `messageSend` | `{peerId,text,referencePostId?}`；只接受文字；首条招呼进入 pending，接收方回复后 open |
| `conversationIgnore` | `{peerId}`；隐藏提醒列表，保留防骚扰状态 |
| `conversationDelete` | `{peerId}`；只隐藏当前方会话，不清除等待状态 |
| `userBlock` | `{userId,blocked:boolean}`；双向禁止继续私信/互动，取消拉黑不重置招呼额度 |
| `notificationRead` | `{notificationId}`；仅本人可读，失权目标返回 `available:false` 且去掉 targetId/postId |
| `reportCreate` | `{targetType:'post'\|'comment'\|'user'\|'message',targetId,reason}`；需有查看目标权限；演示明确“不会发给真实处理人员” |
| `reset` | `{}`，顶层 requestId 必填；仅允许名单 staging 环境可重置当前调用者自己的隔离世界，生产拒绝；重试保留新数据而不再次清空 |

云端不信任 `input.actorId / input.role / input.openid / input.serverInviteCode`。客户端选择的顶层 role 仅在允许名单 staging 模式生效。

## 约束与错误

- 动态正文1–2000字符，评论1–500，私信1–1000，昵称1–30，简介0–200，小屋名称1–40，话题0–40。
- 广场发布携带 roomId 拒绝，不能暗中双向发布；小屋内容需现时成员权限。
- `FORBIDDEN / AUTH_REQUIRED / STAGING_FORBIDDEN / WAITING_REPLY / BLOCKED / STRANGERS_DISABLED / INVALID_INVITE / INVALID_PHOTOS / PHOTO_UNAVAILABLE / PHOTO_TOO_LARGE / IDEMPOTENCY_CONFLICT / LIMIT_REACHED / ROOM_CLOSED / STATE_CORRUPT / SERVICE_UNAVAILABLE` 是前端应处理的主要错误。
- 每个写动作在文档事务中验证及更新，包含同一次事务内的请求幂等记录；并发首条招呼最多一条成功。领域函数出错不修改原对象；事务失败不部分保存。
- 临时服务错误保留客户端草稿与 requestId。客户端不可把失败写入显示成云端成功。
- 本地域可使用已保存的 `wxfile://` 或微信 `tmp/usr` 路径；云端禁止把这些路径当作共享照片，会返回 `PHOTO_UPLOAD_REQUIRED`。云模式需先上传到独立演示素材存储，再提交 `cloud://` 文件标识；不能上传旧档案照片作为默认行为。
- 云上传流程：先 `mediaContext`，再将用户本次主动选择且已校验不超过5MB的图片通过 `wx.cloud.uploadFile` 写入 `uploadPrefix + 随机唯一文件名.jpg/png/webp`。文件名只含字母、数字、下划线、连字符和点，不含子目录或连续两个点。成功后提交 fileID；签名读取用 `wx.cloud.getTempFileURL`，不将存储改公开。服务端拒绝非当前owner前缀、其他环境及未登记包内素材（`PHOTO_SCOPE_FORBIDDEN`）。全部文件通过身份/路径校验后才顺序读取实际云对象；有效Buffer必须满足 `0 < byteLength <= 5242880`，并含JPEG、PNG或WebP签名头。失败不进入写事务；缺失/SDK失败/非Buffer/空文件返回 `PHOTO_UNAVAILABLE`，超过5MB返回 `PHOTO_TOO_LARGE`，不支持或截断文件头返回 `INVALID_PHOTOS`。
- 每次请求最多3张云图，顺序读取（并发1）；相同fileID仅在本请求内去重，跨请求及幂等重试会重新验证，不长期缓存校验结果。包内两张授权素材不进行云读取。服务端不会访问公网HTTP来源或旧目录，不主动删除文件或改变存储ACL。
- 当前验证是发布时点的真实字节长度及文件签名校验，不是完整图片解码、恶意内容审核、EXIF清理或不可变资产保证。已安装SDK `downloadFile` 会先把整个对象下载为Buffer，然后才能判断5MB；因此并非传输层超限即时截断。生产媒体继续禁止，真实上线仍需要有上传硬上限及审核/不可变文件策略的资产流程。
- 已登记包内素材仅 `/assets/cats/sunny-cuddle.jpg`（Griffin Taylor）和 `/assets/cats/cozy-nap.jpg`（Brett Jordan）。增加新素材必须先核实授权和本地文件，再更新此白名单。
- 隔离环境限额：300篇动态、1000条评论、100个小屋、300条举报、每会话500条私信、每次重置间1500个写操作幂等记录、最多1000条跨重置凭据；序列化云世界不超过650KB。帖子/评论达到上限不阻断其他类别的操作；全局幂等记录/字节容量仍需显式导出后重置，本轮不宣称生产无限容量或无限期安全操作保障。
- 已存在云文档但缺少合法 state 时返回 `STATE_CORRUPT`，不会以演示初始数据覆盖；已有有效数据的 snapshot 查询不写回文档。

## 文件、构建与测试

- 唯一领域源码：`domain/index.js`；纯JS、无Node特有API，`execute(state,actorId,action,input,now)` 返回 `{state,result}`，错误带 `.code`。
- 构建时机械同步为 `miniprogram/services/domain.js` 和 `cloudfunctions/catSocial/domain.js`，禁止在生成副本手工修改。
- `domain.createInitialState()` 创建虚构资料；`registerActor` 仅供生产服务鉴权后使用，不暴露客户端动作。
- `service.js` 是云契约/鉴权/审核边界；`repository.js` 提供CloudBase事务仓库与用于测试的原子内存仓库，内存仓库绝不是线上失败降级。
- `createService` 的 `readPhoto(fileID): Promise<Buffer>` 依赖仅用于已验证所属测试账号的云图片。`index.js` 绑定 `cloud.downloadFile({fileID})`，检查 `statusCode===200` 后返回 `fileContent`。证据为本机已安装 `wx-server-sdk@4.0.2` 的 `index.d.ts:187–194` 以及SDK实现 `index.js:2741–2770`；测试中注入的fixture读取不是实际云端读取证据。
- 单元测试命令：`node --test prototypes/social-miniapp/tests/domain*.cjs`。云端实测和微信开发工具A/B验收另须保存证据，不能用内存测试替代。

## 独立安全复核记录

本轮独立复核后本地领域/服务/仓库测试 **57项通过**，其中安全回归新增17项，位置 `tests/domain-security.cjs`。没有在本次复核中重新部署云函数，以下变更需要下次构建同步并部署后才能视为云端生效。

| 发现 | 修复及验证 |
|---|---|
| 云 reset 无幂等，网络重试可能删除第一次重置后产生的新数据 | 保存跨重置 receipt；同请求重放只返回最新快照；跨动作复用编号拒绝；并发4次仅1次重置、后续发帖不被旧请求清除 |
| 最后成员退出后旧 owner 残留，可能继续读取后续申请列表 | 归档空屋、清空 owner 和 pending、拒绝后续加入/详情；申请列表还必须满足当前成员身份 |
| 任一帖子或评论集合满会拦截所有动作 | 改为按增长动作检查，达到发帖/评论上限仍可拉黑、关闭陌生人招呼、举报和退出 |
| 已存在异常数据库记录会被当成“没有数据”重新初始化 | 区分文档不存在与 state 损坏，损坏明确报错、禁止覆盖 |
| 以自己为 peerId 隐藏会话可能误匹配任意已有会话 | 相同双方身份不匹配任何会话，返回不存在 |
| 猫咪卡撤回公开后仍可能嵌在历史动态里 | 动态视图只解析当前仍公开的猫卡；不返回私有卡字段 |
| 原型链携带的输入可能与幂等指纹的自有字段不一致 | 拒绝 `__proto__ / constructor / prototype` 特殊输入键，只读取自有字段；普通跨JS执行域对象仍可使用 |

额外验证：邀请在24小时的精确边界失效；邀请者退出即失效；重放邀请重新验证当前权限；退出后旧草稿的私屋引用/评论仍拒绝；更改私信收件人或引用却复用 requestId 拒绝；第三方不能读取/举报他人私信；两位模拟角色的请求幂等编号各自隔离；陌生人首条招呼、删会话、拉黑/解除后均不可绕过等待状态。

客户端审计建议已交给主负责者：保存/上传照片期间若切换模式或角色，异步结果返回前必须再次确认上下文；旧结果不得写入新角色草稿。本文件不将建议视为已修复证据，应以适配层测试/代码为准。仍待用户授权后的微信实际云调用与A/B界面验收，不能把这些本地测试说成真实双账号联机已通过。

### 服务端照片复验补项（2026-09-29）

新增 `tests/domain-media-verification.cjs` 的14项校验，本地域/服务/仓库累计 **71项通过**。测试包括已授权JPEG fixture、PNG/WebP签名头、两种包内素材免下载、越权/错环境/旧目录在任何读取之前拒绝、最多3图且串行、重复ID本请求去重、文件不存在与SDK错误脱敏、空文件/非Buffer、扩展名伪装、5MB精确边界、后一张失败不部分写入、跨请求/重试重新读取，以及云入口真实代码与注入SDK返回结构的绑定。

这些是源码和本地依赖注入测试，未进行实际云文件下载、微信上传端到端或部署，不是云端A/B已通过。下次部署后必须使用获授权微信账号本次主动选择的测试图片，核验上传—服务端复验—发布—签名查看全链路。
