-- Replace both absolute paths before compiling. AppleScript does not inherit
-- your interactive shell's PATH. No app bundle or global environment is changed.
property launcherCommand : "/absolute/path/to/node /absolute/path/to/chatgpt-voice-enhancements/launch-custom-codex-app.mjs"

on run
    try
        do shell script launcherCommand
    on error errorMessage
        display alert "Codex Custom could not start" message errorMessage as critical
    end try
end run
