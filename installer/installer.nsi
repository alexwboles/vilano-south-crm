; Vilano South GR CRM — NSIS installer (3.7.19).
; Built on Linux via installer/build.sh. Installs to %LOCALAPPDATA%\VilanoCRM
; (no UAC prompt). Upgrades in place: app files are overwritten, the data/
; folder is never touched by install or upgrade; uninstall asks before removing it.

!define APP_NAME "Vilano CRM"
!define APP_VERSION "3.7.19"
!define PUBLISHER "Vilano South"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\VilanoCRM"

!include "MUI2.nsh"
!include "x64.nsh"

Name "${APP_NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\VilanoCRM"
RequestExecutionLevel user
Icon "staging\public\favicon.ico"
UninstallIcon "staging\public\favicon.ico"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Welcome to the ${APP_NAME} installer"
!define MUI_WELCOMEPAGE_TEXT "This will install ${APP_NAME} ${APP_VERSION} on your computer.$\r$\n$\r$\nNo technical setup is needed — everything installs itself."
!define MUI_LICENSEPAGE_TEXT_TOP "Please review these short terms before continuing."
!define MUI_FINISHPAGE_RUN "$INSTDIR\VilanoTray.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "--firstrun"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${APP_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "license.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install" SecInstall
  ; Close any running copy first (updates install over the running app).
  ExecWait 'taskkill /F /IM VilanoTray.exe' $0
  ExecWait 'taskkill /F /IM node.exe' $0
  SetOutPath "$INSTDIR"
  ; App files. data/ is intentionally NOT staged, so an existing database is
  ; never overwritten on install or upgrade.
  File /r "staging\*"

  ; Start-at-logon (HKCU — no admin needed). The tray also self-heals this key.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VilanoCRM" '"$INSTDIR\VilanoTray.exe"'

  ; Shortcuts: the desktop shortcut opens the dashboard (--open); if the tray
  ; is already running it just opens the browser, never a duplicate tray icon.
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\VilanoTray.exe" "--open" "$INSTDIR\public\favicon.ico"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\VilanoTray.exe" "--open" "$INSTDIR\public\favicon.ico"

  ; Uninstaller + Add/Remove Programs entry
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\public\favicon.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Cloudflare Tunnel — free public link for phones (recommended)" SecCloudflared
  ; Bundles cloudflared.exe so the CRM can publish a free https URL for phones.
  ; No VPN app needed on phones, no user limit, no monthly cost. The CRM starts
  ; the tunnel automatically; the current link is always shown on the
  ; Connect Phone page (the address changes when the PC restarts).
  ; Skipped automatically when the exe wasn't staged at build time.
  IfFileExists "$INSTDIR\cloudflared.exe" +2 0
    Goto cloudflared_done
  DetailPrint "Cloudflare Tunnel bundled — the CRM will publish its public link on startup."
  cloudflared_done:
SectionEnd

Section "Uninstall"
  ; Stop the tray and the Node server if they're running before removing files
  ; (an orphaned node.exe would hold the DB/lock files during uninstall).
  ExecWait 'taskkill /F /IM VilanoTray.exe' $0
  ExecWait 'taskkill /F /IM node.exe' $0

  MessageBox MB_YESNO|MB_DEFBUTTON1 "Keep your CRM data (interactions, staff, events, documents)?$\r$\nChoose Yes to keep your records for a future reinstall." IDYES keepdata
    ; No: remove everything including data.
    RMDir /r "$INSTDIR\data"
    Goto removedata
  keepdata:
  removedata:

  ; Remove installed files (explicit list so data/ survives when kept).
  Delete "$INSTDIR\VilanoTray.exe"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$INSTDIR\cloudflared.exe"
  Delete "$INSTDIR\server.js"
  Delete "$INSTDIR\db.js"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\package-lock.json"
  Delete "$INSTDIR\README.md"
  RMDir /r "$INSTDIR\public"
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\nodejs"
  RMDir /r "$INSTDIR\logs"
  RMDir "$INSTDIR" ; succeeds only if data/ was removed too

  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VilanoCRM"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
