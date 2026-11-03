@echo off
cd /d "%~dp0"
rem Doc cong tu config.json (mac dinh 8787)
set PORT=8787
for /f %%p in ('powershell -nologo -noprofile -command "try{(Get-Content -Raw config.json ^| ConvertFrom-Json).port}catch{}"') do set PORT=%%p
curl -s -m 3 -X POST -H "x-local: 1" http://127.0.0.1:%PORT%/api/quit >nul 2>nul && (echo Da tat app o cong %PORT%.) || (echo Khong thay app dang chay o cong %PORT%.)
timeout /t 2 >nul
