' AGV Operator visible launcher
' Double-click to start the app.
' Console stays open if Python reports an error.

Set objShell = CreateObject("WScript.Shell")
strPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

' cmd /k keeps the console open so errors can be read.
objShell.Run "cmd /k """ & strPath & "\launch.bat""", 1, False
