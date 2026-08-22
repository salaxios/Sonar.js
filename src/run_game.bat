@echo off
title RMMZ Native Runner (Sonar.js)

:: Enable incremental tilemap (replaces full Mode 7 40x40 repaints with 1-row/col delta updates)
set SONAR_TILEMAP_INCREMENTAL=1


:: Enable Tracy profiling zones (set to 1 to profile with Tracy GUI, or 0 for max speed)
set SONAR_TRACY=1

:: Optional: Debug log for tilemap shifts (set to 1 only if you want console spam)
set SONAR_TILEMAP_DEBUG=0

echo ===================================================
echo Launching RMMZ Native with Optimizations...
echo SONAR_TILEMAP_INCREMENTAL = %SONAR_TILEMAP_INCREMENTAL%
echo SONAR_BATCH_UPLOADS       = %SONAR_BATCH_UPLOADS%
echo SONAR_TRACY               = %SONAR_TRACY%
echo ===================================================

rmmz_native.exe

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Game crashed or exited with code %ERRORLEVEL%
    pause
)