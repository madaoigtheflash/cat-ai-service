# 微信云开发部署与验证

小程序绑定 CloudBase 环境 `cloud1-d6gpjpxunc74669d7`，AppID 为 `wx1112379224ace9f9`。当前代码包含四个云函数入口和一条独立模型路径：

- `askKnowledge` / `identifyCat`：MiniMax 知识问答和品种外观辅助识别；
- `catOnlineV2`：邀请制猫友小屋、本地档案映射、受控照片上传、人工审核、猫际关系投票、粗粒度分布地图，以及仅面向本人状态的用户反馈；
- `catIdentity`：已审核目击的同猫候选、人工确认、撤销，以及已关联猫咪的显式模板登记；
- `services/reid-service/`：独立 Re-ID Worker，只计算向量和候选排序，不写业务库，也不决定身份合并。

本地健康档案、疫苗、驱虫、体重、就医记录和设备内的私有猫际角色卡仍只保存在设备中。联机只同步昵称、品种、性别、花色、估算年龄等公开最小字段；社区有向观察投票是独立的云端数据，不会上传或覆盖本地私有角色卡。完整字段、不变量、v1 兼容和上线门槛见 [`猫际有向关系云端契约-v2.md`](./猫际有向关系云端契约-v2.md)。

> 代码更新、数据库建表、索引、权限、函数部署和小程序上传是不同步骤。部署后仍须按本文核对实际云环境，不能仅凭仓库代码断言控制台配置已经生效。

## 1. 云函数与环境变量

云函数建议使用当前 CloudBase 支持的 Node.js LTS、60 秒、512 MB，并选择“云端安装依赖”。`catOnlineV2` 因使用 Sharp 0.35.x 做服务端图片重编码，固定使用 Node.js 20.19；其他现有函数仍可在已验证的 Node.js 16.13 运行，后续升级须单独回归。

| 函数 | 必需环境变量 | 说明 |
| --- | --- | --- |
| `askKnowledge` | `MINIMAX_API_KEY`、`MINIMAX_MODEL=MiniMax-M3` | Key 只存云端 |
| `identifyCat` | 上述两项、`IDENTIFY_UPLOAD_SECRET` | 专用于品种识别上传会话的随机密钥 |
| `catOnlineV2` | `CAT_ONLINE_OWNER_SECRET`、`CAT_ONLINE_OWNER_KEY_VERSION=v1` | 至少 32 字节随机密钥，用于不可逆用户标识、确定性 ID 和位置网格 ID |
| `catIdentity` | `CAT_ONLINE_OWNER_SECRET`、`CAT_ONLINE_OWNER_KEY_VERSION=v1` | 必须与 `catOnlineV2` 完全一致 |
| `catIdentity`（模型路径） | `REID_WORKER_URL`、`REID_WORKER_HMAC_SECRET` | 仅在真实 Worker 部署后配置；未配置时必须失败关闭，不能伪装为已完成识别 |

`IDENTIFY_UPLOAD_SECRET`、`CAT_ONLINE_OWNER_SECRET` 与 `REID_WORKER_HMAC_SECRET` 应分别生成，不能复用 MiniMax Key，也不要写入源码、文档、截图或聊天记录。仓库根目录 `cloudbaserc.json` 只保留 `{{env.NAME}}` 占位符。

`catIdentity.health` 中的 `workerConfigured` 是模型链路是否可用的直接检查项。只有它为 `true`，且 Worker `/ready`、模型契约和端到端测试全部通过后，才能在产品文案中称“云端同猫候选可用”。

## 2. 数据库集合、权限与索引

环境 `cloud1-d6gpjpxunc74669d7` 现有 19 个集合，其中 `ci_app_admins` 是停用的旧版遗留集合。新环境部署或灾备恢复只需重建以下 18 个活动集合：

```text
ci_identify_upload_sessions
ci_users_private
ci_communities
ci_members
ci_user_pet_links
ci_upload_sessions
ci_assets
ci_sightings_private
ci_sightings_public
ci_identity_jobs
ci_identity_templates
ci_identity_assignments
ci_identity_feedback
ci_cat_identities
ci_relationship_edges
ci_relationship_votes
ci_feedback
ci_change_proposals
```

