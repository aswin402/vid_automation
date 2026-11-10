@echo off
REM ============================================================================
REM CelestiaVid Desktop — Windows Command Prompt (cmd.exe) Bootstrapper
REM
REM One-line CMD usage:
REM   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/aswin402/vid_automation/main/install.ps1 | iex"
REM ============================================================================
setlocal
echo Launching CelestiaVid Windows Installer...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://raw.githubusercontent.com/aswin402/vid_automation/main/install.ps1 | iex"
exit /b %ERRORLEVEL%
