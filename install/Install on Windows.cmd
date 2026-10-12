@echo off
title Social Listener setup
echo Setting up Social Listener. Keep this window open until it says "All done".
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