所有活动 `ci_*` 集合均应设为 `ADMINONLY`，等价目标是客户端 `read: false, write: false`。现有环境可保留同样为 `ADMINONLY` 的 `ci_app_admins` 以便审计，但小程序、云函数和本地管理台均不读取或写入它。小程序页面只能通过云函数读取经过登录、成员权限和字段过滤后的安全投影。OpenID、ownerKey、原始 fileID、精确坐标、`locationGeo`、embedding、原始余弦分数、内部阈值和 Worker 签名均不得返回客户端。每次迁移和上线前仍要重新验收权限，避免后续控制台操作造成漂移。

至少建立以下索引：

| 集合 | 字段 | 类型 | 建议名称 |
| --- | --- | --- | --- |
| `ci_communities` | `inviteHash` | 唯一 | `uniq_invite_hash` |
| `ci_members` | `communityId, ownerKey` | 联合唯一 | `uniq_community_owner` |
| `ci_user_pet_links` | `communityId, ownerKey, localPetId` | 联合唯一 | `uniq_community_owner_localpet` |
| `ci_identity_templates` | `communityId, state, modelVersion, modelSha256, preprocessVersion, cropVersion, embeddingEncoding, embeddingDimension` | 组合 | `idx_identity_template_contract` |
| `ci_identity_templates` | `communityId, catId, state` | 组合 | `idx_identity_template_dependency` |
| `ci_identity_assignments` | `sightingId, state` | 组合 | `idx_sighting_assignment_state` |
| `ci_identity_assignments` | `communityId, catId, state` | 组合 | `idx_identity_assignment_dependency` |
| `ci_cat_identities` | `state, revocationExpiresAt` | 组合 | `idx_identity_revocation_lease` |
| `ci_relationship_edges` | `communityId, directionKey` | 联合唯一 | `uniq_relationship_direction_key` |
| `ci_relationship_edges` | `communityId, state` | 组合 | `idx_relationship_state` |
| `ci_relationship_edges` | `communityId, state, catAId` | 组合 | `idx_relationship_active_cat_a` |
| `ci_relationship_edges` | `communityId, state, catBId` | 组合 | `idx_relationship_active_cat_b` |
| `ci_relationship_votes` | `communityId, edgeId, ownerKey` | 联合唯一 | `uniq_relationship_voter` |
| `ci_relationship_votes` | `communityId, ownerKey` | 组合 | `idx_relationship_owner` |
| `ci_sightings_private` | `locationGeo` | `2dsphere` 地理索引 | `idx_sighting_location_geo` |
| `ci_sightings_public` | `communityId, state, reviewedAt`（降序） | 组合 | `idx_sighting_public_recent` |
| `ci_feedback` | `ownerKey, createdAt`（降序） | 组合 | `idx_feedback_owner_created` |
| `ci_change_proposals` | `generatedAt`（降序） | 普通 | `idx_change_proposal_generated` |

v2 将 `catAId` 固定为 `fromCatId`、`catBId` 固定为 `toCatId`，端点不得排序；服务端同时生成 `directionKey=fromCatId::toCatId`，因此 `A → B` 与 `B → A` 是两条独立关系边。legacy 边使用 `directionKey=legacy::<edgeId>`，保证所有文档都有非空唯一键且不会占用 v2 方向。每位成员对每条有向边只有一条投票记录；重复提交是幂等的，改票会在事务内扣减旧选项并增加新选项。代码中的确定性文档 ID 和事务是第一层防重，唯一索引是并发下的第二层保护。

旧索引 `uniq_relationship_pair(communityId, catAId, catBId)` 会让 v1 边与其中一个 v2 方向冲突，必须在启用 v2 写入前替换为 `uniq_relationship_direction_key(communityId, directionKey)`。先统计并备份两张关系集合，为所有现存边回填正确的 `directionKey`，创建并验证新索引后再删除旧索引；不能只部署函数而保留旧唯一索引。

上述两个关系集合、六个关系索引以及 `idx_sighting_location_geo` 都必须在实际环境核对。`ci_sightings_private.locationGeo` 使用 `db.Geo.Point` 保存精确坐标；当前粗网格列表不依赖地理查询，但保留该 `2dsphere` 索引供后续 `$geoNear` 范围检索使用。启用范围查询前仍要在测试环境验证查询计划，不能用普通升序索引代替。

创建后逐个验证：

1. 集合存在，且权限为 `ADMINONLY`；
2. 上述六个关系索引和 `idx_sighting_location_geo` 均可见；所有边都有非空 `directionKey`，`uniq_relationship_direction_key` 拒绝同方向重复键，但允许 `A → B`、`B → A` 与 legacy 边共存；
3. 已登录小程序直接使用数据库 SDK 读取或写入任意 `ci_*` 集合都会被拒绝；
4. 只有云函数能返回经过裁剪的数据。

