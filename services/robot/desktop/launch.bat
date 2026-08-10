@echo off
setlocal

REM Resolve script directory
set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%"

REM Find Python
where py >nul 2>&1
if %ERRORLEVEL%==0 (
    set "PY=py -3"
) else (
    where python >nul 2>&1
    if %ERRORLEVEL%==0 (
        set "PY=python"
    ) else (
        echo [ERROR] Python not found.
        goto :fail
    )
)

REM Ensure GUI dependencies
%PY% -c "import websockets, PySide6" >nul 2>&1
if errorlevel 1 (
    echo Installing GUI dependencies...
    %PY% -m pip install --quiet -r "%SCRIPT_DIR%requirements.txt"
)

REM Launch PySide6 app
title AGV Operator
echo Starting AGV Operator...
%PY% -m gui.main
if errorlevel 1 (
    echo.
    echo [ERROR] Python exited with code %ERRORLEVEL%
)
goto :done

:fail
echo Press any key to exit...
pause >nul

:done
popd
endlocal
