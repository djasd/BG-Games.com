@echo off
echo Запуск сервера Яндекс.Музыка...
echo.

REM Убедитесь, что Яндекс.Музыка запущена с параметром:
REM --remote-debugging-port=9222

echo 📡 Запуск HTTP сервера на порту 3002...
echo 🔌 Запуск WebSocket сервера на порту 3002...
echo.

REM Запускаем наш сервер в фоне
start "YandexMusicServer" /B node setup.js

REM Ждем немного
timeout /t 3 /nobreak >nul

echo 🌐 Запуск ngrok для туннелирования...
echo.

REM Скачиваем ngrok (если нет)
if not exist ngrok.exe (
  echo 📥 Скачиваем ngrok...
  powershell -Command "Invoke-WebRequest -Uri 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip' -OutFile 'ngrok.zip'"
  powershell -Command "Expand-Archive -Path ngrok.zip -DestinationPath . -Force"
  del ngrok.zip
)

REM Устанавливаем токен ngrok (нужен аккаунт)
if not exist ngrok.yml (
  echo 🔑 Установите свой токен ngrok:
  echo ngrok config add-authtoken ВАШ_ТОКЕН
  pause
  exit /b 1
)

REM Запускаем туннель
ngrok http 3002

pause
