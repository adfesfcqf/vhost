; Installateur Windows de ModCraft Studio (compilable sous Windows, Linux ou macOS avec makensis)
Unicode true
!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "2.0.0"
!endif
!ifndef SRC
  !define SRC "..\dist\win-unpacked"
!endif
!ifndef OUT
  !define OUT "..\dist\ModCraft-Studio-Setup-${VERSION}.exe"
!endif

!define APP "ModCraft Studio"
!define EXE "ModCraft Studio.exe"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ModCraftStudio"

Name "${APP}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "Software\ModCraftStudio" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APP} ${VERSION}"

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Bienvenue dans l'installation de ${APP}"
!define MUI_WELCOMEPAGE_TEXT "Crée tes propres add-ons Minecraft Bedrock, simplement, avec un assistant IA.$\r$\n$\r$\nClique sur Suivant pour continuer."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Lancer ${APP}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "French"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=${LANG_FRENCH} "ProductName" "${APP}"
VIAddVersionKey /LANG=${LANG_FRENCH} "FileDescription" "Installation de ${APP}"
VIAddVersionKey /LANG=${LANG_FRENCH} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_FRENCH} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_FRENCH} "LegalCopyright" "ModCraft Studio"

Section "Installer"
  ; Ferme l'appli si elle tourne déjà (mise à jour)
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Sleep 500
  SetOutPath "$INSTDIR"
  File /r "${SRC}\*.*"
  File "icon.ico"
  WriteUninstaller "$INSTDIR\Desinstaller.exe"

  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\icon.ico"
  CreateDirectory "$SMPROGRAMS\${APP}"
  CreateShortcut "$SMPROGRAMS\${APP}\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\icon.ico"
  CreateShortcut "$SMPROGRAMS\${APP}\Désinstaller ${APP}.lnk" "$INSTDIR\Desinstaller.exe"

  WriteRegStr HKCU "Software\ModCraftStudio" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "ModCraft Studio"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\Desinstaller.exe"'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Sleep 500
  Delete "$DESKTOP\${APP}.lnk"
  RMDir /r "$SMPROGRAMS\${APP}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNKEY}"
  DeleteRegKey HKCU "Software\ModCraftStudio"
SectionEnd
