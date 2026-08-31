"""启动脚本 — 设置正确路径后启动 FastAPI 服务"""

import sys
from pathlib import Path

# 确保当前项目目录在 PYTHONPATH 中
SERVICE_ROOT = Path(__file__).parent.resolve()
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from uvicorn import run

from backend.config import HOST, PORT

if __name__ == "__main__":
    print("🐱 Cat-AI Service 启动中...")
    print(f"📂 服务目录: {SERVICE_ROOT}")
    print(f"🌐 访问地址: http://localhost:{PORT}")
    print("🛑 按 Ctrl+C 停止服务\n")

    run(
        "backend.main:app",
        host=HOST,
        port=PORT,
        reload=True,
        reload_dirs=[str(SERVICE_ROOT / "backend"), str(SERVICE_ROOT / "frontend")],
    )
