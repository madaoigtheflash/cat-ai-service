"""FastAPI 主服务 — 猫咪识别 API"""

import shutil
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from backend.cat_identifier import get_identifier
from backend.config import (
    API_KEY,
    CORS_ORIGINS,
    DATA_DIR,
    DEFAULT_PROVIDER,
    HOST,
    PORT,
    PROJECT_ROOT,
    list_models,
)
from backend.knowledge_service import get_knowledge_service
from backend.pet_registry import get_registry

app = FastAPI(
    title="Cat-AI Service",
    description="AI 猫咪品种识别 + 知识库 + 登记管理",
    version="1.0.0",
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 上传文件存储目录
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/api/health")
def health():
    return {"message": "Cat-AI Service", "version": "1.0.0", "status": "running"}


@app.get("/api/config")
def get_config():
    """获取服务配置（不含敏感信息）"""
    return {
        "api_key_configured": bool(API_KEY),
        "default_provider": DEFAULT_PROVIDER,
        "upload_dir": str(UPLOAD_DIR),
    }


@app.get("/api/models")
def get_models():
    """列出可选择的模型（含视觉能力与密钥配置状态）"""
    models = list_models()
    return {
        "default": DEFAULT_PROVIDER,
        "models": models,
    }


@app.post("/api/cat/identify")
async def identify_cat(image: UploadFile = File(...), model: str = Form("")):
    """上传猫咪照片，AI 识别品种并返回相关知识

    model: 可选，模型供应商标识（minimax/kimi/deepseek/...），空则用默认。
    """

    # 保存上传的图片
    ext = Path(image.filename).suffix.lower() if image.filename else ".jpg"
    safe_name = f"cat_{int(__import__('time').time())}{ext}"
    file_path = UPLOAD_DIR / safe_name

    try:
        with open(file_path, "wb") as f:
            shutil.copyfileobj(image.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存图片失败: {e}")
    finally:
        image.file.close()

    # AI 识别（识别前已在 prompt 中注入品种知识库）
    identifier = get_identifier()
    result = identifier.identify(file_path, provider=model or None)

    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error", "识别失败"))

    # 组装返回
    return {
        "success": True,
        "image_url": f"/uploads/{safe_name}",
        "model_used": result.get("model_used", ""),
        "identification": {
            "breed": result["breed"],
            "confidence": result["confidence"],
            "description": result["description"],
            "appearance": result.get("appearance", {}),
            "health_observation": result.get("health_observation", ""),
            "estimated_age": result.get("estimated_age", ""),
            "notes": result.get("notes", ""),
        },
        "knowledge": result.get("knowledge", {}),
    }


def _search_knowledge(query: str, top_k: int = 5):
    kb = get_knowledge_service()
    results = kb.search(query, top_k=top_k)
    return {
        "query": query,
        "results": results,
        "count": len(results),
    }


@app.post("/api/cat/knowledge/search")
def search_knowledge(query: str = Form(...), top_k: int = Form(5)):
    """仅检索本地知识库，不调用 AI。"""
    return _search_knowledge(query, top_k)


@app.post("/api/cat/knowledge/ask")
def ask_knowledge(
    query: str = Form(...),
    breed: str = Form(""),
    model: str = Form(""),
):
    """检索本地知识库后调用 AI 生成回答。"""
    result = get_identifier().answer_question(query, provider=model or None, breed=breed)
    if not result.get("success"):
        raise HTTPException(status_code=502, detail=result.get("error", "AI 问答失败"))
    return result


@app.post("/api/cat/knowledge")
def query_knowledge(query: str = Form(...), top_k: int = Form(5)):
    """兼容旧客户端：仅执行本地知识库检索。"""
    return _search_knowledge(query, top_k)


@app.post("/api/cat/health-check")
def health_check(symptoms: str = Form(...)):
    """症状查询，返回健康警告"""
    kb = get_knowledge_service()
    result = kb.get_health_warning(symptoms)
    return result


@app.post("/api/cat/register")
def register_pet(
    name: str = Form(...),
    breed: str = Form(...),
    breed_confidence: str = Form(""),
    color: str = Form(""),
    pattern: str = Form(""),
    estimated_age: str = Form(""),
    gender: str = Form("未知"),
    weight: float = Form(0.0),
    health_status: str = Form(""),
    avatar_path: str = Form(""),
    notes: str = Form(""),
    knowledge_summary: str = Form(""),
):
    """登记宠物"""
    registry = get_registry()
    pet = registry.register(
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
    return {
        "success": True,
        "pet": pet.to_dict(),
        "message": f"「{name}」登记成功！",
    }


@app.get("/api/cat/pets")
def list_pets():
    """列出所有已登记宠物"""
    registry = get_registry()
    pets = [p.to_dict() for p in registry.list_all()]
    return {
        "count": len(pets),
        "pets": pets,
    }


@app.get("/api/cat/pets/{pet_id}")
def get_pet(pet_id: str):
    """获取单个宠物详情"""
    registry = get_registry()
    pet = registry.get(pet_id)
    if not pet:
        raise HTTPException(status_code=404, detail="宠物不存在")
    return {"pet": pet.to_dict()}


@app.put("/api/cat/pets/{pet_id}")
def update_pet(pet_id: str, updates: dict = Body(...)):
    """更新宠物信息（JSON body，仅更新 Pet 已有字段）"""
    registry = get_registry()
    allowed = {
        "name", "breed", "breed_confidence", "color", "pattern",
        "estimated_age", "birth_date", "gender", "weight", "is_neutered",
        "microchip", "health_status", "avatar_path", "notes", "knowledge_summary",
    }
    clean = {k: v for k, v in updates.items() if k in allowed}
    pet = registry.update(pet_id, **clean)
    if not pet:
        raise HTTPException(status_code=404, detail="宠物不存在")
    return {"success": True, "pet": pet.to_dict()}


# ── 子记录接口：疫苗 / 驱虫 / 体重 / 医疗 ──────────

RECORD_KINDS = {"vaccines", "deworming", "weights", "medical"}


@app.post("/api/cat/pets/{pet_id}/records/{kind}")
def add_pet_record(pet_id: str, kind: str, record: dict = Body(...)):
    """给宠物添加子记录

    kind: vaccines | deworming | weights | medical
    """
    if kind not in RECORD_KINDS:
        raise HTTPException(status_code=400, detail=f"不支持的记录类型: {kind}")
    registry = get_registry()
    saved = registry.add_record(pet_id, kind, record)
    if not saved:
        raise HTTPException(status_code=404, detail="宠物不存在")
    return {"success": True, "record": saved}


@app.delete("/api/cat/pets/{pet_id}/records/{kind}/{record_id}")
def delete_pet_record(pet_id: str, kind: str, record_id: str):
    """删除一条子记录"""
    if kind not in RECORD_KINDS:
        raise HTTPException(status_code=400, detail=f"不支持的记录类型: {kind}")
    registry = get_registry()
    if registry.delete_record(pet_id, kind, record_id):
        return {"success": True, "message": "记录已删除"}
    raise HTTPException(status_code=404, detail="记录或宠物不存在")


@app.delete("/api/cat/pets/{pet_id}")
def delete_pet(pet_id: str):
    """删除宠物"""
    registry = get_registry()
    if registry.delete(pet_id):
        return {"success": True, "message": "删除成功"}
    raise HTTPException(status_code=404, detail="宠物不存在")


@app.post("/api/cat/pets/{pet_id}/reidentify")
async def reidentify_pet(pet_id: str, image: UploadFile = File(...), model: str = Form("")):
    """为已登记的猫咪重新拍照识别

    保存新照片 → AI 识别（注入知识库）→ 自动更新头像，
    识别结果返回给前端预览，由用户决定是否写入档案字段。
    """
    registry = get_registry()
    pet = registry.get(pet_id)
    if not pet:
        raise HTTPException(status_code=404, detail="宠物不存在")

    # 保存上传的图片
    ext = Path(image.filename).suffix.lower() if image.filename else ".jpg"
    safe_name = f"pet_{pet_id}_{int(__import__('time').time())}{ext}"
    file_path = UPLOAD_DIR / safe_name
    try:
        with open(file_path, "wb") as f:
            shutil.copyfileobj(image.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存图片失败: {e}")
    finally:
        image.file.close()

    # AI 识别
    identifier = get_identifier()
    result = identifier.identify(file_path, provider=model or None)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error", "识别失败"))

    # 新照片自动设为头像
    image_url = f"/uploads/{safe_name}"
    registry.update(pet_id, avatar_path=image_url)

    return {
        "success": True,
        "image_url": image_url,
        "model_used": result.get("model_used", ""),
        "identification": {
            "breed": result["breed"],
            "confidence": result["confidence"],
            "description": result["description"],
            "appearance": result.get("appearance", {}),
            "health_observation": result.get("health_observation", ""),
            "estimated_age": result.get("estimated_age", ""),
            "notes": result.get("notes", ""),
        },
        "knowledge": result.get("knowledge", {}),
    }


# 静态文件服务 — 上传的图片
@app.get("/uploads/{filename}")
def serve_upload(filename: str):
    file_path = UPLOAD_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(file_path)


# 静态文件服务 — 前端
@app.get("/{path:path}")
def serve_frontend(path: str = ""):
    """提供前端静态文件"""
    frontend_dir = (PROJECT_ROOT / "frontend").resolve()
    if not path or path == "/":
        path = "index.html"
    file_path = (frontend_dir / path).resolve()
    try:
        file_path.relative_to(frontend_dir)
    except ValueError:
        raise HTTPException(status_code=404, detail="文件不存在")
    if file_path.exists() and file_path.is_file():
        return FileResponse(file_path)
    # fallback to index.html
    index = frontend_dir / "index.html"
    if index.exists():
        return FileResponse(index)
    raise HTTPException(status_code=404, detail="前端文件未找到")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.main:app", host=HOST, port=PORT, reload=True)
