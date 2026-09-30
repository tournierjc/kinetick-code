@echo off
setlocal
if not defined __MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE (
  echo KCode mcode-tools runtime is unavailable. Restart KCode. 1>&2
  exit /b 1
)
"%__MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE%" "%~dp0..\mcode-tools.js" %*
exit /b %errorlevel%
