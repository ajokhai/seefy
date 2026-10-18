# Seefy plan

## Goal

Sense movement anywhere in a space (one room, several rooms, a whole floor) using the WiFi network you're already on.

1. **Learn pass, with a camera:** walk the space carrying your phone. Its camera maps the rooms, walls and divisions and tracks where you are. At the same time, a mesh of fixed WiFi nodes records how the signal changes as your body moves through each part of the space.
2. **Sense, without a camera:** using what it learned, the system reads the WiFi mesh alone and gives a reasonable picture of movement in the space: which room someone is in, where in it, how they're moving and, where trained, their posture. Walls between you and them don't matter; seeing through walls is a consequence of the approach, not the goal.

**It's one simple web app on your local network.** Run `seefy` on a laptop and open `https://<laptop>.local:8443` in any browser on the same WiFi: phone, tablet or desktop. Nothing to install from an app store, no cloud, no accounts. The app has three screens:

- **Live:** the floor plan with people's positions, movement trails and (where trained) skeletons
- **Learn:** the guided walk, coverage map and optional teacher-camera routine
- **Sensors:** node status, packet rates, latency, sync and the CSI waterfall

**Headline success:** after one learn pass, with no camera anywhere, the Live screen shows which room a person is in and tracks them around the floor plan in real time.

## How it works

```
 ESP32 nodes (fixed, spread across the space)        Phone (web app)
 ├─ mesh: ping router ~100 Hz, CSI of replies        ├─ camera → own position (6DoF)
 └─ phone link: sniff the phone's own packets,       ├─ keyframes → room geometry
    RSSI + CSI per node                              └─ MediaPipe pose (teacher mode)
        │ UDP (timestamped)                                │ WebSocket (timestamped)
        ▼                                                  ▼
 ┌───────────────────────────── Host (laptop) ─────────────────────────────┐
 │ ingest → clock sync → one timeline → recorder                           │
 │ space map (rooms, walls, doors) · radio map · model (CSI → movement)    │
 └─────────────────────────────────────────────────────────────────────────┘
        │ WebSocket
        ▼
 Live screen: floor plan with people, trails, skeletons
```

- **Works on any network:** each node is an ordinary WiFi client. It pings the gateway at a fixed rate and measures the router's replies (CSI). You don't need router access or special firmware on the router.
- **The phone is the learning probe.** It has to be a camera with WiFi on the same network (in practice, a phone), because it does three jobs at once:
  - Its camera maps the space.
  - The camera also tracks where the phone, and so the person holding it, is.
  - Its WiFi transmissions are what the nodes measure.
- **Two signals are learned against position:**
  1. **Phone-link signal:** RSSI and CSI of the phone's own transmissions, as each node receives them.
  2. **Mesh deltas:** how the router-to-node CSI changes because a body is moving through that part of the space.
- **Sensing uses mesh deltas only,** so it works with no phone present and for anyone moving in the space.
- **Nodes only need to stay put.** You never measure or enter their positions. They're solved automatically from the walk (see below) and used as fixed inputs when the solve is good.

## The learn pass

### 1. Map the space

The camera builds a **space map**: floor plan, rooms, walls, doorways and major furniture, in meters.

- **Phone position:**
  - **iPhone** (Safari has no WebXR AR): a few printed AprilTags per room, on walls or the floor, not on the nodes. OpenCV.js (WebAssembly) on the phone detects them and solves the phone's 6DoF position at 20–30 fps. Tags seen together while walking through doorways link the rooms into one map. The printed tag size gives real-world scale.
  - **Android Chrome:** WebXR with ARCore tracks in real time with no tags.
- **Lens calibration, once per phone:** wave the phone at a printed ChArUco board (a chessboard with tags) for about 10 seconds.
- **Geometry:** keyframes (about 2 per second) go to the host with their camera positions. A monocular metric depth model (Depth Anything V2 Metric-Indoor) runs on the Mac's GPU, and Open3D TSDF fusion builds a mesh of every room walked.
  - Plane fitting turns the mesh into walls, floor and doorways.
  - Rooms are split at walls and doorways.
  - Open-vocabulary detection (YOLO-World + SAM) labels furniture.
