"""Cat-AI Windows EXE 入口。"""

import os
import socket
import sys
from pathlib import Path


HOST = "0.0.0.0"
PORT = 8503


def runtime_root() -> Path:
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).parent.resolve()
        if (exe_dir / "closeai.config.json").exists():
            return exe_dir
        return exe_dir.parent
    return Path(__file__).parent.resolve()


def port_is_available() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((HOST, PORT))
        except OSError:
            return False
    return True


def main() -> int:
    root = runtime_root()
    os.chdir(root)
    os.environ["HOST"] = HOST
    os.environ["PORT"] = str(PORT)

    print("=" * 62)
    print(" Cat-AI FastAPI Server")
    print("=" * 62)
    print(f" Project: {root}")
    print(f" Local:   http://localhost:{PORT}")
    print(f" Public:  http://yacoyacoyaco.asuscomm.com:{PORT}")
    print(" Warning: current public HTTP API has no user authentication.")
    print(" Press Ctrl+C to stop the server.\n")

    if not (root / "closeai.config.json").exists():
        print("[ERROR] closeai.config.json was not found beside the EXE or in its parent folder.")
        input("Press Enter to exit...")
        return 2
    if not (root / "猫咪知识库").exists():
        print("[ERROR] 猫咪知识库 folder was not found beside the EXE or in its parent folder.")
        input("Press Enter to exit...")
        return 3
    if not port_is_available():
        print(f"[ERROR] Port {PORT} is already in use. The server may already be running.")
        input("Press Enter to exit...")
        return 4

    import uvicorn

    try:
        uvicorn.run(
            "backend.main:app",
            host=HOST,
            port=PORT,
            reload=False,
            access_log=True,
        )
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
