; Vilano South GR CRM — NSIS installer (3.7.9).
; Built on Linux via installer/build.sh. Installs to %LOCALAPPDATA%\VilanoCRM
; (no UAC prompt). Upgrades in place: app files are overwritten, the data/
; folder is never touched by install or upgrade; uninstall asks before removing it.

!define APP_NAME "Vilano CRM"
!define APP_VERSION "3.7.9"
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
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT ""

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
  ; The tray owns the server child process, so killing the tray is enough;
  ; the belt-and-braces node kill only targets our server.js instances.
  ExecWait 'taskkill /F /IM VilanoTray.exe' $0
  ExecWait 'taskkill /F /FI "WINDOWTITLE eq Vilano*" /IM node.exe' $0
  SetOutPath "$INSTDIR"
  ; App files. data/ is intentionally NOT staged, so an existing database is
  ; never overwritten on install or upgrade.
  File /r "staging\*"

  ; Start-at-logon (HKCU — no admin needed). The tray also self-heals this key.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VilanoCRM" '"$INSTDIR\VilanoTray.exe"'

  ; Shortcuts (tray exe + VS icon)
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\VilanoTray.exe" "" "$INSTDIR\public\favicon.ico"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\VilanoTray.exe" "" "$INSTDIR\public\favicon.ico"

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

Section "NetBird — phone access away from home (recommended)" SecNetBird
  ; Installs the NetBird client silently (/S) so phones can reach the CRM from
  ; anywhere, not just home Wi-Fi. NetBird's own installer needs one Windows
  ; admin approval (UAC prompt) because it installs a system service — that is
  ; the only click. Afterwards: create one free NetBird account and sign in on
  ; this PC and each phone (free tier covers commercial use: 5 users).
  ; Skipped automatically when the NetBird installer wasn't staged at build
  ; time, or when NetBird is already installed.
  IfFileExists "$INSTDIR\netbird-installer.exe" +2 0
    Goto netbird_done
  IfFileExists "$PROGRAMFILES64\NetBird\netbird.exe" netbird_present 0
  DetailPrint "Installing NetBird (one admin approval needed)..."
  ExecWait '"$INSTDIR\netbird-installer.exe" /S' $0
  IntCmp $0 0 netbird_done 0 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "NetBird did not finish installing (code $0).$\r$\nYou can install it later from netbird.io — phone access away from home needs it."
    Goto netbird_done
  netbird_present:
    DetailPrint "NetBird already installed — skipping."
  netbird_done:
SectionEnd

Section /o "Tailscale — alternative phone access (optional)" SecTailscale
  ; Installs the Tailscale client silently (MSI /qn) as an alternative to
  ; NetBird for away-from-home phone access. Opt-in: unchecked by default
  ; because NetBird is the recommended default above. Skipped automatically
  ; when the MSI wasn't staged at build time, or when Tailscale is present.
  IfFileExists "$INSTDIR\tailscale-setup.msi" +2 0
    Goto tailscale_done
  IfFileExists "$PROGRAMFILES64\Tailscale\tailscale.exe" tailscale_present 0
  DetailPrint "Installing Tailscale (silent)..."
  ExecWait 'msiexec /i "$INSTDIR\tailscale-setup.msi" /qn /norestart' $0
  IntCmp $0 0 tailscale_done 0 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Tailscale did not finish installing (code $0).$\r$\nYou can install it later from tailscale.com/download — or use NetBird above."
    Goto tailscale_done
  tailscale_present:
    DetailPrint "Tailscale already installed — skipping."
  tailscale_done:
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
  ; Stop the tray if it's running before removing files.
  ExecWait 'taskkill /F /IM VilanoTray.exe' $0

  MessageBox MB_YESNO|MB_DEFBUTTON1 "Keep your CRM data (interactions, staff, events, documents)?$\r$\nChoose Yes to keep your records for a future reinstall." IDYES keepdata
    ; No: remove everything including data.
    RMDir /r "$INSTDIR\data"
    Goto removedata
  keepdata:
  removedata:

  ; Remove installed files (explicit list so data/ survives when kept).
  Delete "$INSTDIR\VilanoTray.exe"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$INSTDIR\netbird-installer.exe"
  Delete "$INSTDIR\tailscale-setup.msi"
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
