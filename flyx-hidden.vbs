' Runs start-flyx.bat with no visible window.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run Chr(34) & dir & "\start-flyx.bat" & Chr(34), 0, False
