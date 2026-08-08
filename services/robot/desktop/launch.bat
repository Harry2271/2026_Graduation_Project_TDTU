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

REM Ensure websockets
%PY% -c "import websockets" >nul 2>&1
if errorlevel 1 (
    echo Installing websockets...
    %PY% -m pip install --quiet websockets
)

REM Launch app
title AGV Operator
echo Starting AGV Operator...
%PY% "%SCRIPT_DIR%operator_app.py"
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
