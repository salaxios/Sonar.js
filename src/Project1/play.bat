::[Bat To Exe Converter]
::
::YAwzoRdxOk+EWAjk
::fBw5plQjdCyDJGyX8VAjFDpGQQ2MAE+1EbsQ5+n//NbW8BUbVfRxcYzUug==
::YAwzuBVtJxjWCl3EqQJgSA==
::ZR4luwNxJguZRRnk
::Yhs/ulQjdF+5
::cxAkpRVqdFKZSzk=
::cBs/ulQjdF+5
::ZR41oxFsdFKZSTk=
::eBoioBt6dFKZSDk=
::cRo6pxp7LAbNWATEpSI=
::egkzugNsPRvcWATEpSI=
::dAsiuh18IRvcCxnZtBJQ
::cRYluBh/LU+EWAnk
::YxY4rhs+aU+JeA==
::cxY6rQJ7JhzQF1fEqQJQ
::ZQ05rAF9IBncCkqN+0xwdVs0
::ZQ05rAF9IAHYFVzEqQJQ
::eg0/rx1wNQPfEVWB+kM9LVsJDGQ=
::fBEirQZwNQPfEVWB+kM9LVsJDGQ=
::cRolqwZ3JBvQF1fEqQJQ
::dhA7uBVwLU+EWDk=
::YQ03rBFzNR3SWATElA==
::dhAmsQZ3MwfNWATElA==
::ZQ0/vhVqMQ3MEVWAtB9wSA==
::Zg8zqx1/OA3MEVWAtB9wSA==
::dhA7pRFwIByZRRnk
::Zh4grVQjdCyDJGyX8VAjFDpGQQ2MAE+1BaAR7ebv/Nagq1k1QeADVIDYz6eaB+Ee73n8O5M10xo=
::YB416Ek+ZG8=
::
::
::978f952a14a936cc963da21a135fa983
@echo off
title Launching Locust (Dev Mode)

:: Define your folder paths (Change these if your paths ever move)
set "NWJS_DIR=C:\nwjs-sdk-v0.110.1\"
set "PROJECT_DIR=%CD%"

echo ===================================================
echo   Starting NW.js Runtime...
echo   Mapping Assets to: %PROJECT_DIR%
echo ===================================================

:: Navigate to the NW.js folder and launch it with the project folder as an argument
cd /d "%NWJS_DIR%"
start "" "nw.exe" "%PROJECT_DIR%"

exit