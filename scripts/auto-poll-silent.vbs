' Silent launcher for auto-poll.ps1. wscript.exe runs without allocating a
' console, so the user never sees a window flash at the 2-minute cadence.
' This is the script the Windows Scheduled Task invokes; it just turns around
' and calls powershell.exe -WindowStyle Hidden on auto-poll.ps1 sitting next
' to this file.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1Path = fso.BuildPath(scriptDir, "auto-poll.ps1")
CreateObject("Wscript.Shell").Run _
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1Path & """", _
  0, False
