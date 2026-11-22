# bridge (windows)

Local-first Ableton Live bridge. Generates music with ElevenLabs and drops it into your session. No login. No Suno. API keys live on your machine.

## run
```
npm install
npm start
```

## how it connects to Ableton (same mechanism as Suno Bridge)
- a Python remote script (`ableton_bridge/`) is installed into Ableton's User Library/Remote Scripts
- it is selected once as a Control Surface in Ableton: Settings > Link, Tempo & MIDI > Control Surface > "ableton bridge"
- the script listens on OSC 127.0.0.1:11000 and replies on 11001
- the app pings `/live/ping`, reads song/track info, and inserts clips with `/live/clip_slot/load_file`

## local-first
- no account, no sign-in, no cloud upload
- ElevenLabs API key is stored in the app's local settings (`%APPDATA%/bridge/settings.json`)
- generated audio is saved to `Ableton/User Library/Samples/Bridge Imports` so Live can load it

## verified
- remote script listening on port 11000
- `/live/ping` -> ok
- `/live/song/get/num_tracks`, `/live/song/get/tempo`, `/live/track/get/name` respond
- `/live/clip_slot/load_file` returned ok when the file is in the User Library/Samples root

## build (windows installer)
```
npx electron-builder --win
```
