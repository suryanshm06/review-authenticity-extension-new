
@echo off
cd /d "%~dp0"

:: Open CMD 1 - Python Model Service
start "Python Model Service" cmd /k "python -m venv venv && call venv\Scripts\activate.bat && python -m pip install --upgrade pip && python -m pip install --upgrade -r model\requirements.txt && python model\model_service.py"

:: Open CMD 2 - Node.js Application
start "Node.js Application" cmd /k "npm start"

exit