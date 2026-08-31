# Cat-AI 本地服务器 EXE 使用说明

## 启动

双击：

`dist/CatAI-Server.exe`

启动成功后会显示：

- 本地地址：`http://localhost:8503`
- 公网地址：`http://yacoyacoyaco.asuscomm.com:8503`
- 健康检查：`http://localhost:8503/api/health`

关闭黑色命令行窗口或按 `Ctrl+C` 即可停止服务。同一时间只能启动一个实例。

## 运行目录

EXE 不包含模型 API Key。它会在 EXE 所在目录或上级目录查找：

- `closeai.config.json`
- `猫咪知识库/`
- `frontend/`
- `data/`

当前 EXE 位于项目的 `dist/` 目录，可以直接使用项目根目录中的上述文件。如果把 EXE 复制到其他电脑或文件夹，必须同时复制这些外部文件和目录。

## 小程序联调

小程序开发版已固定使用：

`http://yacoyacoyaco.asuscomm.com:8503`

`miniapp/project.config.json` 中已关闭合法域名校验。该设置只适合开发调试；微信正式版和部分真机环境可能拒绝明文 HTTP。

## 安全提醒

当前公网模型接口没有用户登录鉴权。任何知道地址的人都可能调用模型并消耗额度，应使用专用、限额、可随时轮换的模型 Key，并避免长时间无人值守运行。
