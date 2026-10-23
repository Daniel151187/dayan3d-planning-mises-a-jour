@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe. Installe la version LTS depuis https://nodejs.org puis relance ce fichier.
  pause
  exit /b 1
)
call npm install
call npm start
