; Project YX — Inno Setup installer
; Compiled via scripts/build-inno.js (defines injected).

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
  #define MyAppOutputBase "Project-YX-Setup-0.0.0"
#endif
#ifndef MyAppExeName
  #define MyAppExeName "yx-desktop.exe"
#endif
#ifndef MyAppIcon
  #define MyAppIcon "..\apps\desktop\src-tauri\icons\icon.ico"
#endif

#define MyAppName "Project YX"
#define MyAppPublisher "Project YX Contributors"
#define MyAppURL "https://github.com/needyamin/project-yx"
#define MyAppId "com.projectyx.editor"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir={#MyAppOutputDir}
OutputBaseFilename={#MyAppOutputBase}
SetupIconFile={#MyAppIcon}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "{#MyAppSourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
procedure InitializeWizard;
begin
  WizardForm.WelcomeLabel2.Caption :=
    'This will install Project YX on your computer.' + #13#10 + #13#10 +
    'FFmpeg and ffprobe must be available on PATH for media import and export.';
end;
