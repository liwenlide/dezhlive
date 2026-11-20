# DeZhLive 德中即時字幕（手機版）

Phone PWA for live German → Traditional Chinese subtitles at talks.
Mic → on-device voice-activity segmentation → Google Gemini (one call: transcribe + translate), or OpenAI `gpt-transcribe` → `gpt-6.1-terra`.

- Static files only; no server. Your OpenAI API key is stored only in your browser's localStorage and sent only to the selected provider (Google or OpenAI).
- Audio and text you capture are sent to the selected provider. Don't use it for confidential/patient conversations.
- Open in iPhone Safari → Share → Add to Home Screen.
