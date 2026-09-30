# 小桃角色素材来源与处理记录

## 用途与边界

- 交付物：原创虚拟猫“小桃”的单角色透明插画，用于小程序首页角色展示和用户点按后的轻触反馈。
- 这是虚构角色，不是用户真实猫咪照片，不用于同猫识别、品种判断或社区真实活跃度证明。
- 不包含页面文案、按钮、背景场景或模拟界面；不借用现有 IP 角色。调用未使用参考图片。
- 使用内置 `image_gen.imagegen`（本次工具名 `image_gen__imagegen`），未使用 CLI/API fallback。
- 生成日期：2026-09-30。实际生成模型未由工具返回，不推测型号。

## 文件

| 角色 | 路径 | 尺寸与体积 |
|---|---|---|
| 出货 PNG | `miniapp/assets/companion/xiaotao-welcome-v1.png` | 512 × 512，302,294 bytes（295.2 KiB），RGBA，非调色板 |
| 原始图存档 | `docs/companion-living/assets-source/xiaotao-welcome-v1.original.png` | 1254 × 1254，1,328,010 bytes，RGBA；像素未修改，仅写入 prompt 元数据 |
| 精确提示词 | `docs/companion-living/assets-source/xiaotao-welcome-v1.prompt.txt` | UTF-8，1948 字符，无末尾换行，与工具实际输入相同 |

工具原始保存路径为 `C:/Users/13622/.codex/generated_images/01a0f2fc-0b55-78f0-96f0-53731f762888/exec-210f7557-2c41-405b-be54-3dc16f4ed68c.png`。该文件保留不动；项目副本存放在上表路径中。

提示词要求 1024 方图，但内置工具实际返回 1254 方图；按真实输出记录，没有将请求尺寸冒充实际尺寸。

## 转换与验证

1. 采用已安装运行时里的 `sharp`，将原始方图等比下采样至 512 × 512；透明背景 `fit:contain`，无裁切、无抠图、无背景去除、无语义重绘。
2. 出货使用 `png({ compressionLevel: 9, palette: false })`，保留完整 RGBA。曾比较调色板压缩，但为避免纯白毛发及实心区域的 alpha 量化损失，最终选择 RGBA。
3. 使用 `C:/Users/13622/.codex/skills/impeccable/scripts/impeccable.cmd embed-prompt <file> --prompt-file <prompt.txt>`，给原始图副本与出货图嵌入精确提示词。
4. 读取出货 PNG 的 `impeccable:prompt` tEXt 元数据，逐字符比较提示词文件：一致（1948 字符）。
5. 原始图和出货图均有真正 alpha；出货 alpha 最小值 0、最大值 255。奶白色猫身保留，并非通过删除白色得到透明背景。
6. 实际查看出货图，并分别在奶白 `#FFFBFC` 与深色 `#3E2D35` 背景上检查毛发、耳朵、尾巴和透明间隙：主体完整，透明背景无方形底板，细须保留。背景合成图仅作为工具输出目录中的检查图，不作为出货素材。
7. 体积为 295.2 KiB（小于 300 KiB），按十进制约 302.3 KB；未为跨过十进制 300 KB 阈值牺牲完整 alpha。

## SHA-256

- 出货 PNG：`0899ac2f6f8a6028a652c2ae8a7453b30ee83d4997d1a24e4b8e04eb0faf7e8f`
- 原始图项目副本：`1fcf220cf42e7afcce6143b7d74a1835586833f02b4e26eebf76550836a74670`

## 精确生成提示词

以下内容与提示词文件及 PNG 内嵌 prompt 一致；代码围栏后的排版换行不属于实际输入。

```text
Use case: stylized-concept
Asset type: original virtual-cat companion character illustration for a pink, cozy Chinese WeChat mini-program; a single isolated character asset, not a UI mockup.
Primary request: Create Xiaotao, an original friendly and slightly playful rounded cat, sitting naturally with one front paw lifted in a gentle hello. A warm clever gaze and a small relaxed smile, approachable without exaggerated baby proportions.
Scene/backdrop: genuinely transparent background with native PNG alpha, not a white background or a checkerboard painted into the image.
Subject: one whole cat, creamy milk-white fur with a few soft pale-peach patches, subtle rosy inner ears, a thin peach-pink collar without a tag, soft rounded paws, two ears and a fully visible curved tail. One front paw lifted, the other resting naturally; anatomically coherent body and legs.
Style/medium: polished hand-painted 2.5D editorial character illustration with delicate visible brushwork and softly dimensional fur. Clean silhouette, fine painterly details that still read on a small phone screen. Not photorealistic, not shiny plastic, not a clay toy.
Composition/framing: square 1024 x 1024 canvas; centered complete seated body; the figure occupies approximately 80% of the canvas with comfortable clear space around every ear, paw and the tail; no cropping.
Lighting/mood: gentle diffuse light, warm and reassuring with quiet liveliness, no dramatic shadows.
Color palette: milk-white, very pale peach, soft rose-pink accents, warm dark-brown eyes and small nose; designed to sit on pale pink or cream UI backgrounds.
Text: none.
Constraints: completely original, no imitation of any existing character or intellectual property, no logos or watermarks. Cat only, no scenery, no extra objects, no particles, no sparkles, no typography, no floor or pedestal, no cast shadow on an opaque background. Preserve genuinely transparent gaps and painted white fur.
```

## 实现建议

角色图片应使用等比缩放，不拉伸或裁掉耳朵、爪和尾巴。虚拟身份通过真实文字标注，角色不替代可访问的按钮文案。待机不必持续晃动；点按之后可给一次短促反馈，并遵守减少动态设置。

