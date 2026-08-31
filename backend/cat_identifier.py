"""猫咪品种识别服务 — 调用视觉大模型 API 进行品种识别（识别前注入知识库）"""

import base64
import json
import re
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image

from backend.config import (
    KNOWLEDGE_DIR,
    MODEL_PROVIDERS,
    get_provider,
    provider_supports_vision,
)
from backend.knowledge_service import get_knowledge_service

# 注入识别 prompt 的知识库参考文件（按重要性排序，附截断长度）
_BREED_REF_FILES = [
    ("02_品种猫速查表.md", 6000),   # 20 个主流品种一行速查
    ("03_中华田园猫细分.md", 4000),  # 田园猫 11 细分（狸花/橘/奶牛等）
    ("01_选猫多维分类.md", 2500),   # 9 维分类框架
    ("04_品相知识体系.md", 2500),   # 品相六维评价
]


class CatIdentifier:
    """猫咪品种识别器（支持多模型供应商切换）"""

    def __init__(self):
        self.knowledge = get_knowledge_service()
        self._breed_reference: str | None = None  # 缓存的知识库参考文本

    # ── 知识库注入 ──────────────────────────────

    def build_breed_reference(self) -> str:
        """在 LLM 运行前构建注入用的品种知识参考

        直接读取知识库核心文件（全量/截断），而非检索片段，
        保证模型识别时有完整的品种对照表可用。
        """
        if self._breed_reference is not None:
            return self._breed_reference

        parts = []
        for filename, max_chars in _BREED_REF_FILES:
            path = Path(KNOWLEDGE_DIR) / filename
            if path.exists():
                try:
                    content = path.read_text(encoding="utf-8")
                    if len(content) > max_chars:
                        content = content[:max_chars] + "\n……（截断）"
                    parts.append(f"【{path.stem}】\n{content}")
                except OSError:
                    pass

        self._breed_reference = "\n\n".join(parts) if parts else "（知识库未加载）"
        return self._breed_reference

    # ── 识别 ────────────────────────────────────

    def identify(self, image_path: str | Path, provider: str | None = None) -> dict:
        """识别猫咪品种并返回相关知识

        provider: 模型供应商标识（minimax/kimi/deepseek/...），None 用默认。
        返回: {
            "success": bool,
            "breed": 识别出的品种,
            "confidence": 置信度,
            "description": AI 的详细描述,
            "model_used": 实际使用的模型,
            "knowledge": 知识库检索结果,
            "raw_response": 原始响应
        }
        """
        image_path = Path(image_path)
        if not image_path.exists():
            return {"success": False, "error": "图片文件不存在"}

        # 供应商配置与能力检查
        pcfg = get_provider(provider)
        provider_name = pcfg.get("provider", "minimax")
        if not pcfg.get("api_key"):
            return {"success": False, "error": f"模型「{provider_name}」未配置 API 密钥"}
        if not provider_supports_vision(pcfg):
            return {
                "success": False,
                "error": f"模型「{pcfg.get('default_model')}」不支持图片识别，请选择支持视觉的模型（如 minimax）",
            }

        api_key = pcfg["api_key"]
        base_url = pcfg.get("base_url", "").rstrip("/")
        model = pcfg.get("default_model", "")
        temperature = pcfg.get("temperature", 1.0)

        # 压缩图片（最长边 800px，降低传输与推理耗时）
        with Image.open(image_path) as im:
            im = im.convert("RGB")
            im.thumbnail((800, 800))
            buf = BytesIO()
            im.save(buf, format="JPEG", quality=85)
        image_data = base64.b64encode(buf.getvalue()).decode("utf-8")

        # ★ LLM 运行前注入知识库：品种速查表 + 田园猫细分 + 品相体系
        breed_reference = self.build_breed_reference()

        system_prompt = (
            "你是一位专业的猫咪品种鉴定师。请仔细观察图片中的猫，从以下维度分析：\n"
            "1. 品种鉴定：对照下方【品种知识库】逐项比对，判断最有可能的品种"
            "（品种猫如英短/美短/布偶/暹罗/缅因等；若为本土猫请细分到狸花猫/橘猫/奶牛猫/三花猫等田园猫类型）\n"
            "2. 品相评估：毛色、花纹、体型、面部特征\n"
            "3. 健康观察：从图片中可见的健康状态（体型胖瘦、毛发质量、眼睛状态等）\n"
            "4. 年龄估算：根据体型和面部特征估算大致年龄段\n\n"
            f"【品种知识库】\n{breed_reference}\n\n"
            "请用中文回答，严格按以下 JSON 格式返回（不要包含 markdown 代码块标记）：\n"
            '{"breed": "品种名", "confidence": "高/中/低", "description": "详细描述", '
            '"appearance": {"color": "毛色", "pattern": "花纹", "body_type": "体型", '
            '"face_features": "面部特征"}, "health_observation": "健康观察", '
            '"estimated_age": "幼猫/青年/成年/老年", "notes": "补充说明"}'
        )

        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_data}"},
                    },
                    {
                        "type": "text",
                        "text": "请对照知识库鉴定这只猫的品种并提供详细分析。",
                    },
                ],
            },
        ]

        payload = {
            "model": model,
            "messages": messages,
            # MiniMax-M3、kimi-k2.6 等推理模型需要足够 token 预算，否则可能返回空 content
            "max_tokens": 8192,
        }
        # 仅当配置显式给出 temperature 时传递（部分推理模型只允许默认值）
        if temperature is not None:
            payload["temperature"] = temperature

        # 调用 API（空 content 时自动重试一次）
        try:
            data = self._call_api(base_url, api_key, payload)
            content = data["choices"][0]["message"].get("content") or ""
            if not content.strip():
                data = self._call_api(base_url, api_key, payload)
                content = data["choices"][0]["message"].get("content") or ""
            if not content.strip():
                return {"success": False, "error": "模型返回了空内容，请重试"}

            # 解析 JSON
            parsed = self._parse_json_response(content)

            # 识别后按品种检索知识库（详细知识返回给前端展示）
            breed = parsed.get("breed", "")
            knowledge = self.knowledge.get_breed_knowledge(breed)

            return {
                "success": True,
                "breed": breed,
                "confidence": parsed.get("confidence", "未知"),
                "description": parsed.get("description", ""),
                "appearance": parsed.get("appearance", {}),
                "health_observation": parsed.get("health_observation", ""),
                "estimated_age": parsed.get("estimated_age", ""),
                "notes": parsed.get("notes", ""),
                "model_used": f"{provider_name}/{model}",
                "knowledge": knowledge,
                "raw_response": content,
            }

        except httpx.HTTPStatusError as e:
            return {"success": False, "error": f"API 调用失败: {e.response.status_code} - {e.response.text[:300]}"}
        except Exception as e:
            return {"success": False, "error": f"识别失败: {type(e).__name__}: {e}"}

    def answer_question(
        self,
        question: str,
        provider: str | None = None,
        breed: str = "",
    ) -> dict:
        """先检索本地知识片段，再调用模型生成带来源的回答。"""
        question = question.strip()
        if not question:
            return {"success": False, "error": "问题不能为空"}

        pcfg = get_provider(provider)
        provider_name = pcfg.get("provider", "minimax")
        if not pcfg.get("api_key"):
            return {"success": False, "error": f"模型「{provider_name}」未配置 API 密钥"}

        query = f"{breed} {question}".strip()
        references = self.knowledge.search(query, top_k=5)
        context = "\n\n".join(
            f"【来源：{item['title']}】\n{item['content']}" for item in references
        ) or "（本地知识库没有检索到直接相关内容）"

        model = pcfg.get("default_model", "")
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是一位专业的猫咪知识顾问。优先依据给出的本地知识库片段回答，"
                        "不要编造医疗结论；涉及紧急健康风险时提示及时就医。回答使用中文，"
                        "简洁、清楚，并在相关句末标注来源标题。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"当前猫咪品种：{breed or '未指定'}\n\n"
                        f"本地知识库片段：\n{context}\n\n"
                        f"用户问题：{question}"
                    ),
                },
            ],
        }
        if provider_name == "minimax":
            payload.update({
                "max_completion_tokens": 2048,
                "temperature": 0.2,
                "thinking": {"type": "disabled"},
                "reasoning_split": True,
            })
        else:
            payload["max_tokens"] = 4096
            if pcfg.get("temperature") is not None:
                payload["temperature"] = pcfg["temperature"]

        try:
            content = ""
            for _ in range(2):
                data = self._call_api(
                    pcfg.get("base_url", "").rstrip("/"),
                    pcfg["api_key"],
                    payload,
                )
                choices = data.get("choices") or []
                message = choices[0].get("message", {}) if choices else {}
                content = (message.get("content") or "").strip()
                if content:
                    break
            if not content:
                return {"success": False, "error": "模型返回了空内容，请重试"}
            return {
                "success": True,
                "answer": content,
                "model_used": f"{provider_name}/{model}",
                "citations": [
                    {"id": item["id"], "title": item["title"], "source": item["source"]}
                    for item in references
                ],
            }
        except httpx.HTTPStatusError as error:
            detail = error.response.text[:300]
            return {
                "success": False,
                "error": f"API 调用失败: {error.response.status_code} - {detail}",
            }
        except Exception as error:
            return {"success": False, "error": f"AI 问答失败: {type(error).__name__}: {error}"}

    def _call_api(self, base_url: str, api_key: str, payload: dict) -> dict:
        resp = httpx.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=httpx.Timeout(180.0, connect=15.0),
        )
        resp.raise_for_status()
        return resp.json()

    # ── 响应解析 ────────────────────────────────

    def _parse_json_response(self, content: str) -> dict:
        """解析 LLM 返回的 JSON"""
        # 去除 markdown 代码块标记
        text = content.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines).strip()

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # 尝试用 json-repair 修复截断/不严格的 JSON
            try:
                from json_repair import repair_json

                repaired = repair_json(text, return_objects=True)
                if isinstance(repaired, dict) and repaired:
                    return repaired
            except Exception:
                pass
            # 尝试用正则提取 JSON
            match = re.search(r'\{.*\}', text, re.DOTALL)
            if match:
                try:
                    return json.loads(match.group())
                except json.JSONDecodeError:
                    try:
                        from json_repair import repair_json

                        repaired = repair_json(match.group(), return_objects=True)
                        if isinstance(repaired, dict) and repaired:
                            return repaired
                    except Exception:
                        pass
            # 回退：手动解析关键字段
            confidence = self._extract_field(text, "置信度", "confidence")
            return {
                "breed": self._extract_field(text, "品种", "breed"),
                "confidence": confidence if confidence != "未知" else "中",
                "description": text[:500],
                "appearance": {},
                "health_observation": "",
                "estimated_age": "",
                "notes": "",
            }

    def _extract_field(self, text: str, *keywords: str) -> str:
        """从文本中提取字段值"""
        for kw in keywords:
            patterns = [
                rf'{kw}["\']?\s*[:：]\s*["\']?([^"\'\n,}}]+)',
                rf'{kw}\s*[:：]\s*(.+)',
            ]
            for p in patterns:
                m = re.search(p, text, re.IGNORECASE)
                if m:
                    return m.group(1).strip().strip('",').strip()
        return "未知"


# 全局单例
_identifier: CatIdentifier | None = None


def get_identifier() -> CatIdentifier:
    global _identifier
    if _identifier is None:
        _identifier = CatIdentifier()
    return _identifier
