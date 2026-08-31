# 宠物个体识别 POC

这个目录用于验证“同一只猫特征识别”技术路径，不参与现有 Web、后端或 Android 构建。

候选模型：[`open-noodle/pet-recognition-small`](https://huggingface.co/open-noodle/pet-recognition-small)，Apache-2.0。模型输入为 `float32 [N,3,224,224]`，输出为 512 维 L2 归一化特征。

## 获取模型

将模型保存为：

```text
tools/pet_reid/models/pet-recognition-small.onnx
```

下载地址：

```text
https://huggingface.co/open-noodle/pet-recognition-small/resolve/main/recognition/model.onnx
```

预期大小为 `89,227,604` 字节，SHA-256：

```text
6a5e2373ab348bed588cef4072f3914ca9c8bacde3e8d0651019e8dad86b24ba
```

## 运行

```powershell
python tools/pet_reid/poc_validate.py `
  data/test/cat1.jpg `
  data/uploads/cat_1786851192.jpg
```

默认在 `tools/pet_reid/reports/latest.json` 输出机器可读报告。

本工具会为每张输入图片生成内存中的亮度、JPEG、镜像和轻微裁剪扰动，检查特征稳定性，并计算不同输入图片之间的相似度。扰动图不会写入磁盘。

## 真实数据集评测

按身份建立目录，每只猫至少放入 3～5 张跨时间、跨角度照片：

```text
my-cats/
  cat-a/
    01.jpg
    02.jpg
  cat-b/
    01.jpg
    02.jpg
```

运行：

```powershell
python tools/pet_reid/evaluate_dataset.py my-cats
```

报告默认输出到 `tools/pet_reid/reports/dataset-latest.json`，包括验证 AUC、EER、FAR 不超过 1% 时的阈值与召回率，以及留一法 Top-1/Top-3。评测照片不能是同一次连拍或同一文件的压缩副本。

## 结果边界

- 一张照片的人工扰动只能验证推理链路和基础稳定性，不能代表跨日期、跨角度的同猫识别准确率。
- `suggested_demo_threshold` 仅用于观察当前样本是否可分，严禁直接作为正式阈值。
- 进入 Android 集成前，每只猫至少需要 3～5 张跨时间、跨角度原始照片，并用未参与建档的照片做测试。