- **Whole-home refinement (optional):** after the walk, the recorded video can go through [LingBot-Map](https://github.com/Robbyant/lingbot-map), which handles long multi-room walkthroughs in one pass and fills areas without tags. Labels don't need to be real-time, only correctly timestamped, so this can run afterwards: minutes on an NVIDIA GPU, longer on the Mac. The tags provide scale and alignment.

### 2. Record the signal

- **Why the nodes measure the phone:** browsers don't expose WiFi signal strength (neither Safari nor Chrome gives it to a web page, and iOS doesn't give it to native apps either). So:
  - The phone streams pose and timing data to the host over a WebSocket, which keeps its radio sending steadily.
  - The host finds the phone's MAC address from its IP (ARP table) and tells the nodes to listen for it.
  - Each node sniffs the phone's frames and reports RSSI and full CSI per packet, at 30–100 Hz.
  - Phones use a private MAC per network, which stays fixed for the session. The Screen Wake Lock API keeps the phone awake and sending.
- **Body position:** when the phone is held at chest height, the torso sits about 30–40 cm behind it along the viewing direction. Projected onto the floor, that labels where the body is at every moment.

### 3. The walk

1. **Empty-space baseline (30 s):** step out of the mesh. Records the static signal.
2. **Walk every room (about 3–5 min per room):** phone at chest height, camera facing outward, moving slowly through the whole area, doorways included. The Learn screen fills a coverage heatmap on the floor plan as you go and warns when tracking is lost or sync drifts.
3. **Movement variety:** within the walk, also stand still, turn, sit down, walk fast. Each is labeled from the phone's motion, so the model learns more than one gait.
4. **Teacher pass (optional, for skeletons):** phone on a stand in a room. MediaPipe gives full-body keypoints, and the stand's position comes from the tags. Repeat in the rooms where posture matters.

### 4. Node positions (automatic)

The walk records phone-link signal strength from hundreds of known phone positions. Signal falls off with distance, so fitting that falloff solves each node's position (least-squares multilateration), with a confidence score per node. Indoor multipath makes this rough, typically within 1–2 m. Confident positions become fixed model inputs, which speeds up training and limits which body positions can explain a signal change. Poor solves are simply left out.

## Sensing without the camera

The model reads the last 0.5–1 s of mesh CSI from all nodes and outputs, in order of difficulty:

1. **Occupancy per room:** is anyone there. Most robust.
2. **Position on the floor plan,** plus heading and speed, drawn as a live trail.
3. **Movement type:** walking, still, sitting, turning.
4. **Skeleton:** 17 keypoints in room coordinates, in rooms that had a teacher pass.

The space map constrains everything: people stay on the floor, inside rooms, out of walls and furniture, and move between rooms only through doorways. This feeds the training loss and filters live output, which removes a large class of impossible, jittery predictions.

**Limits:** WiFi senses moving bodies well and still bodies poorly; someone motionless for a long time can fade out (the tracker holds their last position). Walls and furniture come from the camera; WiFi's part is noticing when they change, which triggers a "relearn this room" prompt.

## Latency and sync

For learning, **timestamp sync matters more than raw latency.** Every sample can be aligned after the fact if its timestamp is correct. At walking pace (about 1.4 m/s), every 10 ms of sync error becomes about 1.4 cm of label error, so the target is **under 10 ms of sync error**.

Live sensing needs low latency end to end. Target: **under 150 ms** from movement to screen.