反馈、Codex 只读审计、本机确认执行和失败恢复见[《用户反馈、Codex 审计与本地执行工作流》](./用户反馈与Codex审批工作流.md)。小程序没有管理员模式，只能提交反馈并查看本人的处理阶段。

## 3. 本地档案与云端身份链

身份关联必须沿用下面的稳定链路，禁止用猫名、品种或照片文件名直接匹配：

```text
localPetId（设备本地档案）
  → remotePetId（ci_user_pet_links 中的用户/小屋映射）
  → catId（ci_cat_identities 中的规范猫身份）
  → sighting / identity template / relationship edge
```

- `localPetId` 是设备档案的稳定 ID；删除本地档案时，本地映射缓存一并移除。
- `remotePetId` 由 `communityId + ownerKey + localPetId` 确定性生成，是某位用户在某个小屋中的档案链接。同步只发送公开最小字段和 `syncFingerprint`。
- `catId` 是社区内关系、目击和 Re-ID 模板统一引用的身份 ID。首次同步时通常等于 `remotePetId`，之后由 `ci_cat_identities` 保持规范身份；客户端必须以服务端返回值为准。
- 本地映射缓存保存 `communityId`、`localPetId`、`remotePetId`、`catId`、`serverVersion`、`syncedFingerprint` 和 `syncedAt`，用于显示“已同步/待同步/已变更”，不能把同名猫自动视为同一只。
- 所有云端猫际关系边只能使用 `catId`。身份以后若发生经人工确认的规范化，必须通过显式迁移维护引用一致性，不能在客户端临时改名或猜测映射。
- 删除设备内档案会立即清除本地映射缓存，但不会擅自删除已被小屋成员共同引用的云端规范身份、目击和关系证据。云端解除关联/停用需要独立的 owner 操作与引用检查，当前版本尚未开放该入口。

验收时至少准备两个名称相同但 `localPetId` 不同的档案，确认它们得到不同 `remotePetId/catId`；再修改其中一只的公开字段，确认只更新对应映射和 `serverVersion`，健康记录从未出现在云端。

## 4. 猫际关系投票与热力分布

云端关系投票只表达某一箭头方向上可观察到的互动，不推断血缘，也不等同于本机的母亲、孩子或照护者角色卡。当前选项为：

```text
bonded        亲密搭子
playmate      玩伴
housemate     同住/常见
needs_space   需要空间
unsure        暂不确定
```

每条关系边只保存聚合计数和必要的猫咪安全投影，每位成员的具体选择单独保存在 `ci_relationship_votes`。`A → B` 与 `B → A` 分开建边、分开投票和分开聚合。任何角色（包括 owner/admin/reviewer）在自己投票前都看不到选项分布；投票后才可查看聚合结果。这个“先投后看”规则在云函数与前端双重执行，用于减少从众偏差；聚合并列时必须显示“意见并列”。

当前证据目击尚未开放：单猫目击流程没有稳定生成同时包含两个规范 `catId` 的 `observedCatIds`，页面也没有证据选择器，因此客户端必须提交空的 `evidenceSightingIds`，非空列表应明确拒绝。未来只有在多猫目击录入、审核、身份规范化、权限和撤回流程全部完成后，才可开放最多 3 条证据。家庭/血缘不属于普通互动投票，应保留在私有角色卡或更高门槛的人工资料中。

关系端点必须先解析为当前小屋的规范 `catId`；规范化后两端相同、身份撤销中、端点缺失或边为 `needs_review` 时必须拒绝投票。猫、关系和本人投票达到查询上限时，接口必须分页或分别返回准确的截断标志，尤其不能把被截断的本人票误判为“尚未投票”。

“热力图”当前是云函数对最近最多 100 条已审核目击做粗网格聚合，返回每格目击数、猫数量、最多四个名字和最近 6 小时时间桶。小程序用地图圆圈/标记表达热度；它不是精确轨迹，也不是单只猫的实时定位。结果最多返回 80 个网格，超过取样上限时页面会明确标记“数据不完整”。后续数据量增大时应改成服务端增量计数器、时间窗口和分页/聚类。

## 5. 位置、地图与微信隐私配置

位置是可选项，页面只能在用户主动点击后调用 `wx.chooseLocation`，不得在页面加载时自动定位。`miniapp/app.json` 必须保留：

