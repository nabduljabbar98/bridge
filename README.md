# bridge (windows)

Ableton Live integration that generates music with elevenlabs and drops it into your session. no login. no suno.

## run (dev)
```
npm install
npm start
```

## features
- detect ableton live, ping the osc link
- install the ableton remote script (port 11000)
- generate music from a prompt via elevenlabs music api
- save output and open in explorer

## settings
set your elevenlabs api key in settings. get one at elevenlabs.io.

## ableton setup
1. click "install remote script"
2. restart ableton live
3. preferences > link/midi > control surface > bridge

## notes
- no suno branding, colors, or api usage
- remote script is pure python running inside ableton (osc)