| Stage | Budget | How |
|---|---|---|
| Node → host | < 10 ms | Raw UDP on the LAN, small binary packets, no batching |
| Node clocks | < 2 ms error | Nodes sync to the host over UDP every few seconds; each packet carries the node's own microsecond timestamp |
| Phone camera → own position | 30–50 ms | Tag detection at reduced resolution on the phone; WebXR on Android |
| Phone → host | < 20 ms | WebSocket, binary messages, pose only (keyframes go separately, at low priority) |
| Phone clock | < 5 ms error | NTP-style handshake every few seconds, median of the fastest round trips; camera frame time from `requestVideoFrameCallback` |
| Model inference | < 20 ms | Small model, sliding window, Mac GPU (MPS) |
| Host → Live screen | < 20 ms | WebSocket push |

The Sensors screen shows live latency and sync error per device.

## Stack

| Part | Choice | Why |
|---|---|---|
| Sensor firmware | ESP-IDF + Espressif `esp-csi` | Official CSI support for router replies and sniffed frames (MAC filter); cheap |
| Host service | Python 3.11, FastAPI + websockets, asyncio UDP | One process for ingest, sync, recording and inference; also serves the web app |
| Discovery | mDNS (`seefy.local`) and a QR code printed at startup | Open it on the phone without typing an IP; nodes find the host the same way |
| Phone app | Browser page, TypeScript + Vite | No app-store install, works on iOS and Android |
| Phone tracking | OpenCV.js tags (all phones); WebXR (Android Chrome) | Real-time, metric, in the browser |
| Space map | Depth Anything V2 + Open3D TSDF, plane fitting, room segmentation; YOLO-World + SAM; optional LingBot-Map | Runs on the Mac; multi-room |
| Pose teacher | MediaPipe Tasks Vision | Runs on the phone; only keypoints cross the network |
| HTTPS on LAN | `mkcert` local CA | Browsers only allow camera access over HTTPS |
| Storage | One folder per session: `csi.parquet`, `phone.parquet`, `pose.parquet`, `space.json`, keyframes | Easy to replay and inspect |
| ML | PyTorch | Already used by the existing code |

## Hardware

- **Nodes:** 2–3 per room, spread so their paths to the router cross the room (e.g. 4–6 for a 2–3 room apartment). About $10–15 each.
  - **ESP32-C5 preferred:** it's dual-band (2.4 + 5 GHz). Most phones choose 5 GHz on dual-band networks, and a 2.4 GHz-only node can't hear them, which would force a 2.4 GHz-only network and break "any network." Espressif's `esp-csi` lists the C5 as supported.
  - **ESP32-S3 fallback:** works if the phone can be kept on 2.4 GHz during the learn pass. Ideally pick a variant with an external antenna (u.FL connector).
- USB power for each node (wall chargers or power banks)
- A phone stand or tripod (for the optional teacher pass)
- Printed AprilTags (iPhone) and a ChArUco board, printed from the app

## Phases

### 0. Repo scaffold
- Move the existing code to `legacy/`, fix the README, add `requirements.txt`.
- Layout: `firmware/csi_node/`, `server/`, `web/`, `ml/`, `docs/`.

### 1. Web app, phone tracking and sync (no boards needed)
- One command (`seefy`) starts the host: it serves the web app over HTTPS on the LAN and prints the URL and a QR code.
- Web app shell with the Live, Learn and Sensors screens.
- Clock sync handshake and a live latency/sync readout.
- Phone tracking: lens calibration, multi-room tag map, real-time 6DoF position streamed to the host; WebXR path on Android. Screen Wake Lock.
- Session recorder.
- **Done when:** walking between two rooms with the phone draws your path live on a top-down map on the laptop, under 100 ms behind, with a measured phone clock error under 5 ms.

### 2. Space map
- Keyframe upload, metric depth, TSDF fusion, wall/floor/doorway extraction, room segmentation, furniture labels.
- Floor-plan viewer with rooms and doorways.
- Optional LingBot-Map refinement from the recorded walk.
- **Done when:** a walk through 2–3 rooms gives a floor plan with walls within about 10 cm of tape-measured dimensions and correct room divisions.

