@echo off
rem Inicia nAnOresolve. La primera vez instala las dependencias (requiere Node.js 22 o superior).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instalalo desde https://nodejs.org y vuelve a intentarlo.
  pause
  exit /b 1
)
if not exist "node_modules\electron" (
  echo Instalando dependencias, esto solo ocurre la primera vez...
  call npm install
  if errorlevel 1 (
    echo No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
)
call npm start
