; Project YX — portable self-extractor (Inno Setup)
; Extracts beside this EXE into Project-YX-Portable\ — no Program Files, no uninstall entry.

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#ifndef MyAppSourceDir
  #define MyAppSourceDir "..\build\portable-staging"
#endif
#ifndef MyAppOutputDir
  #define MyAppOutputDir "..\dist"
#endif
#ifndef MyAppOutputBase
  #define MyAppOutputBase "Project-YX-0.0.0-Portable"
#endif
#ifndef MyAppExeName
  #define MyAppExeName "yx-desktop.exe"
#endif
#ifndef MyAppIcon
  #define MyAppIcon "..\apps\desktop\src-tauri\icons\icon.ico"
#endif

#define MyAppName "Project YX"

[Setup]
AppName={#MyAppName} Portable
AppVersion={#MyAppVersion}
AppPublisher=Project YX Contributors
DefaultDirName={src}\Project-YX-Portable
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=no
Uninstallable=no
PrivilegesRequired=lowest
OutputDir={#MyAppOutputDir}
OutputBaseFilename={#MyAppOutputBase}
SetupIconFile={#MyAppIcon}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
DirExistsWarning=no
UsePreviousAppDir=no

[Files]
Source: "{#MyAppSourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
procedure InitializeWizard;
begin
  WizardForm.WelcomeLabel2.Caption :=
    'This extracts Project YX Portable next to this file.' + #13#10 + #13#10 +
    'No installation to Program Files. FFmpeg/ffprobe must be on PATH.';
end;
