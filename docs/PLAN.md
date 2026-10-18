# Seefy plan

## Goal

Sense movement anywhere in a home using **only hardware you already own**: your WiFi router, your phone and your laptop. No extra boards, no special firmware. Anyone should be able to try it at home. Results will vary with what each person's hardware reports, and the app says what to expect from yours.

1. **Learn pass, with a camera:** walk the space carrying your phone. Its camera maps the rooms, walls and divisions and tracks where you are. At the same time, the laptop listens to WiFi traffic and records how the signals change as your body moves through each part of the space.
2. **Sense, without a camera:** using what it learned, the system reads WiFi signals alone and gives its best picture of movement in the space. Depending on your hardware, that ranges from "someone is moving" up to "which room, and roughly where."

**It's one simple web app on your local network.** Run `seefy` on a laptop and open `https://<laptop>.local:8443` in any browser on the same WiFi: phone, tablet or desktop. Nothing to install from an app store, no cloud, no accounts. The app has three screens:

- **Live:** the floor plan with motion, occupancy and (where the hardware allows) positions and trails
- **Learn:** the guided walk, coverage map and optional teacher-camera routine
- **Sensors:** what signals your hardware provides, expected fidelity, link quality, latency and sync

**Headline success:** after one learn pass, with no camera, a stock home setup (router + laptop) reliably shows when someone is moving in the space and which part of it they're in.

## How it works

```
 Router / mesh AP        Other fixed WiFi devices        Phone (web app)
 (stock firmware)        (TV, speaker, printer…)         camera → own position, room map
        │ beacons, data         │ their normal traffic          │ its own WiFi traffic
        └──────────────┬────────┴───────────────────────────────┘
                       ▼  radio
 ┌──────────────────── Laptop (host, stays put) ────────────────────┐
 │ signal capture: link RSSI · per-packet RSSI (monitor mode) · CSI │
 │ clock sync → one timeline → recorder                             │
 │ space map · radio map · model (signals → movement)              │
 └──────────────────────────────────────────────────────────────────┘
                       │ WebSocket
                       ▼
 Live screen on any browser
```

- **The laptop is the sensor.** It stays in one place during learning and sensing, and listens to the WiFi traffic already in the air.
- **Every fixed WiFi device is a signal link.** A body moving between a transmitter and the laptop changes what the laptop receives. More fixed devices in more places means more links crossing the space, and better coverage. Devices only need to stay put; their positions aren't needed.
- **The phone is the learning probe.** It has to be a camera with WiFi (in practice, a phone), because it does three jobs at once:
  - Its camera maps the space.
  - It tracks where the phone, and so the person holding it, is.
  - Its own transmissions are another signal the laptop measures at each known position.
- **Sensing uses only fixed links,** so it works with no phone present and for anyone moving in the space.

## Signal sources and fidelity tiers

The host detects what the hardware can report and picks the best source available. The Sensors screen shows the result and what to expect.

| Tier | Source | What it needs | Links | Realistic camera-free output |
|---|---|---|---|---|
| **0** | **Link RSSI:** the laptop's own connection strength to the router | Any laptop. macOS: CoreWLAN; Linux: `iw`/nl80211; Windows: WLAN API | 1 | Motion yes/no; presence while moving |
| **1** | **Per-packet RSSI (monitor mode):** signal strength of every frame the laptop hears, per transmitter | A laptop or USB adapter that supports monitor mode; admin rights | One per fixed device heard (router, mesh nodes, TV, speaker…) | Motion, plus coarse zone or room from fingerprinting, if enough fixed devices are spread around |
| **2** | **CSI:** per-subcarrier channel measurements | Hardware that exposes CSI: some Linux WiFi cards (e.g. Intel AX200/AX210 with PicoScenes), Raspberry Pi with Nexmon, OpenWrt routers with supported chips, or an ESP32 if someone has one | One per CSI receiver | Finer position. Skeletons only with several CSI receivers |
| **(r)** | **Router-reported client RSSI** from its admin page or app | Depends on the router; **unverified** for the Tenda Nova | One per client | Slow (seconds); useful as a coarse extra |

Fidelity grows with three things, and the app should tell users which one to add next:
1. **More fixed transmitters,** spread around the space
2. **A better signal source** (moving up a tier)
3. **More learn passes** (they accumulate)

