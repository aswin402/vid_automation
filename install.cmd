@echo off
REM ============================================================================
REM CelestiaVid Studio — Windows Command Prompt (cmd.exe) Installer & Updater
REM
REM One-line CMD usage:
REM   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/aswin402/vid_automation/main/install.ps1 | iex"
REM ============================================================================
setlocal
chcp 65001 >nul 2>&1
if exist "%~dp0install.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://raw.githubusercontent.com/aswin402/vid_automation/main/install.ps1 | iex"
)
exit /b %ERRORLEVEL%
