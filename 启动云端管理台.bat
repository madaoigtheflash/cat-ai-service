@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Cat-AI CloudBase 本地管理台

set "CAT_ADMIN_PYTHON="
set "CAT_ADMIN_PYTHON_ARGS="
set "CAT_ADMIN_INSTALL_PYTHON="
set "CAT_ADMIN_INSTALL_ARGS="

if exist "%~dp0.venv\Scripts\python.exe" (
  set "CAT_ADMIN_PYTHON=%~dp0.venv\Scripts\python.exe"
  goto :verify_selected_python
)

where py >nul 2>&1
if errorlevel 1 goto :try_path_python
py -3 -c "import fastapi, uvicorn" >nul 2>&1
if not errorlevel 1 goto :use_py_launcher
set "CAT_ADMIN_INSTALL_PYTHON=py"
set "CAT_ADMIN_INSTALL_ARGS=-3"

:try_path_python
where python >nul 2>&1
if errorlevel 1 goto :no_working_python
python -c "import fastapi, uvicorn" >nul 2>&1
if not errorlevel 1 goto :use_path_python
if defined CAT_ADMIN_INSTALL_PYTHON goto :dependency_missing
set "CAT_ADMIN_INSTALL_PYTHON=python"
set "CAT_ADMIN_INSTALL_ARGS="
goto :dependency_missing

:no_working_python
if defined CAT_ADMIN_INSTALL_PYTHON goto :dependency_missing
echo.
echo 未找到 Python 3。请先安装 Python 3.10 或更高版本，并勾选“Add Python to PATH”。
pause
exit /b 1

:use_py_launcher
set "CAT_ADMIN_PYTHON=py"
set "CAT_ADMIN_PYTHON_ARGS=-3"
goto :run_admin

:use_path_python
set "CAT_ADMIN_PYTHON=python"
set "CAT_ADMIN_PYTHON_ARGS="
goto :run_admin

:verify_selected_python
"%CAT_ADMIN_PYTHON%" %CAT_ADMIN_PYTHON_ARGS% -c "import fastapi, uvicorn" >nul 2>&1
if not errorlevel 1 goto :run_admin
set "CAT_ADMIN_INSTALL_PYTHON=%CAT_ADMIN_PYTHON%"
set "CAT_ADMIN_INSTALL_ARGS=%CAT_ADMIN_PYTHON_ARGS%"

:dependency_missing
echo.
echo 缺少 FastAPI 或 Uvicorn。请在当前目录执行：
echo   "%CAT_ADMIN_INSTALL_PYTHON%" %CAT_ADMIN_INSTALL_ARGS% -m pip install -r cloud_admin\requirements.txt
echo.
echo 推荐先按使用说明创建 .venv 虚拟环境。
pause
exit /b 1

:run_admin
"%CAT_ADMIN_PYTHON%" %CAT_ADMIN_PYTHON_ARGS% run_cloud_admin.py %*
if errorlevel 1 (
  echo.
  echo 管理台启动失败。请查看上方的具体错误和建议。
  pause
)

endlocal
