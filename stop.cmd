@echo off
rem Doppio clic per fermare server Node e Ollama.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*
pause
