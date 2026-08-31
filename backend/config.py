"""配置管理 — 读取 closeai.config.json 获取 API 配置（优先本地副本）"""

import json
import os
import sys
from pathlib import Path

# 项目根目录（cat-ai-service）。PyInstaller 单文件模式下优先使用 EXE
# 所在目录；若 EXE 位于 dist/，则回退到包含配置文件的上级项目目录。
if getattr(sys, "frozen", False):
    _EXE_DIR = Path(sys.executable).parent.resolve()
    PROJECT_ROOT = (
        _EXE_DIR
        if (_EXE_DIR / "closeai.config.json").exists()
        else _EXE_DIR.parent
    )
else:
    PROJECT_ROOT = Path(__file__).parent.parent.resolve()

# closeai.config.json：优先服务目录内的本地副本，其次上级目录
_LOCAL_CONFIG = PROJECT_ROOT / "closeai.config.json"
_PARENT_CONFIG = PROJECT_ROOT.parent / "closeai.config.json"
CONFIG_PATH = _LOCAL_CONFIG if _LOCAL_CONFIG.exists() else _PARENT_CONFIG


def load_config() -> dict:
    """加载 closeai.config.json"""
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


_config = load_config()

# ── 多模型供应商注册表 ─────────────────────────
# 每个供应商: {base_url, default_model, vision_model_patterns, temperature, api_key}
MODEL_PROVIDERS: dict[str, dict] = _config.get("models", {})

# 默认供应商（支持视觉且已配置密钥的优先）
DEFAULT_PROVIDER = "minimax"

# 兼容旧代码的全局默认
DEFAULT_MODEL_CONFIG = MODEL_PROVIDERS.get(DEFAULT_PROVIDER, {})
API_KEY = DEFAULT_MODEL_CONFIG.get("api_key", "")
BASE_URL = DEFAULT_MODEL_CONFIG.get("base_url", "https://api.minimaxi.com/v1")
MODEL = DEFAULT_MODEL_CONFIG.get("default_model", "MiniMax-M3")


def get_provider(name: str | None = None) -> dict:
    """获取指定供应商配置（含 provider 名），未指定则用默认

    支持 "provider/vision" 形式：使用该供应商配置的视觉模型
    （vision_model 字段），如 "minimax/vision" → MiniMax-VL-01。
    """
    name = name or DEFAULT_PROVIDER
    base, _, sub = name.partition("/")
    cfg = dict(MODEL_PROVIDERS.get(base) or {})
    cfg["provider"] = base
    if sub == "vision" and cfg.get("vision_model"):
        cfg["default_model"] = cfg["vision_model"]
    return cfg


def provider_supports_vision(provider_cfg: dict) -> bool:
    """判断供应商的默认模型是否支持视觉输入"""
    model = provider_cfg.get("default_model", "")
    patterns = provider_cfg.get("vision_model_patterns") or []
    return any(p and p in model for p in patterns)


def list_models() -> list[dict]:
    """列出所有可用模型（供前端选择）

    available: 已配置 API 密钥
    vision: 模型支持图片输入
    若供应商配置了独立的 vision_model（如 MiniMax-VL-01），
    额外生成一条 "<provider>/vision" 选项。
    """
    items = []
    for name, cfg in MODEL_PROVIDERS.items():
        cfg = cfg or {}
        available = bool(cfg.get("api_key"))
        items.append({
            "id": name,
            "label": f"{name} / {cfg.get('default_model', '?')}",
            "model": cfg.get("default_model", ""),
            "vision": provider_supports_vision(cfg),
            "available": available,
        })
        # 独立的视觉模型条目
        vision_model = cfg.get("vision_model")
        if vision_model and vision_model != cfg.get("default_model"):
            items.append({
                "id": f"{name}/vision",
                "label": f"{name} / {vision_model}（视觉）",
                "model": vision_model,
                "vision": True,
                "available": available,
            })
    return items


# 知识库目录：优先服务目录内的本地副本，其次上级目录
_LOCAL_KB = PROJECT_ROOT / "猫咪知识库"
_PARENT_KB = PROJECT_ROOT.parent / "猫咪知识库"
KNOWLEDGE_DIR = _LOCAL_KB if _LOCAL_KB.exists() else _PARENT_KB

# 数据存储路径
DATA_DIR = PROJECT_ROOT / "data"
PETS_DB = DATA_DIR / "pets.json"

# 确保数据目录存在
DATA_DIR.mkdir(parents=True, exist_ok=True)

# 服务配置 — 支持环境变量 / 命令行覆盖，默认 8503 供小程序本地联调
# 按当前调试部署要求开放到局域网/公网映射端口。
HOST = os.environ.get("HOST", "0.0.0.0")


def _parse_port() -> int:
    # 优先环境变量，其次命令行 --port
    if os.environ.get("PORT"):
        return int(os.environ["PORT"])
    argv = sys.argv[1:]
    for i, arg in enumerate(argv):
        if arg == "--port" and i + 1 < len(argv):
            return int(argv[i + 1])
        if arg.startswith("--port="):
            return int(arg.split("=", 1)[1])
    return 8503


PORT = _parse_port()
CORS_ORIGINS = ["*"]
