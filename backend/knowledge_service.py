"""知识库检索服务 — 基于现有的 KnowledgeBase 封装猫咪知识检索"""

import re
import sys
from pathlib import Path

# 将 closeai 所在的项目根目录加入路径以复用 KnowledgeBase
# （closeai 是一个包，需要其父目录在 sys.path 中才能 `import closeai.knowledge...`）
CAT_AI_ROOT = Path(__file__).parent.parent.parent.resolve()
if str(CAT_AI_ROOT) not in sys.path:
    sys.path.insert(0, str(CAT_AI_ROOT))

from closeai.knowledge.knowledge_base import KnowledgeBase
from backend.config import KNOWLEDGE_DIR


class CatKnowledgeService:
    """猫咪知识库服务"""

    def __init__(self, knowledge_dir: str | Path = KNOWLEDGE_DIR):
        self.knowledge_dir = Path(knowledge_dir)
        self.kb = KnowledgeBase(str(self.knowledge_dir))
        self._chunks = self._load_chunks()

    def _load_chunks(self) -> list[dict]:
        """按 Markdown 标题切分，避免返回整篇文档开头。"""
        chunks: list[dict] = []
        for path in sorted(self.knowledge_dir.glob("*.md")):
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue

            sections = re.split(r"(?m)(?=^#{1,4}\s+)", text)
            for section_index, section in enumerate(sections):
                section = section.strip()
                if not section:
                    continue
                first_line = section.splitlines()[0].lstrip("# ").strip()
                title = first_line if first_line else path.stem
                # 超长章节继续分片，并保留少量重叠上下文。
                start = 0
                part = 1
                while start < len(section):
                    content = section[start:start + 1400].strip()
                    if content:
                        suffix = f"（{part}）" if len(section) > 1400 else ""
                        chunks.append({
                            "id": f"{path.name}#{section_index}-{part}",
                            "source": path.name,
                            "title": f"{path.stem} · {title}{suffix}",
                            "content": content,
                            "type": "markdown",
                        })
                    if start + 1400 >= len(section):
                        break
                    start += 1200
                    part += 1
        return chunks

    @staticmethod
    def _expand_query(query: str) -> list[str]:
        normalized = query.lower().strip()
        terms: set[str] = set(re.findall(r"[a-z0-9_-]{2,}", normalized))
        for run in re.findall(r"[\u4e00-\u9fff]+", normalized):
            if 2 <= len(run) <= 8:
                terms.add(run)
            for width in (2, 3):
                for index in range(max(0, len(run) - width + 1)):
                    terms.add(run[index:index + width])

        intent_terms = {
            ("不能吃", "吃什么", "禁食", "有毒"): ("饮食", "禁忌", "有毒", "中毒", "食物"),
            ("什么病", "容易得", "生病", "疾病"): ("健康", "疾病", "遗传病", "常见病", "症状"),
            ("性格", "特征", "特点"): ("性格", "特征", "外观", "体型", "被毛"),
            ("疫苗", "驱虫"): ("疫苗", "驱虫", "免疫", "接种"),
            ("价格", "多少钱", "贵不贵"): ("价格", "市场价", "宠物级", "赛级"),
            ("喂养", "饲养", "护理"): ("饲养", "护理", "喂食", "饮食"),
        }
        for triggers, additions in intent_terms.items():
            if any(trigger in normalized for trigger in triggers):
                terms.update(additions)

        aliases = {
            "英短": "英国短毛猫", "美短": "美国短毛猫", "布偶": "布偶猫",
            "狸花": "狸花猫", "暹罗": "暹罗猫", "缅因": "缅因猫",
            "加菲": "异国短毛猫", "无毛猫": "斯芬克斯猫",
        }
        for alias, full_name in aliases.items():
            if alias in normalized or full_name in normalized:
                terms.update((alias, full_name))
        return sorted((term for term in terms if len(term) > 1), key=len, reverse=True)

    def search(self, query: str, top_k: int = 5) -> list[dict]:
        """搜索知识库"""
        query = query.strip()
        if not query:
            return []
        terms = self._expand_query(query)
        normalized_query = re.sub(r"\s+", "", query.lower())
        scored: list[tuple[float, dict]] = []
        for chunk in self._chunks:
            title = chunk["title"].lower()
            content = chunk["content"].lower()
            compact = re.sub(r"\s+", "", title + content)
            score = 0.0
            if normalized_query and normalized_query in compact:
                score += 30.0
            for term in terms:
                count = min(compact.count(term), 6)
                if not count:
                    continue
                weight = min(len(term), 5)
                score += count * weight
                if term in title:
                    score += weight * 3
            source_boosts = (
                (("什么病", "容易得", "生病", "疾病", "健康"), ("06_", "09_")),
                (("不能吃", "吃什么", "饮食", "禁忌", "有毒"), ("08_",)),
                (("疫苗", "驱虫", "绝育"), ("07_",)),
                (("价格", "多少钱", "贵不贵", "市场价"), ("05_",)),
                (("品相", "外观", "毛色", "花纹"), ("04_", "09_")),
            )
            for triggers, prefixes in source_boosts:
                if any(trigger in query.lower() for trigger in triggers) and chunk["source"].startswith(prefixes):
                    score += 24.0
            if score > 0:
                scored.append((score, chunk))

        scored.sort(key=lambda item: item[0], reverse=True)
        results = []
        for score, chunk in scored[:max(1, min(top_k, 10))]:
            result = dict(chunk)
            result["score"] = round(score, 2)
            results.append(result)
        return results

    def get_breed_knowledge(self, breed: str) -> dict:
        """获取特定品种的全面知识

        返回: {
            "breed": 品种名,
            "basic": 基础信息（性格、体型、被毛）,
            "health": 健康相关知识,
            "care": 饲养建议,
            "sources": 来源文件列表
        }
        """
        basic = self.search(f"{breed} 品种特征 性格 外观", top_k=3)
        health = self.search(f"{breed} 常见健康问题 遗传病", top_k=3)
        care = self.search(f"{breed} 饲养护理 饮食", top_k=3)
        price = self.search(f"{breed} 市场价格 品相", top_k=2)
        sources = []
        for result in basic + health + care + price:
            if result["source"] not in sources:
                sources.append(result["source"])

        return {
            "breed": breed,
            "basic": self._format_results(basic[:3]),
            "health": self._format_results(health[:3]),
            "care": self._format_results(care[:3]),
            "price": self._format_results(price[:2]),
            "sources": sources[:8],
        }

    def _format_results(self, results: list[dict]) -> str:
        """将检索结果格式化为文本"""
        if not results:
            return "暂无相关知识。"
        parts = []
        for r in results:
            parts.append(f"【{r['title']}】\n{r['content'][:1000]}")
        return "\n\n".join(parts)

    def get_health_warning(self, symptoms: str) -> dict:
        """根据症状检索健康警告"""
        results = self.kb.search(symptoms, top_k=5)
        urgent = []
        warning = []
        for r in results:
            content = r["content"]
            if "🚨" in content or "立即就医" in content or "48小时" in content or "致命" in content:
                urgent.append(r)
            elif "⚠️" in content or "就医" in content:
                warning.append(r)
        return {
            "urgent": self._format_results(urgent[:2]),
            "warning": self._format_results(warning[:2]),
            "all": self._format_results(results[:3]),
        }


# 全局单例
_knowledge_service: CatKnowledgeService | None = None


def get_knowledge_service() -> CatKnowledgeService:
    global _knowledge_service
    if _knowledge_service is None:
        _knowledge_service = CatKnowledgeService()
    return _knowledge_service
