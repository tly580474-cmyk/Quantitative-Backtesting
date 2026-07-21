Option Explicit

Dim shell, fileSystem, scriptDirectory, runner, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "--validate" Then WScript.Quit 0
End If

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
runner = fileSystem.BuildPath(scriptDirectory, "run-research-update.ps1")
command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & runner & Chr(34)

' Window style 0 is fully hidden. Wait=True preserves the real updater exit code
' so Task Scheduler can still report failures correctly.
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