### 3. Node firmware and capture
- Firmware: join the network from config, ping the gateway at about 100 Hz (mesh CSI), sniff frames from a MAC the host specifies (phone-link RSSI + CSI), node clock sync, binary UDP to the host.
- Host: UDP ingest, finding the phone's MAC from its IP, per-node packet rates, live waterfall.
- **Done when:** with the phone streaming, every node reports phone-link packets at 30 Hz or more, and the mesh waterfall clearly reacts to someone walking.

### 4. Learn pass and radio map
- Guided multi-room walk with baseline capture, coverage heatmap and quality warnings.
- Everything aligned on one timeline: phone position, body position, phone-link signal, mesh CSI, space map.
- Radio-map viewer: signal per node over the floor plan.
- Automatic node-position solve with confidence scores.
- **Done when:** a learn pass over 2–3 rooms gives a dense, aligned dataset with good coverage in every room.

### 5. Model v1: where and how people move
- Preprocessing: phase sanitization (remove the linear phase slope across subcarriers), Hampel outlier filter, amplitude normalized against the empty-space baseline.
- Model: mesh CSI window from all nodes → per-node conv encoder → fusion → temporal transformer → heads for occupancy per room, floor position, heading/speed and movement type. Confident node positions and the space map go in as context. Space-map limits go into the loss and a live tracker (particle filter over the floor plan, crossing rooms only through doorways). The legacy modality-translation MLP is a starting point for the encoder.
- Eval on held-out walks: room accuracy, position error in cm, movement-type accuracy.
- **Done when:** with no camera anywhere, the Live screen shows the right room more than 95% of the time and tracks a walking person to within about 50 cm in real time.

### 6. Model v2: skeletons
- Teacher pass in chosen rooms. Same encoder, plus a keypoint head in room coordinates, initialized from v1.
- **Done when:** in a taught room, with the camera covered, the WiFi skeleton follows a walking person in real time.

### 7. Stretch goals
- More than one person at a time
- Ray-traced CSI simulation (Sionna RT) on the space map: synthetic pretraining and node-placement suggestions
- Change detection with per-room "relearn" prompts
- Dense body-surface output (DensePose-style), as in the paper
- AR overlay on the phone camera view, showing people in neighboring rooms where they really are

## Risks

- **Signal detail:** ESP32 CSI is noisier and has fewer antennas than the paper's Intel 5300 setup. Several nodes per room make up for some of that, but expect positions and skeletons, not full body surfaces.
- **One person, one posture during the walk:** the walk mostly shows one person, upright, holding a phone. Movement variety in the walk, teacher passes and extra sessions (other people, other postures) widen what the model knows.
- **The phone's own effect:** during the walk, both the person and the phone change the signal. The model uses only mesh CSI as input so it doesn't come to rely on a phone being present.
- **Phone band:** see Hardware. A 2.4 GHz-only node can't hear a phone on 5 GHz.
- **Tracking gaps (iPhone):** losing sight of every tag pauses labeling. The coverage map shows gaps; add a tag there. LingBot-Map refinement can fill gaps afterwards.
- **Still people:** WiFi sees motion, so long-motionless people fade. The tracker holds their last position.
- **Packet rate:** some routers rate-limit pings. If needed, fall back to UDP echo traffic or a node acting as its own access point.
- **Relearning:** moving nodes, the router or major furniture changes the space. Learning is per room, so only the changed room needs a new walk.
- **Wall material:** drywall is fine. Brick and concrete weaken the signal a lot; add nodes on each side.
- **Privacy:** only sense spaces you're allowed to. Data stays on your machines.

## Open questions

1. Which phone? iPhone needs a few printed tags per room for tracking; Android Chrome can track with none.
2. Is this Mac (M1 Pro, 16 GB) the host? Everything in the default path runs on it.
3. How big is the first test space (how many rooms)? That sets the node count.
4. Ready to order ESP32-C5 boards?
