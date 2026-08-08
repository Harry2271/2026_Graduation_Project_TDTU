@echo off
cd /d "%~dp0"
call launch.bat
if errorlevel 1 (
    echo.
    echo App exited with an error.
    pause
)
