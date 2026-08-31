@echo off
title Cat-AI 智能猫咪管家
cd /d "%~dp0"

echo ==========================================
echo    Cat-AI Service 启动器
echo ==========================================
echo.

REM ── 查找可用的 Python ─────────────────────────
set "PYEXE="

REM 1) 优先使用 Kimi Work 托管 Python（依赖已装好）
if exist "%APPDATA%\kimi-desktop\daimon-share\daimon\runtime\python\.venv\Scripts\python.exe" (
    set "PYEXE=%APPDATA%\kimi-desktop\daimon-share\daimon\runtime\python\.venv\Scripts\python.exe"
)

REM 2) 其次使用系统 PATH 中的 python
if not defined PYEXE (
    where python >nul 2>nul && set "PYEXE=python"
)

if not defined PYEXE (
    echo [错误] 未找到 Python，请先安装 Python 3.10+ 并加入 PATH。
    pause
    exit /b 1
)

echo 使用 Python: %PYEXE%
echo.

REM ── 检查依赖，缺失则自动安装 ──────────────────
"%PYEXE%" -c "import fastapi, uvicorn, httpx, multipart, PIL, json_repair" >nul 2>nul
if errorlevel 1 (
    echo 检测到缺少依赖，正在安装...
    "%PYEXE%" -m pip install -r backend\requirements.txt
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

REM ── 启动服务 ─────────────────────────────────
echo.
echo 服务启动后请在浏览器访问: http://localhost:7100
echo 按 Ctrl+C 可停止服务
echo.
"%PYEXE%" start.py --port 7100

pause
