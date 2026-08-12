@echo off
chcp 65001 >nul
title Remove Anime Image
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)
echo ============================================
echo   Anime Image Remover
echo   Paste an image URL below when prompted.
echo ============================================
echo.
node scripts/remove-anime-image.mjs %*
echo.
echo Done.
pause
