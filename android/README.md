# Cat-AI Android

这是 Cat-AI 的独立 Android 版本。APK 内置现有响应式界面和猫咪知识库，默认通过原生 HTTPS 层调用 MiniMax 视觉模型，不需要手机连接电脑上的 FastAPI 服务。

## 功能

- 从相册选择照片或调用系统相机拍照
- AI 猫咪品种、品相、可见健康状态和年龄段识别
- 内置猫咪知识库，按识别品种展示基础、健康、饲养和价格信息
- 猫咪档案保存在应用私有 SQLite 数据库中；首次升级会自动迁移旧版 WebView 档案
- 已预留个体识别照片、特征模板和用户确认反馈的数据结构
- 原 Web 版本保持不变：浏览器运行时仍调用 FastAPI `/api/*`

## 构建

需要 JDK 17、Android SDK 35 和联网的 Gradle 环境。设置 `ANDROID_HOME` 后执行：

```powershell
cd android
.\gradlew.bat assembleRelease
```

也可在服务目录中执行：

```powershell
.\android\build-apk.ps1
```

默认从以下位置按优先级读取一把 MiniMax API Key：

1. Gradle 参数 `-PCAT_AI_API_KEY=...`
2. 环境变量 `CAT_AI_API_KEY`
3. 项目现有 `closeai.config.json` 的 `models.minimax.api_key`

`CAT_AI_PROVIDER`、`CAT_AI_BASE_URL` 和 `CAT_AI_MODEL` 也可用同名 Gradle 参数或环境变量覆盖。构建脚本不会把 `closeai.config.json` 整份打进 APK，只会编译所选模型的必要配置。

输出文件：`app/build/outputs/apk/release/app-release.apk`。

## 安全与签名

任何放进客户端的 API Key 最终都可能被逆向提取。本项目在构建期做了拆分混淆并启用 R8，只能增加提取难度，不能提供真正保密。适合个人侧载时使用限额、可轮换的专用 Key；公开分发应改为带鉴权和限流的服务端代理。

当前 `release` 任务使用本机 Android debug 签名，以便直接安装测试。若要上架应用商店或长期向多台设备推送更新，请创建并妥善备份自己的 release keystore，再替换 `app/build.gradle` 中的签名配置。

为避免猫咪照片和健康备注进入系统云备份，应用已关闭 Android 自动备份。卸载应用或清除应用数据会同时清除本地猫咪档案。

## 档案数据库

从 1.1.0 起，Android 档案不再以 `localStorage` 作为主存储。应用首次启动时会把 `cat_ai_android_pets_v1` 自动导入应用私有的 `cat_ai.db`，导入成功后删除旧副本。若原生数据库初始化失败，前端会保留旧数据并回退到原存储，不会静默覆盖。

数据库目前包含：

- `pets`：兼容现有页面的完整宠物档案；
- `pet_photos`：个体建档照片和质量元数据；
- `identity_templates`：模型版本、512 维特征和来源照片；
- `identity_match_events`：候选身份、置信度及用户确认反馈；
- `settings`：一次性迁移和数据版本状态。

个体识别模型尚未在 1.1.0 中启用；需要真实跨拍摄数据通过 POC 门槛后再接入。