**This build's test setup:** Tenda Nova MW5 (AC1200 dual-band mesh, 2x2), iPhone 14 Pro, MacBook M1 Pro. **Expected:** tier 0 for sure, tier 1 if Mac monitor mode works without breaking the connection (untested, see Risks).

## The learn pass

### 1. Map the space

The camera builds a **space map**: floor plan, rooms, walls, doorways and major furniture, in meters.

- **Phone position, no markers (default):** the room's own features are the fixed points: corners, door and window frames, ceiling lights and fixtures, furniture edges. Ceiling lights are especially useful: they're visible from most of the room and stand out against plain walls (the walk guide suggests tilting up now and then, and avoiding pointing straight at bright bulbs, which wash out).
  - During the walk, the phone records camera frames (about 10 per second) and its motion sensors (gravity and rotation, 60 Hz), all stamped on the host clock, and streams them to the laptop.
  - Afterwards, the laptop reconstructs the camera path and the room from the frames with structure-from-motion: COLMAP via `pycolmap` on the CPU, or LingBot-Map where a GPU allows. Labels don't need to be real-time, only correctly timestamped, so a few minutes of processing is fine.
  - **Up** comes from the phone's gravity sensor. **Floor** is the lowest large plane in the reconstruction.
  - **Origin** is a room corner: the app suggests the corner where two walls meet the floor, and you can tap a different one.
  - **Scale** (a single camera can't measure absolute size), in order of effort:
    1. Automatic: a metric depth model (Depth Pro / Depth Anything V2 Metric) estimates real distances, typically within 5–10%.
    2. One measurement: tap the two sides of a door frame (or any length you know) and enter it.
    3. Optional marker: a tag shown on a screen or printed gives the most accurate scale and origin.
  - **Live feedback during the walk** is limited to coverage and "keep moving slowly" hints until reconstruction is fast enough to run while walking.
- **Phone position with markers (optional, more accurate):** AprilTags printed or shown on screens (any monitor, laptop, tablet or old phone; each can have its own size, and the origin can stand upright on a screen). OpenCV.js on the phone tracks them live at 20–30 fps.
- **Android Chrome:** WebXR with ARCore can track live with no markers.
- **Lens calibration, once per phone (optional):** wave the phone at a grid of tags (printed or on a screen) for about 10 seconds. Structure-from-motion can also estimate the lens itself.
- **Geometry:** keyframes (about 2 per second) go to the host with their camera positions. A monocular metric depth model (Depth Anything V2 Metric-Indoor) runs on the laptop's GPU, and Open3D TSDF fusion builds a mesh of every room walked.
  - Plane fitting turns the mesh into walls, floor and doorways.
  - Rooms are split at walls and doorways.
  - Open-vocabulary detection (YOLO-World + SAM) labels furniture.
- **Whole-home refinement (optional):** the recorded walk can go through [LingBot-Map](https://github.com/Robbyant/lingbot-map) afterwards for a denser multi-room mesh (fast on an NVIDIA GPU, slower on a Mac). On iPhone Pro models, an Apple RoomPlan LiDAR scan can be imported instead.

### 2. Record the signals

- **Transmitter discovery:** during a 30 s empty-space capture, the laptop lists every transmitter it hears, with packet rate and signal level. Fixed ones (router, mesh nodes, TV…) are marked as sensing links. Phones and laptops that move around are excluded.
- **Phone link:** the host finds the phone's MAC address from its IP (ARP table) and tracks its frames separately. The phone streams pose data over a WebSocket, which keeps its radio sending steadily. The Screen Wake Lock API keeps it awake.
- **Body position:** when the phone is held at chest height, the torso sits about 30–40 cm behind it along the viewing direction. Projected onto the floor, that labels where the body is at every moment.

### 3. The walk

1. **Empty-space baseline (30 s):** step out of the space. Records the static signal per link.
2. **Walk every room (about 3–5 min per room):** phone at chest height, camera facing outward, moving slowly through the whole area. The Learn screen fills a coverage heatmap on the floor plan as you go and warns when tracking is lost or sync drifts.
3. **Movement variety:** also stand still, turn, sit down, walk fast. Each is labeled from the phone's motion.
4. **Teacher pass (optional, CSI tier only):** phone on a stand. MediaPipe gives full-body keypoints for skeleton training.
5. **More passes:** every extra walk adds to the same dataset. Repeat at different times of day or with different people for better fidelity.

### 4. Radio map

For every link, the walk produces a map of how the signal responds to a body at each floor position: the drop when someone blocks the direct path, and the fluctuation when they move near it. This shows exactly which areas the current links cover well and which are blind, so the app can suggest where a fixed device (or the laptop) would help most.

## Sensing without the camera

The model reads the last 1–2 s of signals from all fixed links and outputs what the tier supports, in order of difficulty:

1. **Motion:** is anyone moving. All tiers.
2. **Zone or room:** which part of the space. Needs several links (tier 1 with spread-out devices, or tier 2).
3. **Position on the floor plan** with a live trail. Tier 2, or a dense tier 1 setup.
4. **Skeleton.** Tier 2 with several receivers only.

The space map constrains everything: people stay on the floor and out of walls and furniture, and move between rooms only through doorways. That reduces jumpy, impossible output.

**Limits:** WiFi senses moving bodies well and still bodies poorly. RSSI is coarse: it reacts mostly to a body blocking or reflecting near a link's direct path. Walls and furniture come from the camera; WiFi's part is noticing when things change.

## Latency and sync

For learning, **timestamp sync matters more than raw latency.** At walking pace (about 1.4 m/s), every 10 ms of sync error becomes about 1.4 cm of label error, so the target is **under 10 ms of sync error**. Signal capture happens on the host, so it shares the host clock with no sync error; only the phone needs syncing.

Live sensing target: **under 250 ms** from movement to screen. RSSI-based detection needs a short window of samples, so it's slower than the camera path.

| Stage | Budget | How |
|---|---|---|
| Signal capture | 10–100 ms | Link RSSI polled at the fastest rate the OS allows; monitor-mode frames timestamped on arrival |
| Phone camera → own position | 30–50 ms | Tag detection on the phone; WebXR on Android |
| Phone → host | < 20 ms | WebSocket, binary messages, pose only |
| Phone clock | < 5 ms error | NTP-style handshake every few seconds, median of the fastest round trips; camera frame time from `requestVideoFrameCallback` |
| Model inference | < 20 ms | Small model, sliding window |
| Host → Live screen | < 20 ms | WebSocket push |

## Stack

| Part | Choice | Why |
|---|---|---|
| Host service | Python 3.12, FastAPI + websockets | One process for capture, sync, recording and inference; also serves the web app |
| Signal capture | macOS CoreWLAN (link RSSI); libpcap with radiotap headers (monitor mode); pluggable CSI adapters | Uses the laptop's own WiFi; extra sources plug in without changing the rest |
| Discovery | mDNS (`seefy.local`) and a QR code printed at startup | Open it on the phone without typing an IP |
| Phone app | Browser page, TypeScript + Vite | No app-store install, works on iOS and Android |
| Phone tracking (default) | Recorded frames + motion sensors → structure-from-motion on the laptop (pycolmap; LingBot-Map with a GPU); metric depth or one known length for scale | No markers: the room's corners, doors and windows are the fixed points |
| Phone tracking (optional) | OpenCV.js 4.10 AprilTags, printed or on screens; WebXR on Android Chrome | Live and more accurate when markers are acceptable |
| Space map | Depth Anything V2 + Open3D TSDF, plane fitting, room segmentation; YOLO-World + SAM; optional LingBot-Map / RoomPlan | Runs on the laptop |
| Pose teacher | MediaPipe Tasks Vision | CSI tier only |
| HTTPS on LAN | Local CA generated by the host | Browsers only allow camera access over HTTPS |
| Storage | One folder per session: Parquet streams plus `meta.json` with a config snapshot | Easy to replay and compare passes |
| ML | PyTorch | Already used by the existing code |

## What you need

- **Required:** a WiFi router (any), a phone with a camera, a laptop that can stay in one place during learning and sensing
- **Printed:** a few AprilTags and a lens-calibration grid (iPhone), printed from the app
- **Helps, if you already have them:** other WiFi devices that stay put (smart TV, speaker, printer, mesh nodes) in different parts of the space; a USB WiFi adapter with monitor mode; any CSI-capable device

## Phases

### 0. Repo scaffold (done)
- Existing code moved to `legacy/`, README rewritten, Python and web layout in place.

### 1. Web app, phone tracking and sync (in progress)
- One command (`seefy`) starts the host: HTTPS on the LAN, URL and QR code. *(done)*
- Clock sync handshake, session recorder, accumulating tag map and lens calibration on the host. *(done, tested)*
- Web app shell with the Live, Learn and Sensors screens.
- Phone tracking: lens calibration, multi-room tag map, real-time 6DoF position streamed to the host. Screen Wake Lock.
- **Done when:** walking between two rooms with the phone draws your path live on a top-down map on the laptop, under 100 ms behind, with a measured phone clock error under 5 ms.

### 2. Space map
- Keyframe upload, metric depth, TSDF fusion, wall/floor/doorway extraction, room segmentation, furniture labels.
- **Done when:** a walk through 2–3 rooms gives a floor plan with walls within about 10 cm of tape-measured dimensions and correct room divisions.

### 3. Signal capture
- Capability probe: which tiers this laptop supports, shown on the Sensors screen.
- Tier 0 adapter: link RSSI at the highest rate the OS allows. Measure the real rate on the test Mac.
- Tier 1 adapter: monitor-mode sniffer with per-transmitter RSSI, transmitter discovery and fixed-device marking. Test whether the Mac keeps its connection while sniffing.
- Live per-link signal view.
- **Done when:** on the test setup, the link view clearly reacts to someone walking between the router and the laptop, and every available tier reports its real sample rate.

### 4. Learn pass and radio map
- Guided multi-room walk with baseline capture, coverage heatmap and quality warnings.
- Everything on one timeline: phone position, body position, per-link signals, space map.
- Radio-map viewer per link, with blind-spot hints.
- **Done when:** a learn pass gives an aligned dataset and the radio map shows which areas each link covers.

### 5. Model v1: motion and zones
- Preprocessing per link: baseline subtraction, outlier filter, variance features over short windows.
- Model: signal windows from all fixed links → per-link encoder → fusion → heads for motion, zone/room and (when supported) floor position. Space-map limits go into the loss and a live tracker over the floor plan.
- Eval on held-out walks: motion detection accuracy, room accuracy, position error where applicable, reported per tier.
- **Done when:** on the test setup, with no camera, motion detection is reliable and the Live screen shows the right zone most of the time.

### 6. CSI tier (optional)
- CSI adapters for common CSI-capable hardware, skeleton head and teacher pass, for users who have such hardware.

### 7. Stretch goals
- More than one person at a time
- Ray-traced simulation (Sionna RT) on the space map: synthetic pretraining and "put a device here" suggestions
- Change detection with per-room "relearn" prompts
- AR overlay on the phone camera view, showing motion in neighboring rooms

## Risks

- **Coarse signals:** RSSI mostly sees bodies that block or move near a link's direct path. With one link (tier 0), expect motion detection only. That's the honest baseline for a stock setup.
- **Mac monitor mode (untested):** sniffing on macOS needs admin rights and may disconnect the Mac from WiFi while active, which would cut the phone off from the host. Fallbacks: connect the Mac by Ethernet, use a USB WiFi adapter for sniffing, or stay on tier 0.
- **macOS link-RSSI rate (untested):** CoreWLAN may update slowly or need Location permission. Measure it in Phase 3.
- **Mesh routers:** with several mesh nodes, devices may sit on different nodes or channels, and the laptop hears only its own channel. Each node the laptop hears becomes an extra link.
- **Router-reported RSSI (unverified):** may not exist, or may update only every few seconds.
- **Few fixed transmitters:** homes with only a router get one or two links. The app should say so and suggest where an extra fixed device would help.
- **One person, one posture during the walk:** movement variety and extra passes widen what the model knows.
- **Still people:** WiFi sees motion, so long-motionless people fade. The tracker holds their last position.
- **Relearning:** moving the laptop, the router or another fixed device changes the links. Learning is per room, so only affected rooms need a new walk.
- **Privacy:** only sense spaces you're allowed to. Data stays on your machines.

## Markerless tracking: first test

Before building the capture flow, measure on a real walkthrough from the test iPhone:
- Does `pycolmap` reconstruct a 30–60 s room video reliably, and how long does it take on the M1 Pro?
- How does LingBot-Map compare on the Mac's GPU (MPS)?
- How close is automatic metric-depth scale to a tape-measured length?

## Open questions

1. Does Mac monitor mode keep the WiFi connection on the test MacBook? This decides tier 0 vs tier 1 for the first test.
2. Which other fixed WiFi devices are in the test space, and where?
3. How many rooms does the first test cover?
