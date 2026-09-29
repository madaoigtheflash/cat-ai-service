# 最终测试与提交记录

自动复验时间（UTC）：2026-09-29T14:57:36.456Z。主代理通过 `tools/cato_lab_verify_all.cjs` 对12个方向重新执行。所有行专项和全量测试均通过，**0失败、0跳过**；原生WXML编译、路由/事件绑定、JS/JSON检查及工作树干净检查通过。

## 分支结果

专项列包含5个共享隔离测试；全量列包含原有功能测试。不同分支重复测试同一底座，不能将这些数字直接相加当作独立测试总数。基线为339项。

| 方向 | 专项通过/总数 | 全量通过/总数 | 最终提交（完整SHA见JSON） |
|---|---:|---:|---|
| 照护收件箱 · `capture` | 32/32 | 366/366 | [2aec50a](https://github.com/madaoigtheflash/cat-ai-service/commit/2aec50a42e5b49618ca17d9d1eaee2887f5eb7f7) |
| 私人照护日程 · `care-planner` | 24/24 | 358/358 | [9dfa926](https://github.com/madaoigtheflash/cat-ai-service/commit/9dfa9261f82296f8d8dd9f3918d8ed58302c0d41) |
| 小屋协作目标 · `house-goals` | 28/28 | 362/362 | [12220ad](https://github.com/madaoigtheflash/cat-ai-service/commit/12220adc39a9820a97137b696b8cd0b4e5c84fd7) |
| 专注陪伴 · `focus` | 36/36 | 370/370 | [5503b09](https://github.com/madaoigtheflash/cat-ai-service/commit/5503b097fdd77636013e8fb72d37558e39495019) |
| 私人养猫账本 · `expenses` | 49/49 | 383/383 | [785a3ea](https://github.com/madaoigtheflash/cat-ai-service/commit/785a3ea319a962ec42fc52f8faf6353e0503dcb3) |
| 私人猫咪日记 · `journal` | 27/27 | 361/361 | [67f68ed](https://github.com/madaoigtheflash/cat-ai-service/commit/67f68ed872093122f60e2008758df7dc58f2c8c2) |
| 低压力猫友续聊 · `social-followup` | 27/27 | 361/361 | [78a7de2](https://github.com/madaoigtheflash/cat-ai-service/commit/78a7de212d8fec4cac0a4029e9223541e4327847) |
| 可控陪伴偏好 · `companion` | 33/33 | 367/367 | [36b5eb1](https://github.com/madaoigtheflash/cat-ai-service/commit/36b5eb1c2f2fe733b7c230188dbf13af99460aa3) |
| 多端一致性契约 · `sync-contract` | 37/37 | 371/371 | [a34b032](https://github.com/madaoigtheflash/cat-ai-service/commit/a34b0326f7567888a666efcf3eb71f3db54fc726) |
| 目击与回访 · `encounter-review` | 30/30 | 364/364 | [d8bd730](https://github.com/madaoigtheflash/cat-ai-service/commit/d8bd730556647fe1751a319fb3930aec4870300c) |
| 有向关系观察 · `relationship-observe` | 44/44 | 378/378 | [5698676](https://github.com/madaoigtheflash/cat-ai-service/commit/5698676a0ef54454e5c363ada87d81af6bfe1d1c) |
| 知识与反馈转行动 · `knowledge-action` | 33/33 | 367/367 | [d1bcdcf](https://github.com/madaoigtheflash/cat-ai-service/commit/d1bcdcfd0ee250e8054e6f4be77c05a80e4057e7) |

机器可读记录：[verification.json](verification.json)。该文件保留每个方向完整SHA、全部检查结果和复验时间，远端核对另见[交付记录](DELIVERY.md)。

## 实际界面证据

12个页面都在真实微信开发者工具中打开并逐张查看。环境为游客AppID、390×753窗口、fontSizeSetting 16、基础库3.17.1，读取到 `catoLabOffline=true`、`cloudReady=false`。图见 [GALLERY.md](GALLERY.md)。截图内容是空状态或合成演练数据，不包含真实用户资料。

额外控制器冒烟（真实IDE内，通过Page.callMethod，而非物理点按）：

- social-followup：草稿不自动发送、评论/回复通知回原上下文、首条招呼限制、明确回复解锁、拉黑拦截、重开状态保持。
- sync-contract：离线队列、改名冲突、明确保留权威端、回执丢失重试不重复、其他模拟身份拒绝。
- sync-contract P2复验：旧创建/编辑保存失败后继续输入，重试旧请求不会清除较新草稿或关闭新编辑状态。发现及修复见 [CROSS-AUDIT.md](CROSS-AUDIT.md)。

## 复现命令与依赖

```powershell
# 在相应功能工作树执行
node --test miniapp/tests/cato-*.test.cjs
node --test miniapp/tests/*.test.cjs

# 在review工作树执行；需要本机已安装的微信开发者工具
$env:WECHAT_WXML_COMPILER='D:/Program Files (x86)/Tencent/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec/wcc.exe'
node tools/cato_lab_verify_all.cjs
```

旧全量测试需要已有CloudBase SDK及图像处理依赖。本机采用被Git忽略的目录联接复用原工程的catOnline/node_modules，没有把依赖复制进提交，也没有安装新依赖。最初未连接依赖时出现4个缺模块失败、1个跳过；补齐测试运行路径后才取得表中的0跳过结果，没有删测试。

## 不能据此推断

- 没有完成320/375/430px、系统大字号、全部滚动/键盘状态与真机后台验收。
- 没有真实云身份、跨设备同步、微信通知、公众号权限、支付或线上审核验证。
- 本地模拟权限不能当作服务端鉴权实现。
- 通过测试不表示需求已被用户确认、没有任何未知缺陷或可以直接上线。
