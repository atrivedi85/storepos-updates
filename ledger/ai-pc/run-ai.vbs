' Starts Ledger Desk AI in the background (no window) and starts it again if it stops (for example after an update).
' It connects this PC's AI to trivedipos.com/books.
Set sh = CreateObject("WScript.Shell")
d = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Ledger Desk Server"
sh.Environment("Process")("ELECTRON_RUN_AS_NODE") = "1"
sh.CurrentDirectory = d & "\ledger-ai"
Do
  sh.Run """" & d & "\Ledger Desk Server.exe"" """ & d & "\ledger-ai\ledger-desk-ai.js""", 0, True
  WScript.Sleep 5000
Loop
