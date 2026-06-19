# Triple T Loves You

A full-screen, gesture-controlled drawing toy built with React, Vite, and MediaPipe HandLandmarker.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL in desktop Chrome and allow camera access. Pinch your thumb and index finger together once to activate drawing, then move your index fingertip to draw. Pinch again to pause. Hold a rock-horns sign (index and pinky raised) to transform the drawing into a swarm. Use **Clear** to reset.

Gesture controls:

- Pinch: toggle drawing on or off
- Move your index fingertip while drawing is active: draw continuously
- L sign (index finger and thumb extended) held briefly: undo the last stroke
- Open palm swiped sideways: clear the canvas or swarm (motion remains tracked through brief pose dropouts)
- Rock-horns sign held briefly (index and pinky raised): summon the Tung swarm

Keyboard fallbacks are `D` for drawing on/off, `Cmd/Ctrl + Z` for undo, and `C` to clear.

A live fingertip cursor shows exactly where the smoothed hand tracker sees the index finger. Brief landmark or pose dropouts are tolerated so strokes and swipes stay continuous.

The transformed drawing keeps a dense swarm while adaptively limiting it to 220 Tungs on desktop and 170 on compact screens. Each Tung is 44–68px with staggered arrival and randomized motion.

If camera access was denied on the first visit, allow it from Chrome's site controls and choose **Try camera again**. The app also retries automatically when Chrome reports that camera permission changed to allowed.

On macOS, turn off **Reactions** from the Video menu in the menu bar while the camera is active. macOS composites those effects into the camera feed before it reaches Chrome, so websites cannot disable them directly. The app avoids the reaction-triggering thumbs-up and victory-sign gestures entirely.

## Deploy to Vercel

Import the repository in Vercel. The included `vercel.json` configures the Vite build and SPA fallback automatically.

MediaPipe's JavaScript module, WASM runtime, and hand-landmark model are loaded at runtime from CDNs; they are not bundled with the app.
