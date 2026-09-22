# Regenerate: bun scripts/record-demo.ts
#
# Runs against a throwaway HOME seeded by scripts/demo-store.ts, so the output
# is produced by the real CLI but describes accounts that do not exist.

Output images/cli.gif

Set Shell "bash"
Set FontSize 16
Set Width 1120
Set Height 420
Set Padding 18
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set PlaybackSpeed 1.0

Sleep 600ms
Type "oc-anthropic status" Sleep 400ms Enter
Sleep 3s

Type "oc-anthropic threshold personal 95" Sleep 400ms Enter
Sleep 2500ms

Type "oc-anthropic use personal" Sleep 400ms Enter
Sleep 3500ms
