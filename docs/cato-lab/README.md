# Cat-AI × CATO：12 个独立分支审计总览

日期：2026-09-29。产品取舍与最终验收人：用户。这里交付的是可体验、可拒绝、可分开审阅的离线实验，不是已上线版本。

## 先从这里开始

- [打开与操作说明](START-HERE.md)：不动原工作区，在微信开发者工具逐个打开。
- [12 屏实际截图](GALLERY.md)：全部来自真实微信开发者工具，不是概念效果图。
- [80 格结合覆盖矩阵](COVERAGE.md)：说明如何从“尽量穷尽”归纳为12个独立方向，并明确拒绝/延期组合。
- [最终复验记录](TEST-RESULTS.md) 与 [机器可读结果](verification.json)。
- [交叉审计与修复记录](CROSS-AUDIT.md)、[你可填写的审计表](AUDIT-TEMPLATE.md)。
- 研究依据：[CATO 功能设计与 UI 风格调研](../CATO-功能设计与UI风格调研-2026-09-29.md)。没有复制其未获授权插画、品牌或代码，也没有把未核实的公众号能力当成事实。

## 12 个方向，一方向一分支一开发智能体

全部使用前缀 `codex/cato-lab/`，各自由一个独立开发智能体负责，分批并行；主代理做汇总、复验和推送，另有只读交叉审计。

