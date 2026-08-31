# Cat-AI 独立同猫识别 Worker

这是与现有 FastAPI、Android 和小程序隔离的内部服务。它只完成：受控图片下载、图片与模型契约校验、512 维 embedding、全量精确余弦检索和身份候选特征返回。

Worker **不接收 OpenID、不写业务数据库、不判定 `same_cat`、不自动合并档案**。CloudBase dispatcher 仍需负责身份、幂等、任务租约、候选确认和最终数据写入。

## 固定模型契约

模型为 [`open-noodle/pet-recognition-small`](https://huggingface.co/open-noodle/pet-recognition-small)：

| 项目 | 固定值 |
| --- | --- |
| 文件 | `pet-recognition-small.onnx` |
| 大小 | `89,227,604` bytes |
| SHA-256 | `6a5e2373ab348bed588cef4072f3914ca9c8bacde3e8d0651019e8dad86b24ba` |
| 输入 | `input`, `float32 [batch,3,224,224]` |
| 输出 | `embedding`, `float32 [batch,512]`、L2 normalized |
| 颜色/归一化 | RGB、ImageNet mean/std |
| 预处理版本 | `open-noodle-imagenet-fit224-v1` |
| embedding 编码 | 512 个 little-endian float32，base64，即 `f32le-base64` |

启动时会校验文件大小、SHA、输入输出数量、名称、dtype、shape 和 CPU provider。任一项不一致时进程仍可回答 health，但 ready/process 会失败。

当前预处理与原 POC 对齐：先 EXIF 纠正、转 RGB，再居中 `ImageOps.fit` 到 224×224。传入图片必须已经是审核后的单只猫 whole-animal crop；服务本身尚不提供自动检测或多猫选择。

## 内部路由

### `GET /internal/v1/health`

只表示进程存活，不代表模型可用。

### `GET /internal/v1/ready`

检查 embedding engine、固定模型契约、请求内精确索引模式和图片 host allow-list。就绪返回 200，否则返回 503。`REID_ENGINE=stub` 时会明确返回：

```json
{
  "ok": true,
  "data": {
    "ready": true,
    "engine": "deterministic-stub",
    "testOnly": true,
    "authRequired": false,
    "authScheme": "disabled",
    "modelPresent": false,
    "modelContractValid": true,
    "indexMode": "request_exact_numpy",
    "indexReady": true
  }
}
```

stub 只是把预处理 tensor 经 SHAKE-256 映射成稳定的 512D 单位向量，没有视觉语义，严禁用于真实候选质量测试或线上流量。

真实 ONNX 模式必须设置至少 32 字节的 `REID_WORKER_HMAC_SECRET`；缺失或过短时 ready 返回 503，process 在读取完整 JSON 前返回 `AUTH_NOT_CONFIGURED`。ready 会返回 `authRequired: true` 和 `authScheme: "hmac-sha256-v1"`。health/ready 不要求签名，process 必须签名。

### `POST /internal/v1/reid/process`

请求示意：

```json
{
  "schemaVersion": 1,
  "requestId": "req-uuid",
  "idempotencyKey": "job-uuid",
  "gallerySnapshotId": "gallery-v1",
  "contract": {
    "modelId": "open-noodle/pet-recognition-small",
    "modelSha256": "6a5e2373ab348bed588cef4072f3914ca9c8bacde3e8d0651019e8dad86b24ba",
    "preprocessVersion": "open-noodle-imagenet-fit224-v1",
    "cropVersion": "whole-animal-manual-v1",
    "dimension": 512,
    "encoding": "f32le-base64"
  },
  "image": {
    "url": "https://allowed-cloud-host.example/signed/cat.jpg?token=...",
    "sha256": "64-lowercase-hex-characters...",
    "sizeBytes": 123456,
    "mimeType": "image/jpeg"
  },
  "gallery": [
    {
      "templateId": "tpl-1",
      "catId": "cat-1",
      "sessionId": "capture-session-1",
      "embeddingBase64": "512-float32-values-as-base64",
      "quality": 0.9,
      "view": "body_left"
    }
  ],
  "topK": 5
}
```

`contract` 可以省略，此时使用以上固定值。`cropVersion` 必须跟 gallery 快照的模板版本一致；dispatcher 应按版本取模板，不能跨模型/预处理/裁剪版本拼接 gallery。

响应包含内部 `queryEmbedding`、精确模板 Top-K 和身份 Top-K：

- 所有模板都用 NumPy 矩阵点积做 exact cosine，没有 ANN 近似。
- 身份聚合先对每个 session 只保留最佳模板，再返回 `bestSimilarity`、Top-3 session 均值、中位数、标准差和独立 session 数。
- 当前检索排序基线为 `0.6 × best + 0.4 × mean(top-3 sessions)`，字段名为 `retrievalScore`，不是概率，也不是正式阈值。
- `decisionPolicy` 固定为 `candidate_only`；调用方不能依据此响应自动合并猫身份。
- 空 gallery 合法，会返回 query embedding 和空候选，供“可能是新猫”的业务流程继续处理。

输入会拒绝：未知字段、错误 schema/model 契约、重复 templateId、非 512D/非有限/未归一化向量、错误 SHA/大小/MIME、动图、解码炸弹、超限像素、非 HTTPS URL、IP URL、重定向和 allow-list 外域名。

## HMAC 请求认证

正式部署必须生成独立、可轮换的高熵密钥并设置：

```powershell
$env:REID_WORKER_HMAC_SECRET = '至少32字节的随机专用密钥'
$env:REID_HMAC_MAX_SKEW_SECONDS = '300'
```

dispatcher 对传输的**原始 body bytes**计算签名，并发送：

```text
X-CatAI-Timestamp: Unix秒
X-CatAI-Nonce: 每次调用唯一的8到128位安全随机字符串
X-CatAI-Signature: 64位小写hex HMAC-SHA256
```

签名规范固定为：

```text
canonical = METHOD + "|" + PATH + "|" + TIMESTAMP + "|" + NONCE + "|" + sha256(rawBodyBytes)
signature = hex(hmac_sha256(UTF8(secret), UTF8(canonical)))
```

本接口的 METHOD/PATH 分别是 `POST` 和 `/internal/v1/reid/process`。不要先签一个 JSON 对象，再让 HTTP SDK 用不同空格、字段顺序或字符转义重新序列化；必须先得到最终 body bytes，签名后原样发送。

Python 调用方示意：

```python
import hashlib
import hmac
import json
import secrets
import time

body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
timestamp = str(int(time.time()))
nonce = secrets.token_hex(16)
body_hash = hashlib.sha256(body).hexdigest()
canonical = f"POST|/internal/v1/reid/process|{timestamp}|{nonce}|{body_hash}"
signature = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
headers = {
    "Content-Type": "application/json",
    "X-CatAI-Timestamp": timestamp,
    "X-CatAI-Nonce": nonce,
    "X-CatAI-Signature": signature,
}
```

密钥配置后，缺失、格式错误、超出时钟窗口、签名不匹配或已使用 nonce 均返回 401，且不会下载图片或运行模型。进程内 nonce cache 覆盖整个有效时间窗；初始容器按单 worker 运行。若以后开放多个进程/实例，必须在私有网关或共享存储增加跨实例 nonce 防重放，不能把本地 cache 当作全局保证。dispatcher 与 Worker 都应使用可靠时钟同步。

`REID_WORKER_HMAC_SECRET` 为空时只有 `REID_ENGINE=stub` 可以启动无认证的本地测试流程，ready 明确显示 `authRequired: false`。该模式严禁暴露到公网。

## 本地运行

从本目录执行：

```powershell
python -m pip install -r requirements-test.txt
$env:REID_ENGINE = 'stub'
$env:REID_ALLOWED_IMAGE_HOSTS = 'authorized.example'
uvicorn app.main:app --host 127.0.0.1 --port 8601
```

真实 ONNX 模式：

```powershell
$env:REID_ENGINE = 'onnx'
$env:REID_MODEL_PATH = '..\..\tools\pet_reid\models\pet-recognition-small.onnx'
$env:REID_ALLOWED_IMAGE_HOSTS = '你的精确CloudBase文件域名,*.你的受控文件域名'
$env:REID_WORKER_HMAC_SECRET = '至少32字节的随机专用密钥'
uvicorn app.main:app --host 127.0.0.1 --port 8601 --workers 1
```

host allow-list 规则支持精确域名、`.example.com`（根域和子域）及 `*.example.com`（仅子域）。生产环境应使用尽可能精确的域名和私有链路；Worker 不接受客户端任意 URL，也不跟随重定向。

可调限制：

| 环境变量 | 默认值 |
| --- | ---: |
| `REID_MAX_IMAGE_BYTES` | 8 MiB |
| `REID_MAX_IMAGE_PIXELS` | 25,000,000 |
| `REID_MAX_REQUEST_BYTES` | 16 MiB |
| `REID_MAX_TEMPLATES` | 5,000 |
| `REID_MAX_TOP_K` | 50 |
| `REID_REQUEST_TIMEOUT_SECONDS` | 15 |
| `REID_WORKER_HMAC_SECRET` | 空（ONNX 模式必须至少 32 字节） |
| `REID_HMAC_MAX_SKEW_SECONDS` | 300 |

## 测试

```powershell
pytest
```

绝大多数测试使用无模型 deterministic stub。若仓库内存在固定 ONNX 且安装了 ONNX Runtime，会额外执行真实模型 hash/I-O/推理契约测试；没有模型时该单测跳过，其余测试仍可运行。

## 容器

Dockerfile 需要从仓库根目录构建，才能把固定模型复制进镜像：

```powershell
docker build -f services/reid-service/Dockerfile -t cat-ai-reid:dev .
docker run --rm -p 8601:8080 `
  -e REID_ALLOWED_IMAGE_HOSTS='你的受控文件域名' `
  -e REID_WORKER_HMAC_SECRET='至少32字节的随机专用密钥' `
  cat-ai-reid:dev
```

初始封闭验证必须关闭公网直访，并固定单实例、单 worker，并发 1–2、1 vCPU、1–2 GB 内存。当扩展到多实例时，先用共享缓存或私有网关实现 nonce 防重放和幂等结果缓存。图库继续由 dispatcher 以版本化快照随请求传入；规模增大后可在不改变业务响应契约的情况下切换到版本化 `IndexFlatIP` 快照。
