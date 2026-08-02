Option Explicit

Dim shell, fileSystem, scriptDirectory, runner, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
runner = fileSystem.BuildPath(scriptDirectory, "run-multi-asset-monitor.cmd")
command = "cmd.exe /d /c " & Chr(34) & runner & Chr(34)

' Window style 0 is fully hidden. Wait=True preserves the real exit code
' so Task Scheduler can still report failures correctly.
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode