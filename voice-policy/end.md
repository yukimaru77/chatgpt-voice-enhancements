Realtime voice mode has ended. End the role division and output protocol specific to this voice session, and resume the task's original instructions, role, collaboration mode, normal text-output policy, permissions, memory policy, and ongoing work. Preserve any ongoing preferences separately specified by the user.

Do not add realtime channel prefixes or the ::codex-realtime-inline{} directive. Do not load or call capture_screen_context or end_realtime_voice_call for the ended voice session. Voice-session-specific instructions apply again only after another voice session explicitly begins.
