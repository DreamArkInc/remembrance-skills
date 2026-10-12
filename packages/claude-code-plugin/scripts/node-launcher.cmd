@echo off
rem Remembrance Node.js launcher for Windows: node-launcher.cmd <script.mjs> [args...]
rem
rem Windows twin of the POSIX scripts/node-launcher. Claude Code's MCP entry
rem names the extensionless scripts/node-launcher; on native Windows Claude Code
rem resolves that name through PATHEXT (cross-spawn) and runs this file through
rem cmd.exe instead, so the MCP server needs no sh. Keep CRLF line endings
rem (.gitattributes). It finds a Node.js at or above the bundled MCP server's
rem engines floor (_min below, kept equal to packages/mcp-server/package.json by
rem the launcher tests) and runs the script with it. It never reads stdin and
rem never writes to stdout, which is the MCP transport.
rem
rem Search order; the first acceptable candidate wins:
rem   1. REMEMBRANCE_NODE (explicit, the full path of a node.exe; an unusable
rem      value is an error, no fallback; an empty value counts as unset)
rem   2. the first node.exe on PATH (Windows apps inherit the user PATH, so the
rem      node.exe of the installer, nvm-windows, Volta or Scoop is found here)
rem   3. %ProgramFiles%\nodejs\node.exe
rem A candidate must print vMAJOR.MINOR.PATCH at or above _min; a prerelease of
rem that exact version (-rc.1, -pre) is below it, and other output is refused.
rem REMEMBRANCE_NODE_LAUNCHER_DEBUG=1 prints the chosen node and version to stderr.
setlocal EnableExtensions DisableDelayedExpansion
set "_min=18.17.0"
for /f "tokens=1-3 delims=." %%a in ("%_min%") do (
  set "_min_maj=%%a"
  set "_min_mnr=%%b"
  set "_min_pat=%%c"
)
set "_node="
set "_ver="
set "_skipped="
if not defined REMEMBRANCE_NODE goto search
call :try "%REMEMBRANCE_NODE%"
if not errorlevel 1 goto run
setlocal EnableDelayedExpansion
if defined _ver set "_ver= (it reports !_ver:~0,200!)"
>&2 echo(Remembrance: REMEMBRANCE_NODE=!REMEMBRANCE_NODE:~0,200! is not an executable Node.js !_min! or newer!_ver!; point it at a working node.exe or unset it, then fully restart the host.
exit /b 127

:search
set "_cand="
set "_searched="
rem where.exe by its absolute path (cmd.exe would run a where.* from the current
rem directory, the user's project, first); $PATH: keeps that directory out of
rem its search too. Without SystemRoot there is no where.exe to run.
if not defined SystemRoot goto program_files
set "_searched=PATH"
for /f "delims=" %%I in ('^""%SystemRoot%\System32\where.exe" "$PATH:node.exe" 2^>nul ^<nul^"') do if not defined _cand set "_cand=%%I"
if not defined _cand goto program_files
call :try "%_cand%"
if not errorlevel 1 goto run
set "_skipped=; node.exe on PATH (%_cand:~0,200%) is not runnable"
if defined _ver set "_skipped=; node.exe on PATH (%_cand:~0,200%) is %_ver:~0,200%"
:program_files
if not defined ProgramFiles goto not_found
if defined _searched set "_searched=%_searched% and "
set "_searched=%_searched%%%ProgramFiles%%\nodejs"
call :try "%ProgramFiles%\nodejs\node.exe"
if not errorlevel 1 goto run
:not_found
if not defined _searched set "_searched=nothing"
if not defined SystemRoot set "_searched=%_searched%; PATH was not searched because SystemRoot is unset"
if not defined ProgramFiles set "_searched=%_searched%; %%ProgramFiles%%\nodejs was not searched because ProgramFiles is unset"
setlocal EnableDelayedExpansion
>&2 echo(Remembrance: cannot find Node.js !_min! or newer (searched !_searched!!_skipped!). Install Node.js !_min!+ where this host can see it, or set REMEMBRANCE_NODE=C:\absolute\path\to\node.exe in the environment the host starts with, then fully restart the host.
exit /b 127

:run
if not "%REMEMBRANCE_NODE_LAUNCHER_DEBUG%"=="1" goto exec
setlocal EnableDelayedExpansion
>&2 echo(Remembrance node launcher: !_node:~0,200! !_ver:~0,200!
endlocal
:exec
"%_node%" %*
exit /b

:try
rem Set _node to %1 when it is an .exe file whose -v output is at or above
rem _min; errorlevel 1 otherwise. Any other file type is refused unrun, so a
rem mistyped path never opens a program by file association. _ver keeps the
rem output for messages.
set "_ver="
if /i not "%~x1"==".exe" exit /b 1
if not exist "%~1" exit /b 1
if exist "%~1\*" exit /b 1
rem The caret-escaped outer quotes keep parentheses and ampersands in the path
rem quoted for this parser and leave the redirections unquoted for the cmd /c
rem that runs the command.
for /f "delims=" %%V in ('^""%~1" -v 2^>nul ^<nul^"') do if not defined _ver set "_ver=%%V"
if not defined _ver exit /b 1
set "_rest=%_ver%"
if "%_rest:~0,1%"=="v" set "_rest=%_rest:~1%"
set "_pre="
if not "%_rest:-=%"=="%_rest%" set "_pre=1"
set "_maj="
set "_mnr="
set "_pat="
for /f "tokens=1-3 delims=.-+" %%a in ("%_rest%") do (
  set "_maj=%%a"
  set "_mnr=%%b"
  set "_pat=%%c"
)
call :number "%_maj%"
if errorlevel 1 exit /b 1
call :number "%_mnr%"
if errorlevel 1 exit /b 1
call :number "%_pat%"
if errorlevel 1 exit /b 1
if %_maj% NEQ %_min_maj% (
  if %_maj% GTR %_min_maj% goto try_accept
  exit /b 1
)
if %_mnr% NEQ %_min_mnr% (
  if %_mnr% GTR %_min_mnr% goto try_accept
  exit /b 1
)
if %_pat% NEQ %_min_pat% (
  if %_pat% GTR %_min_pat% goto try_accept
  exit /b 1
)
if defined _pre exit /b 1
:try_accept
set "_node=%~1"
exit /b 0

:number
rem errorlevel 0 when %1 is one to nine decimal digits.
set "_digits=%~1"
if not defined _digits exit /b 1
for /f "delims=0123456789" %%x in ("%_digits%") do exit /b 1
if not "%_digits:~9%"=="" exit /b 1
exit /b 0
