---
name: hyperframes
description: Author HTML compositions that the `render_video` tool turns into deterministic MP4 video — animated charts and dashboards, data explainers, text/quote cards, kinetic typography, product teasers, and branded short-form social clips. Use when the user asks Brigade to make, render, animate, or produce a video from data, text, or a layout (NOT photoreal/AI footage — that's `generate_video`).
homepage: https://github.com/heygen-com/hyperframes
metadata:
  {
    "brigade":
      {
        "emoji": "🎬",
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "@hyperframes/producer",
              "label": "Install the HyperFrames render engine (npm)",
            },
          ],
      },
  }
---

# hyperframes — HTML → deterministic MP4

The `render_video` tool renders an **HTML composition** you write into a pixel-exact
MP4. A headless Chrome steps a **GSAP master timeline** frame by frame, captures one
image per frame, and FFmpeg encodes them — so the same HTML always produces the same
video. This is the right tool for anything **programmatic and data-driven**; reach for
`generate_video` only when you need photoreal/AI-generated footage.

**Great fits:** animated bar/line/donut charts, KPI dashboards, "N facts about X"
explainers, quote/announcement cards, kinetic typography, countdowns, before/after
reveals, branded intros/outros, vertical social clips.

## The composition contract (this is what makes or breaks a render)

Write ONE self-contained HTML document. Two things are mandatory and non-obvious:

1. **A paused GSAP timeline registered to `window.__timelines[<composition-id>]`.**
   HyperFrames seeks *this* timeline to render each frame. **Total video duration =
   `tl.duration()`** — you do NOT set duration with an attribute.
2. **`data-*` attributes** on the root and on every timed element.

**Root composition element** — required: `data-composition-id` (must match the
`window.__timelines` key), `data-width`, `data-height`, `data-start`; plus
`data-track-index`.

**Timed children** — `data-start` + `data-track-index` on every one; **visible
elements (`<img>`, text/graphic `<div>`s) also need `class="clip"`**; `<img>` also
takes `data-duration`. Do **not** put `data-duration` on the root/composition — its
duration comes from the timeline.

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <!-- Load GSAP (see "GSAP + assets" below). -->
    <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
    <style>
      body { margin: 0; }
      .stage { width: 1080px; height: 1920px; position: relative; overflow: hidden;
               background: #0b0b12; color: #fff; font-family: system-ui, sans-serif; }
      .title { position: absolute; top: 220px; left: 80px; font-size: 96px;
               font-weight: 800; opacity: 0; transform: translateY(24px); }
    </style>
  </head>
  <body>
    <div class="stage"
         data-composition-id="promo"
         data-width="1080" data-height="1920"
         data-start="0" data-track-index="0">
      <div class="title clip" data-start="0" data-duration="4" data-track-index="0">
        Ship faster.
      </div>
    </div>
    <script>
      // A PAUSED timeline — HyperFrames drives playback by seeking it per frame.
      const tl = gsap.timeline({ paused: true });
      tl.to(".title", { opacity: 1, y: 0, duration: 0.7, ease: "power2.out" }, 0.4)
        .to(".title", { opacity: 0, duration: 0.5, ease: "power2.in" }, 3.5);
      // Register under the SAME id as data-composition-id. This is mandatory.
      window.__timelines = window.__timelines || {};
      window.__timelines["promo"] = tl;
    </script>
  </body>
</html>
```

- Vertical `1080×1920` for TikTok/Reels/Shorts, `1920×1080` for landscape,
  `1080×1080` for square feed posts.
- Frame rate is an engine default (the tool doesn't expose an fps flag) — author for
  smooth motion at 30fps.

## GSAP + assets

The tool renders a single standalone `index.html` (no project scaffold), so the
composition must bring its own GSAP and assets:

- **GSAP**: load it via a `<script src="…gsap.min.js">` (CDN as above) or paste the
  minified source inline. It must be defined before your timeline script runs.
- **Assets**: embed images/fonts as `data:` URIs so nothing depends on external files.
- **Determinism**: never drive motion from `Date.now()`, `Math.random()`,
  `setTimeout`, or a hand-rolled `requestAnimationFrame` loop — put *all* motion on the
  GSAP timeline. Off-timeline animation desyncs from the frame stepper.

## Workflow

1. **Write the composition** to the contract above with real data/text (never lorem).
2. **Call `render_video`** with `{ html, output_name?, lint? }`. It lints, renders in an
   isolated subprocess (a real render legitimately takes a minute or more), and returns
   a saved MP4 as a `MEDIA:<path>` line.
3. **Deliver it** with `send_media({ path })`.
4. Handle failures by `errorType`:
   - `composition_invalid` — read the lint message, fix the HTML, retry.
   - `render_failed` — read the stderr excerpt (bad timeline id, missing GSAP, etc.).
   - `render_timeout` — the composition is too heavy; simplify or shorten it.
   - `render_unavailable` — the engine/FFmpeg isn't installed (see below).

## Design quality (make it look intentional, not templated)

- Pick a palette that fits the subject; commit to one accent and keep the rest quiet.
  Set a real type scale; give headings weight and letter-spacing.
- Stagger reveals (offset each element's timeline position by 0.15–0.3s) so motion
  reads as choreographed, not simultaneous.
- Keep text ≥64px from every edge on vertical video so platform UI never clips it.
- Ease everything (`power2.out` in, `power2.in` out). Linear motion reads robotic.
- For charts, animate the *value* (bar height, arc sweep, a counting number) on the
  timeline rather than swapping static frames.

## Requirements & install

Needs **Node 22+**, the **`@hyperframes/producer`** engine (an optional dependency —
install it to enable video), and **FFmpeg** on PATH. A headless Chromium is
auto-downloaded by the engine on first render (needs network once).

```bash
npm i @hyperframes/producer   # the render engine (optional; enables render_video)
# FFmpeg: brew install ffmpeg | winget install ffmpeg | apt install ffmpeg
```

Overrides: `BRIGADE_HYPERFRAMES_PATH` (explicit producer entry file), `FFMPEG_PATH`,
`BRIGADE_BROWSER_EXECUTABLE` / `PUPPETEER_EXECUTABLE_PATH`.
