"""宠物登记与档案管理 — JSON 文件存储

档案结构：
  基础信息：姓名/品种/性别/生日/体重/毛色/绝育/芯片号…
  子记录：  vaccines(疫苗) / deworming(驱虫) / weights(体重) / medical(医疗)
"""

import json
import time
import uuid
from pathlib import Path
from typing import Optional

from backend.config import PETS_DB

# 子记录类型白名单
RECORD_KINDS = ("vaccines", "deworming", "weights", "medical")

# Pet 基础字段（用于 from_dict 过滤，兼容旧数据）
_PET_FIELDS = {
    "id", "name", "breed", "breed_confidence", "color", "pattern",
    "estimated_age", "birth_date", "gender", "weight", "is_neutered",
    "microchip", "health_status", "avatar_path", "notes",
    "knowledge_summary", "vaccines", "deworming", "weights", "medical",
    "created_at", "updated_at",
}


class Pet:
    """宠物档案模型"""

    def __init__(
        self,
        id: str = "",
        name: str = "",
        breed: str = "",
        breed_confidence: str = "",
        color: str = "",
        pattern: str = "",
        estimated_age: str = "",
        birth_date: str = "",          # 出生日期 YYYY-MM-DD
        gender: str = "未知",
        weight: float = 0.0,
        is_neutered: bool = False,      # 是否绝育
        microchip: str = "",            # 芯片号
        health_status: str = "",
        avatar_path: str = "",
        notes: str = "",
        knowledge_summary: str = "",
        vaccines: list | None = None,   # 疫苗记录
        deworming: list | None = None,  # 驱虫记录
        weights: list | None = None,    # 体重历史
        medical: list | None = None,    # 医疗记录
        created_at: float = 0,
        updated_at: float = 0,
    ):
        self.id = id or str(uuid.uuid4())[:8]
        self.name = name
        self.breed = breed
        self.breed_confidence = breed_confidence
        self.color = color
        self.pattern = pattern
        self.estimated_age = estimated_age
        self.birth_date = birth_date
        self.gender = gender
        self.weight = weight
        self.is_neutered = is_neutered
        self.microchip = microchip
        self.health_status = health_status
        self.avatar_path = avatar_path
        self.notes = notes
        self.knowledge_summary = knowledge_summary
        self.vaccines = vaccines or []
        self.deworming = deworming or []
        self.weights = weights or []
        self.medical = medical or []
        self.created_at = created_at or time.time()
        self.updated_at = updated_at or time.time()

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "breed": self.breed,
            "breed_confidence": self.breed_confidence,
            "color": self.color,
            "pattern": self.pattern,
            "estimated_age": self.estimated_age,
            "birth_date": self.birth_date,
            "gender": self.gender,
            "weight": self.weight,
            "is_neutered": self.is_neutered,
            "microchip": self.microchip,
            "health_status": self.health_status,
            "avatar_path": self.avatar_path,
            "notes": self.notes,
            "knowledge_summary": self.knowledge_summary,
            "vaccines": self.vaccines,
            "deworming": self.deworming,
            "weights": self.weights,
            "medical": self.medical,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Pet":
        # 过滤未知字段，兼容旧版本数据
        return cls(**{k: v for k, v in d.items() if k in _PET_FIELDS})


class PetRegistry:
    """宠物登记管理器"""

    def __init__(self, db_path: Path = PETS_DB):
        self.db_path = db_path
        self._pets: dict[str, Pet] = {}
        self._load()

    def _load(self):
        """从 JSON 文件加载"""
        if self.db_path.exists():
            try:
                with open(self.db_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                for item in data.get("pets", []):
                    pet = Pet.from_dict(item)
                    self._pets[pet.id] = pet
            except (json.JSONDecodeError, KeyError):
                pass

    def _save(self):
        """保存到 JSON 文件"""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "version": "1.1",
            "updated_at": time.time(),
            "pets": [p.to_dict() for p in self._pets.values()],
        }
        with open(self.db_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def register(
        self,
        name: str,
        breed: str,
        breed_confidence: str = "",
        color: str = "",
        pattern: str = "",
        estimated_age: str = "",
        gender: str = "未知",
        weight: float = 0.0,
        health_status: str = "",
        avatar_path: str = "",
        notes: str = "",
        knowledge_summary: str = "",
    ) -> Pet:
        """登记新宠物"""
        pet = Pet(
            name=name,
            breed=breed,
            breed_confidence=breed_confidence,
            color=color,
            pattern=pattern,
            estimated_age=estimated_age,
            gender=gender,
            weight=weight,
            health_status=health_status,
            avatar_path=avatar_path,
            notes=notes,
            knowledge_summary=knowledge_summary,
        )
        self._pets[pet.id] = pet
        self._save()
        return pet

    def get(self, pet_id: str) -> Optional[Pet]:
        """按 ID 查询"""
        return self._pets.get(pet_id)

    def list_all(self) -> list[Pet]:
        """列出所有宠物"""
        return sorted(self._pets.values(), key=lambda p: p.created_at, reverse=True)

    def update(self, pet_id: str, **kwargs) -> Optional[Pet]:
        """更新宠物信息"""
        pet = self._pets.get(pet_id)
        if not pet:
            return None
        for key, value in kwargs.items():
            if hasattr(pet, key):
                setattr(pet, key, value)
        pet.updated_at = time.time()
        self._save()
        return pet

    def delete(self, pet_id: str) -> bool:
        """删除宠物"""
        if pet_id in self._pets:
            del self._pets[pet_id]
            self._save()
            return True
        return False

    # ── 子记录管理 ──────────────────────────────

    def add_record(self, pet_id: str, kind: str, record: dict) -> Optional[dict]:
        """给宠物添加一条子记录（疫苗/驱虫/体重/医疗）

        自动补充 id 与 created_at；体重记录同时更新当前体重。
        """
        if kind not in RECORD_KINDS:
            return None
        pet = self._pets.get(pet_id)
        if not pet:
            return None
        record = dict(record)
        record["id"] = str(uuid.uuid4())[:8]
        record["created_at"] = time.time()
        getattr(pet, kind).append(record)

        # 体重记录联动：更新档案当前体重
        if kind == "weights":
            try:
                pet.weight = float(record.get("weight") or pet.weight)
            except (TypeError, ValueError):
                pass
        # 体重历史按日期排序
        if kind == "weights":
            pet.weights.sort(key=lambda r: r.get("date", ""))

        pet.updated_at = time.time()
        self._save()
        return record

    def delete_record(self, pet_id: str, kind: str, record_id: str) -> bool:
        """删除一条子记录"""
        if kind not in RECORD_KINDS:
            return False
        pet = self._pets.get(pet_id)
        if not pet:
            return False
        records = getattr(pet, kind)
        before = len(records)
        setattr(pet, kind, [r for r in records if r.get("id") != record_id])
        if len(getattr(pet, kind)) == before:
            return False
        pet.updated_at = time.time()
        self._save()
        return True

    def count(self) -> int:
        return len(self._pets)


# 全局单例
_registry: PetRegistry | None = None


def get_registry() -> PetRegistry:
    global _registry
    if _registry is None:
        _registry = PetRegistry()
    return _registry
