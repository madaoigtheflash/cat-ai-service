"""端到端 API 验证脚本 — 需要服务已在 127.0.0.1:7100 运行"""

import json

import httpx

BASE = "http://127.0.0.1:7100"
CAT_IMG = "data/test/cat1.jpg"


def main():
    client = httpx.Client(base_url=BASE, timeout=120.0)

    # 1. 前端首页
    r = client.get("/")
    assert r.status_code == 200 and "Cat-AI" in r.text, f"首页异常: {r.status_code}"
    print("1. 前端首页 OK", "| 包含标题:", "智能猫咪管家" in r.text)

    # 2. 健康检查
    r = client.get("/api/health")
    print("2. 健康检查 OK:", r.json())

    # 2b. 模型列表
    r = client.get("/api/models")
    d = r.json()
    print(f"2b. 模型列表 OK (默认: {d['default']}):")
    for m in d["models"]:
        print(f"    - {m['id']:<10} vision={m['vision']!s:<5} available={m['available']!s:<5} {m['model']}")

    # 2c. 非视觉模型应返回友好错误
    with open(CAT_IMG, "rb") as f:
        r = client.post("/api/cat/identify", files={"image": ("cat1.jpg", f, "image/jpeg")}, data={"model": "deepseek"})
    assert r.status_code == 500 and "不支持图片" in r.json().get("detail", ""), f"非视觉模型校验异常: {r.status_code} {r.text[:200]}"
    print("2c. 非视觉模型拦截 OK:", r.json()["detail"][:50])

    # 3. 知识库检索
    r = client.post("/api/cat/knowledge", data={"query": "布偶猫 性格 特征", "top_k": 3})
    d = r.json()
    print(f"3. 知识库检索 OK: {d['count']} 条结果")
    for item in d["results"][:2]:
        print("   -", item["id"], "score:", item["score"])

    # 4. AI 识别（真实猫图 + Kimi Vision + 知识库）
    with open(CAT_IMG, "rb") as f:
        r = client.post("/api/cat/identify", files={"image": ("cat1.jpg", f, "image/jpeg")}, data={"model": "kimi"})
    d = r.json()
    if not d.get("success"):
        print("4. 识别 FAILED:", json.dumps(d, ensure_ascii=False)[:500])
        return
    i = d["identification"]
    print("4. AI 识别 OK | 使用模型:", d.get("model_used"))
    print("   品种:", i["breed"], "| 置信度:", i["confidence"], "| 年龄:", i.get("estimated_age"))
    print("   外观:", i.get("appearance"))
    print("   健康观察:", (i.get("health_observation") or "")[:150])
    print("   描述:", (i.get("description") or "")[:150])
    print("   知识库字段:", list(d.get("knowledge", {}).keys()))
    print("   图片URL:", d.get("image_url"))

    # 5. 登记建档（模拟前端：识别结果 → 登记）
    form = {
        "name": "测试虎斑",
        "breed": i["breed"],
        "breed_confidence": i["confidence"],
        "color": i.get("appearance", {}).get("color", ""),
        "pattern": i.get("appearance", {}).get("pattern", ""),
        "estimated_age": i.get("estimated_age", ""),
        "gender": "未知",
        "weight": "4.2",
        "health_status": i.get("health_observation", ""),
        "avatar_path": d.get("image_url", ""),
        "notes": "端到端测试登记",
        "knowledge_summary": (d.get("knowledge", {}).get("basic") or "")[:500],
    }
    r = client.post("/api/cat/register", data=form)
    reg = r.json()
    assert reg.get("success"), f"登记失败: {reg}"
    pet_id = reg["pet"]["id"]
    print("5. 登记建档 OK:", reg["message"], "| id:", pet_id, "| avatar:", reg["pet"]["avatar_path"])

    # 6. 列表 / 详情 / 更新 / 删除
    r = client.get("/api/cat/pets")
    print(f"6a. 宠物列表 OK: {r.json()['count']} 只")

    r = client.get(f"/api/cat/pets/{pet_id}")
    print("6b. 详情 OK:", r.json()["pet"]["name"])

    r = client.put(f"/api/cat/pets/{pet_id}", json={"weight": 4.5, "notes": "更新测试"})
    print("6c. 更新 OK:", r.json()["pet"]["weight"], "|", r.json()["pet"]["notes"])

    r = client.delete(f"/api/cat/pets/{pet_id}")
    print("6d. 删除 OK:", r.json())

    # 7. 症状查询
    r = client.post("/api/cat/health-check", data={"symptoms": "呕吐 拉稀 精神萎靡"})
    d = r.json()
    print("7. 症状查询 OK:", {k: (v[:30] + "...") if isinstance(v, str) and v else v for k, v in d.items()})

    print("\n✅ 全部端到端测试通过")


if __name__ == "__main__":
    main()