```json
{
  "permission": {
    "scope.userLocation": {
      "desc": "用于主动选择猫咪目击地点，审核后仅展示约2公里模糊热区"
    }
  },
  "requiredPrivateInfos": ["chooseLocation"]
}
```

坐标从采集到展示统一使用 GCJ-02：

- 精确坐标、精度和来源只写入 `ci_sightings_private.exactLocation`，同时以 `locationGeo` 的 `Geo.Point` 形式保存，`visibility` 固定为 `private`；
- 用户填写的地点文字保存为私有 `privateAreaText`，仅在待审核阶段返回给上传者和有审核权限的管理员；`wx.chooseLocation` 返回的 POI 名称/地址只在当前页面本地确认，不上传；
- 公开目击只保留约 `0.02°`、标称约 2 km 的网格中心、HMAC 化 `cellId` 和时间桶，不保留或返回自由文本地点；
- `ci_sightings_public`、`listWorkspace`、`listCommunityInsights`、日志和错误响应都不得出现精确坐标；
- 用户只填写地点文字而未选择坐标时，不生成地图圆圈；拒绝授权不影响上传照片和其他离线功能；
- 粗网格不是严格的 2 km 匿名保证，纬度和样本稀疏仍可能降低隐私。开放注册前仍需做稀疏格抑制、敏感地点保护和举报/删除机制。

小程序管理后台还需按实际上线类目申报位置用途和隐私保护指引；开发版可调用不代表审核版已获得许可。

## 6. 云存储规则

受控路径为：

```text
identify-pending/{opaqueOwner}/{uploadId}/source.ext
identity-pending/{opaqueOwner}/{uploadId}/source.ext
identity-approved/sightings/{sightingId}/{sha256}.ext
```

客户端只允许登录用户在云函数刚签发的 pending 路径执行创建；禁止覆盖、列目录和读取其他用户 pending 文件。`identity-approved/**` 必须禁止客户端直接读写，只能由云函数生成并换取短时 URL。后端还会重新核对可信 OpenID、上传会话、完整路径、过期时间、字节数和 MIME 魔数，不能只信任前端传来的 fileID。

`catOnlineV2` 会重新校验字节数、MIME 魔数和 SHA-256，再用 Sharp 自动旋转、限制最长边 1600px、扁平化并重新编码为 JPEG；不复制元数据，因此公开副本不含原始 EXIF/GPS。旧版生成且没有 `sanitized=true` 的 approved 资源默认不返回成员端，须由审核者重新处理后才恢复展示。当前仍未做人脸、车牌、门牌遮挡，也未接入内容安全回调，因此只适合互信用户的封闭邀请测试；开放注册前必须补齐内容审核、隐私遮挡、举报与隔离流程。

`identify-pending/**` 和 `identity-pending/**` 必须在 CloudBase/COS 配置存储生命周期（建议上限 24 小时），并配套清理过期上传会话。控制台未验证前，不能声称孤儿文件会自动删除。审核通过的 `identity-approved/**` 不应套用该短周期规则。

客户端为“创建小屋/上传目击”保留稳定幂等键。本地重试记录只存表单指纹哈希、幂等键、社区 ID、上传会话 ID 和时间戳，不存说明文字、地点或临时图片路径。如果提交后响应丢失，下次 `bootstrap` 会调用 `recoverSighting`，以可信 OpenID、幂等键和上传会话查回已入库结果。

## 7. 同猫候选与显式模板登记

两条流程必须分开：

1. **未关联目击**：审核通过后可调用 `startMatch`，Worker 返回 Top-K 候选，最终只能由用户选择“同一只 / 新猫 / 看不清”；
2. **已关联目击**：照片在上传时绑定 `localPetId → remotePetId → catId`，审核通过后，所属用户主动点击登记，调用 `enrollLinkedSighting` 为该 `catId` 创建版本化模板。

`enrollLinkedSighting` 会再次校验小屋成员、目击归属、审核状态、资源状态、链接猫和身份文档，并使用确定性模板 ID 保证重复点击幂等。模板身份同时绑定 `modelVersion + modelSha256 + preprocessVersion + cropVersion + embeddingEncoding + embeddingDimension`，任何一项不同都不能复用。重复登记不会重跑 Worker，而是在事务中自愈私有/公开目击的 `identityTemplateReady` 投影；旧模板缺少 `enrollmentRequestHash` 时可按同一目击、猫身份和完整版本契约补写，已有非空哈希不一致则必须冲突退出。只有真实 Worker 可用且模型契约完全匹配时才写入模板；未配置 Worker、stub Worker 或契约不一致都必须返回明确错误，不能生成伪 embedding。