| # | 方向 / GitHub 代码 | 要验证的用户价值 | 本分支说明 | 实际截图 |
|---|---|---|---|---|
| 01 | [照护收件箱](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/capture) | 把一句话变成经本人确认的小事项 | [REVIEW](https://github.com/madaoigtheflash/cat-ai-service/blob/codex/cato-lab/capture/docs/cato-lab/REVIEW.md) | [查看](previews/capture.png) |
| 02 | [私人照护日程](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/care-planner) | 把照顾它放进可调整的日程 | [REVIEW](https://github.com/madaoigtheflash/cat-ai-service/blob/codex/cato-lab/care-planner/docs/cato-lab/REVIEW.md) | [查看](previews/care-planner.png) |
| 03 | [小屋协作目标](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/house-goals) | 知道一件事由谁自愿接下 | [REVIEW](https://github.com/madaoigtheflash/cat-ai-service/blob/codex/cato-lab/house-goals/docs/cato-lab/REVIEW.md) | [查看](previews/house-goals.png) |
| 04 | [专注陪伴](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/focus) | 给人与猫的相处留一段可中断的时间 | [REVIEW](https://github.com/madaoigtheflash/cat-ai-service/blob/codex/cato-lab/focus/docs/cato-lab/REVIEW.md) | [查看](previews/focus.png) |
| 05 | [私人养猫账本](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/expenses) | 看清自己花在照顾上的钱 | [REVIEW](https://github.com/madaoigtheflash/cat-ai-service/blob/codex/cato-lab/expenses/docs/cato-lab/REVIEW.md) | [查看](previews/expenses.png) |
| 06 | [私人猫咪日记](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/journal) | 先为自己记下，再决定分享哪一小段 | [REVIEW](https://github.com/madaoigtheflash/cat-ai-service/blob/codex/cato-lab/journal/docs/cato-lab/REVIEW.md) | [查看](previews/journal.png) |
| 07 | [低压力猫友续聊](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/social-followup) | 从猫咪故事自然接话，又保留拒绝的自由 | [REVIEW](https://github.com/madaoigtheflash/cat-ai-service/blob/codex/cato-lab/social-followup/docs/cato-lab/REVIEW.md) | [查看](previews/social-followup.png) |
| 08 | [可控陪伴偏好](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/companion) | 自己决定称呼、语气和安静时机 | [REVIEW](https://github.com/madaoigtheflash/cat-ai-service/blob/codex/cato-lab/companion/docs/cato-lab/REVIEW.md) | [查看](previews/companion.png) |
| 09 | [多端一致性契约](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/sync-contract) | 冲突时不偷偷替用户覆盖记录 | [REVIEW](https://github.com/madaoigtheflash/cat-ai-service/blob/codex/cato-lab/sync-contract/docs/cato-lab/REVIEW.md) | [查看](previews/sync-contract.png) |
| 10 | [目击与回访](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/encounter-review) | 慢慢补证据，不把第一眼当定论 | [REVIEW](https://github.com/madaoigtheflash/cat-ai-service/blob/codex/cato-lab/encounter-review/docs/cato-lab/REVIEW.md) | [查看](previews/encounter-review.png) |
| 11 | [有向关系观察](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/relationship-observe) | 弄清谁对谁做了什么，而不急着给关系贴标签 | [REVIEW](https://github.com/madaoigtheflash/cat-ai-service/blob/codex/cato-lab/relationship-observe/docs/cato-lab/REVIEW.md) | [查看](previews/relationship-observe.png) |
| 12 | [知识与反馈转行动](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/knowledge-action) | 看完知识后自己做一点，再反馈哪里有用 | [REVIEW](https://github.com/madaoigtheflash/cat-ai-service/blob/codex/cato-lab/knowledge-action/docs/cato-lab/REVIEW.md) | [查看](previews/knowledge-action.png) |

## 实现与模拟的边界

| 分支后缀 | 本地真实可操作部分 | 不应误认为已接通的能力 |
|---|---|---|
| `capture` | 文字按标点拆分、编辑与时间核对、确认、完成/撤销/删除 | 语音/图片仅是合成文字样本；没有识别服务 |
| `care-planner` | 开始/截止/随时事项、重复、按日查看、完成/撤销/跳过/暂停 | 没有微信推送；不决定用药和治疗 |
| `house-goals` | 目标/子任务、认领、证据、完成/撤销、退出与权限规则 | 成员和小屋均为模拟；没有给真实猫友分派 |
| `focus` | 正计时/番茄钟、暂停恢复、结束核对、编辑与统计 | 计时不等于完成任务；没有后台推送 |
| `expenses` | 预览确认、增改删、整数分计价、分类和月度汇总 | 没有支付/银行接入；不是正式财务凭证 |
| `journal` | 日记增改删、搜索/日期回顾、主动片段/改写预览 | 分享只是本地预览，不真实发布，不自动公开全文 |
| `social-followup` | 双角色评论回复、通知定位、一条招呼、回复解锁、忽略/拉黑 | 身份/故事/通知/私信全为本地模拟 |
| `companion` | 三场景文案、称呼/语气、跨午夜安静时段、减少动态、保存/放弃 | 预写模板，不调用生成服务；不改变系统免打扰 |
| `sync-contract` | 双副本排队、版本冲突、明确解决、回执重试、删除墓碑 | 同一设备内模拟权威端，不是真实多端或云权限 |
| `encounter-review` | 粗略区域、自定回访、证据、人工判断、名片关联/撤销 | 两张合成候选；无照片模型或真实档案合并 |
| `relationship-observe` | 双方角色、定向计划、证据、两人投/改/撤票、计数分布 | 观察者/猫均合成；不是云投票、亲缘证明或地理热力图 |
| `knowledge-action` | 来源→自定行动→反馈版本→模板提案→人工同意/驳回 | 模板模拟审阅，不执行开发、不改代码、不真实提交反馈 |

## 覆盖定义，不作无限承诺

本轮以 **10 类既有 Cat-AI 场景 × 8 类公开 CATO 能力 = 80 个讨论格**建立覆盖矩阵，归并出12个有独立验收边界的方案。每格都有方向归属或明确的拒绝/延期理由。

这不等于实现所有功能子集的排列组合，也不能证明所有未来创意被穷尽。跨分支组合（例如收件箱→日程→协作→同步）仅制定衔接方向，待你选型后集成；本轮不是把十二个实验同时塞入一个首页。

明确不做：自动医疗判断或药量安排、自动公开日记/健康档案、无确认代发消息、把投票当亲缘事实、实时精确定位公开、冒充真实猫友、惩罚打卡。

## 分支和原项目安全边界

- 原工作区仍是 `codex/personal-release`，基于提交 `8eea93084599605f9ceb2ec964eb880051bc1b6a`；原有未提交修改保留。
- 共同实验源码快照为 `0dde597b04b946c66169709376c99be8d803effe`，包含用户当时在本地的白名单源码，不是简单回退到旧 HEAD。未复制私钥、环境文件、运行数据或安装目录。
- [公共实验底座](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/base-20260929) 增加了游客入口、离线开关、独立存储与传输保护；[review 分支](https://github.com/madaoigtheflash/cat-ai-service/tree/codex/cato-lab/review) 只承载审计工具和资料，不是十二功能合并版。
- 实验皆为 `touristappid`，不初始化生产云；数据只写各自实验命名空间。没有新增生产云 API、部署或真实对外发送。
- 所有实现保持微信原生和既有 CloudBase 架构边界；按 `cat-miniapp-ui` 与 `impeccable` 延续粉色、中文系统字体、自然换行、88rpx 触控及安全区，并减少无功能的装饰。
- 尚未建立 PR、合并到个人/企业发布分支、上传体验版或正式发布。

## 你需要作出的审计决定

每个方向选择“保留 / 组合 / 修改后再审 / 放弃”，建议优先体验你在意的 **社交续聊、小屋协作、目击回访**，再评估私人效率工具是否真能改善人与猫的互动，而非增加记录负担。

以上顺序是产品审阅建议，不是市场验证结果。所有分支都保留给你选择，不会替你自动合并。

如需看纯功能增量，可在 GitHub 比较 `0dde597b04b946c66169709376c99be8d803effe...codex/cato-lab/<方向>`。不要将十二分支直接连续 merge；实验入口配置有意相互独立，整合需另开分支统一导航与契约。
