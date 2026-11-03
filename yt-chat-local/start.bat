@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Chua cai Node.js. Tai ban LTS o https://nodejs.org roi chay lai. & pause & exit /b)
if not exist config.json (echo Chua co config.json: doi ten config.example.json thanh config.json va dan API key vao. & pause & exit /b)
rem Doc cong tu config.json (mac dinh 8787)
set PORT=8787
for /f %%p in ('powershell -nologo -noprofile -command "try{(Get-Content -Raw config.json ^| ConvertFrom-Json).port}catch{}"') do set PORT=%%p
curl -s -m 2 http://127.0.0.1:%PORT%/api/status >nul 2>nul && (echo App dang chay san roi, mo lai trang chinh sua. & start "" http://127.0.0.1:%PORT%/ & timeout /t 2 >nul & exit /b)
if not exist node_modules call npm install --omit=dev --no-audit --no-fund
rem Chay an hoan toan (khong hien cua so); log ghi vao app.log; theo doi/tat bang icon canh dong ho
powershell -nologo -noprofile -command "Start-Process cmd -ArgumentList '/c','node --max-old-space-size=64 server.js > app.log 2>&1' -WindowStyle Hidden"
echo App dang chay nen o cong %PORT%. Xem icon (nut play tron) canh dong ho, chuot phai de Stop. Hoac chay stop.bat.
timeout /t 3 >nul