撤销由任务创建的新规范猫身份时，`catIdentity` 先把身份置为带 5 分钟租约的 `revoking`，阻止新的确认和关系投票，再通过 `idx_relationship_active_cat_a` / `idx_relationship_active_cat_b` 在事务外批量把仍引用该身份的活动关系边改为 `needs_review` 并写入审计元数据，最后用短事务完成身份、归属和模板撤销。这样既避开 CloudBase 事务不支持 `where/skip` 和事务操作数限制，也不会留下仍为 `active` 的孤儿关系边。

若 edge sweep 后最终事务失败，补偿流程先用 CAS 旋转 `revocationToken`，再分别复用 `idx_relationship_active_cat_a` / `idx_relationship_active_cat_b` 分页读取 `needs_review` 端点；代码只恢复同时满足 `needsReviewSourceTaskId == taskId`、`needsReviewCatId == identityId` 且 `identityReviewAudit.previousState == active` 的边，并在逐文档事务中再次核对后更新，最后恢复身份。其他人工或其他任务产生的 `needs_review` 绝不改动，也无需新增回滚专用组合索引。若进程被强制终止，后续任一 `catIdentity` 调用会通过 `idx_identity_revocation_lease` 续跑同一补偿。任何补偿步骤再次失败都会保留 `revoking`，避免身份先恢复而关系边永久漂移。

无论候选分数多高，系统都不得自动把两只猫合并，也不得仅凭模型结果改写 `catId`。当前实现是“候选检索 + 人工决策”，不是身份认证；文案不得使用“百分百认出”或自动合并承诺。

## 8. 部署独立 Re-ID Worker

Worker 位于 `services/reid-service/`。固定配置为：

```text
REID_ENGINE=onnx
REID_MODEL_PATH=/app/models/pet-recognition-small.onnx
REID_ALLOWED_IMAGE_HOSTS=<CloudBase 临时文件的精确域名>
REID_WORKER_HMAC_SECRET=<与 catIdentity 相同的专用随机密钥>
REID_HMAC_MAX_SKEW_SECONDS=300
REID_MAX_REQUEST_BYTES=16777216
```

本地测试可使用 deterministic stub，但它没有视觉语义：

```powershell
Set-Location services/reid-service
$env:REID_ENGINE = 'stub'
$env:REID_ALLOWED_IMAGE_HOSTS = 'authorized.example'
python -m pytest -W error
```

真实模型固定 SHA-256、输入输出、预处理版本和 512 维向量契约。任何一项不一致，或 Worker HMAC 密钥少于 32 字节时，`/ready` 都应返回 503。生产 `/process` 还要求 HMAC、时间戳和一次性 nonce，并限制请求体总字节数；封测阶段应关闭公网直访并固定单实例/单 worker。多实例部署前需要共享防重放存储或私有网关。

> 截至本轮配置，环境 `cloud1-d6gpjpxunc74669d7` 尚未启用 CloudBase 云托管/CloudRun。启用会创建按量计费资源，必须先取得项目所有者明确授权并配置预算告警；不要因为部署脚本可执行就擅自开通。在授权和实际部署完成前，保持 `REID_WORKER_URL` 未配置，`workerConfigured=false`，并将产品状态标为“模型服务未启用”。关系投票、档案映射、人工审核和粗粒度地图可以独立验证，但云端同猫模型不能宣称已经上线。

## 9. 微信开发者工具部署

