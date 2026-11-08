' Codex Remote bridge launcher — runs the Node bridge with no visible window.
' Used by the CodexRemoteBridge scheduled task (login autostart).
Option Explicit

Dim sh, fso, here, nodeExe, candidates, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

' No hardcoded user path: check where Node is normally installed, then fall back to PATH.
nodeExe = "node.exe"
candidates = Array( _
  sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"), _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe") _
)
For i = 0 To UBound(candidates)
  If fso.FileExists(candidates(i)) Then
    nodeExe = candidates(i)
    Exit For
  End If
Next

sh.CurrentDirectory = here & "\bridge"
sh.Run """" & nodeExe & """ server.mjs", 0, False