1. 导入 `miniapp/`，确认 AppID `wx1112379224ace9f9` 和环境 ID `cloud1-d6gpjpxunc74669d7`。
2. 核验第 2 节全部集合、`ADMINONLY` 权限和索引；部署到新环境时按清单创建。
3. 核对 `chooseLocation` 隐私声明，并在小程序后台补齐隐私保护指引。
4. 给四个云函数配置环境变量；不要把 Key 写入前端或 `project.config.json`。
5. 先按第 2 节完成 `uniq_relationship_pair → uniq_relationship_direction_key` 迁移，再依次部署 `askKnowledge`、`identifyCat`、`catOnlineV2`、`catIdentity`，选择“云端安装依赖”；确认 `catOnlineV2` 为 Node.js 20.19，Sharp 健康检查通过，并且健康响应声明有向关系版本 2。新版小程序上传并验证后，禁用旧 `catOnline` 的客户端调用权限，避免旧客户端或手工调用绕开最新版安全逻辑。当前环境使用的完整函数规则如下；更新时必须整体保留 `*`，不能只提交局部覆盖：

   ```json
   {
     "*": {
       "invoke": "auth != null && auth.loginType != 'ANONYMOUS'"
     },
     "catOnline": {
       "invoke": false
     }
   }
   ```

   修改后必须从真实小程序登录态验证：`catOnlineV2.health` 成功，`catOnline.health` 返回 `PERMISSION_DENIED`。管理端调用不受客户端函数规则约束，不能用管理 CLI 的 invoke 结果代替这项验收。
6. 先在不配置 Worker 的状态验证小屋、档案同步、上传、人工审核、关系投票、地图，以及 `enrollLinkedSighting` 的安全失败提示。
7. 只有取得计费授权并部署真实 Worker 后，才给 `catIdentity` 添加 Worker URL/HMAC，验证显式模板登记和 Top-K 候选；模型故障时仍必须保留人工路径。
8. 上传开发版前运行全部自动测试；体验版验收通过后再提交审核。

不要在控制台、截图、日志或聊天中粘贴生产 Key。函数日志只应出现 requestId、taskId、阶段和稳定错误码。函数必须拒绝匿名调用，并对 `ci_*` 集合做一次真实的小程序客户端读写拒绝测试。

`catOnlineV2` 已使用 Sharp 0.35.4，旧版 Sharp 公告对应的问题不再适用；但 `wx-server-sdk` 当前锁定版本的依赖树仍可能包含上游传递漏洞。不要使用可能倒退 SDK 大版本的 `npm audit fix --force`；应在公开上线前升级到 CloudBase 兼容的修复版本并重跑集成测试。

## 10. 验收顺序

离线回归：

```powershell
Get-ChildItem miniapp/tests/*.test.cjs | ForEach-Object {
  node --test $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Set-Location services/reid-service
python -m pytest -W error
```

开发者工具与真机验收：

1. 用户 A 创建小屋并复制邀请码，用户 B 加入；
2. A 同步两只本地猫，确认每只都形成稳定且不同的 `localPetId → remotePetId → catId` 映射，只上传公开最小字段；
3. 修改其中一只本地猫的公开字段，确认同步状态、`syncFingerprint` 和 `serverVersion` 更新，另一只不受影响；
4. A 申请上传会话并提交照片，B 不能读取待审核原图，owner 审核后成员只能看到短时图片 URL；
5. 不选择位置、拒绝位置权限、主动选择位置三种路径都能完成上传；前两种不产生地图坐标，第三种只在私有记录看到精确 GCJ-02，公开响应只有粗网格且不含选点名称或地点备注；
6. 同一目击提交重放 10 次只产生一条记录；模拟“提交成功但响应丢失”并重启后，`recoverSighting` 找回原记录；
7. A、B 分别对同一条 `猫甲 → 猫乙` 边投票：投票前任何成员角色都看不到选项分布，投票后看到聚合；重复同票不增加总数，改票只迁移一次计数；再对 `猫乙 → 猫甲` 投票，确认生成另一条独立边；
8. 粗地图按网格聚合目击数和猫数量，网络响应、日志及地图标记均不出现精确坐标；
9. 已关联且审核通过的目击显示显式登记入口；Worker 未配置时登记失败且不写模板，真实 Worker 可用后重复登记只产生一个有效模板；
10. 未关联目击的模型结果只显示 Top-K 候选，不显示概率；“同一只 / 新猫 / 看不清”和“撤销”都可保存；
11. 全链路确认 `auto_merge_count = 0`，模型、投票和同名档案都不能自动合并猫身份；
12. 日志和客户端响应中不出现 OpenID、Key、fileID、精确位置、`locationGeo`、embedding 或 Worker 签名；
13. 断网后本地档案、本地猫际关系和离线知识仍可使用；云端模块给出可理解的重试反馈，不破坏本地数据。

正式开放前还需补齐：内容安全与人脸/车牌/门牌遮挡、原图保留期清理、调用配额、预算告警、稀疏位置保护、云端解除关联、申诉/举报/删除流程，以及至少 100 只猫的跨日期开放集校准。当前同猫识别只能作为候选辅助，不是身份认证。
