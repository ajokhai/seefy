# Seefy UX plan

Seefy should feel like a consumer product: someone who has never heard of WiFi sensing sets it up
in ten minutes and understands every screen without help. This plan is the spec for the app's
screens, words and flows. `docs/PLAN.md` stays the spec for how the system works underneath.

## What people come for

- **Once:** map my home. Walk each room with the phone, get a floor plan that looks like my home.
- **Every day:** glance at Seefy and know whether anyone is moving at home, and where.

Setup is a cost people pay once; the home view is why they keep the app. Every screen serves one
of those two jobs. Anything that only helps us build Seefy goes under Settings › Advanced.

## Spaces, not rooms (Josh, decided)

You **map a space**: one continuous map of a place (a flat, a floor of a house, an office).
- **Extend it** by scanning another part. Seefy finds what the new scan has in common with the map
  (the same corners, doorways, furniture) and joins it automatically. The overlap is the glue: start
  the new scan somewhere already mapped and walk into the new area.
- If a scan can't be joined, it's kept as a separate piece and Seefy says so: "Couldn't connect this
  to the rest of your map. Scan the area where they meet." Joining is retried when more scans arrive.
- **A separate location** (another home, the office) is a **new space**, mapped independently.
- **Rooms are parts of the floor plan**, found from the walls and doorways. Seefy suggests them, and
  you name them by tapping. Nobody has to set up rooms before scanning.

## Principles

1. **One path, no decisions.** First run is a linear flow with one obvious button per screen.
   Nobody should have to choose between Guide, Live, Rooms and Details to get started.
2. **Each device has its role.** The phone is the scanner and a remote. The Mac is the hub: it
   does the work and shows the home on a big screen. Scanning never appears on the Mac except as
   "use your phone".
3. **Human words only.** No frames, fit, px, poses, RSSI, tier, phase, SfM, tags or blueprint in
   the main UI. Every number shown must mean something to a homeowner (metres, rooms, minutes).
4. **Honest, never confidently wrong.** If the scan is weak, say so and say how to fix it. Never
   label a 1.3 × 1.6 m bedroom "good". Low confidence looks unfinished (dashed, greyed), never solid.
5. **Show, don't explain.** The room takes shape on screen while you scan; that is the progress
   bar. Illustrations beat paragraphs.
6. **Always a way forward.** No dead ends: every empty, error and offline state has a next step.

## Structure

Three places, the same on phone and Mac (bottom tabs on the phone, sidebar on the Mac):

| Tab | What it is |
|---|---|
| **Home** | Status at a glance ("All quiet" / "Movement in the bedroom, just now"), the floor plan of the whole home with live movement, and the rooms. Default screen after setup. |
| **Map** | The space's floor plan, big: rooms named on it, [Extend map] as the main action, Edit walls & furniture, the scans it's built from (and any unjoined pieces), switch space / New space. |
| **Settings** | Home name, WiFi calibration ("Teach Seefy what a still home looks like"), phones and this Mac, and **Advanced**: everything engineering (sync, frame stats, accuracy inspector, tag mode, raw settings). |

Scanning is an action ("Extend map", "New space"), not a tab. "Guide", "Live" and "Details" go away
as names: onboarding replaces Guide, Home replaces Live, Settings › Advanced replaces Details.

## First run (phone)

Opened by scanning the QR on the Mac, so it's already connected. One screen at a time:

1. **Welcome:** "Seefy maps your home with your phone, then senses movement using your WiFi. No
   cameras stay on." [Get started]
2. **Name this space** (chips: Home, Flat, Office, or type), then scan. No rooms to set up.
3. **Before you scan:** three illustrated cards: lights on · move slowly, phone steady · walk
   around the room pointing the phone across it at furniture, corners and doors. [Start scanning]
4. **Scanning** (full-screen camera; see below).
5. **Review:** the floor plan, the size in metres and a plain verdict:
   - good → "Looks good" [Save room] (secondary: Scan more)
   - weak → "Part of this room is missing" with the missing side shaded on the plan. [Scan more]
     is primary; "Save anyway" is a quiet link.
6. **Check the size** (optional, one tap away, strongly encouraged): "Measure one wall or a door
   for accurate distances." Pick a wall on the plan, type its length. Fixes the scale, which today
   is guessed from an assumed phone height.
7. **Map more of it?** [Extend the map] (start where you've already scanned, walk into the new
   area) / [That's everything]
8. **Teach Seefy a still home:** "Leave the room and keep still for 30 seconds." Countdown ring,
   then ✓. (WiFi still-room calibration.)
9. **Done** → Home.

On the Mac, first run is one screen: "Set up Seefy on your phone", a big QR, and live status
("Waiting for your phone… Connected ✓ · Scanning the living room… 60%"). The Mac follows along
and shows the floor plan building as the phone scans.

## Scanning (the core experience)

- **Full-screen camera** with three things on it and nothing else:
  - a **live mini-map** (top-down, corner): the room's outline and furniture appearing as you
    walk, unscanned directions shaded. This is the progress indicator.
  - **one instruction** at a time, large: "Slow down", "Turn toward the window side", "Too dark",
    "Point across the room, not at the wall".
  - a **progress ring** around the shutter, with a tick at "enough". At enough: a gentle
    "You can stop now ✓" with the shutter turning green; continuing makes it extra sure.
- Turn-speed and blur warnings stay, worded as instructions, not meters.
- **Stop** goes straight to Review. Final processing must be seconds, with a progress bar.
- If tracking is lost: "Lost your place. Go back to where you were a moment ago." The mini-map
  shows where that is.

## Home (daily view)

- **Status hero:** a big state with time: "All quiet · since 2:14 pm" / "Movement · living room
  · now". Honest about what WiFi can tell: with only the Mac's own link, Seefy knows *that*
  someone is moving, not *where*; say "Movement at home" and show no room until per-room sensing
  works.
- **Floor plan of the home:** rooms side by side (placement editable later), names inside rooms,
  a soft pulse in a room with movement.
- **Room list** under it: name, last movement.
- Empty state (no rooms): the plan area shows "Map your first room" with the phone CTA.

## Rooms

Card per room: plan thumbnail, name, size in metres, "Mapped well" / "Partly mapped",
last scanned date. Tapping opens the room: big plan, [Rescan] [Edit walls & furniture],
⋯ menu (Rename, Check accuracy — under Advanced styling, Delete). Edit on the phone: drag
corners and doors, tap furniture to rename or delete. Same editor on the Mac with more room.

## Quality bar: Airbnb (Josh)

"Think about how nice Airbnb's app is." Concretely, what we copy:
- **Imagery leads.** Every space is a card with a **cover photo** (the sharpest frame from its
  scans) and its floor plan; text sits under it, short. The floor plan is our hero image.
- **Calm, confident type.** Large bold titles (28–32 pt), one short line of grey supporting text,
  no walls of text. Sentence case. Numbers only where they mean something.
- **Generous space, soft shapes.** 24 px gutters, 16–20 px corner radii, soft shadows instead of
  hairlines, one accent colour for the single primary action.
- **Flows feel guided.** Multi-step tasks are full screens with a thin progress bar on top and a
  sticky footer: "Back" as a text link on the left, the primary button on the right.
- **Secondary tasks in bottom sheets** (rename, name a room, scan options) that slide up over the
  current screen, never a browser prompt() or confirm().
- **Never a blank or a spinner alone:** skeleton placeholders while loading, friendly empty states
  with one action, undo instead of "are you sure?" where possible.
- **Small delights:** smooth transitions between steps (under 300 ms), a satisfying ✓ when a scan
  joins the map, haptic-like feedback on the shutter.

## Visual style

- **Floor plans look like real floor plans**, not a radar: light floor, dark grey walls of real
  thickness, door gaps with swing arcs, furniture as soft rounded shapes with labels, room name
  in the middle, dimensions along walls on request. Dark mode mirrors it. No navy blueprint grid,
  no axis arrows, no point clouds by default (point clouds live in Advanced).
- System font and colours as now. One accent colour. Status colours: green quiet, orange
  movement, grey offline.
- Motion: gentle, under 300 ms; the scan mini-map grows smoothly.

## Words (replace → with)

| Today | Instead |
|---|---|
| Guide / Live / Details | (onboarding) / Home / Settings › Advanced |
| Frames placed 196 / 1286 | (hidden; Advanced only) |
| Partial scan · about 1.3 × 1.6 m | Part of this room is missing |
| Scale: assumed camera height 1.35 m | Size is estimated · Measure a wall for exact size |
| Fit 0.74 px | (Advanced only) |
| Dots are fixed features seen from above… | (gone; the plan speaks for itself) |
| Calibrate still room | Teach Seefy a still home |
| Moving / Still, RSSI −69 dBm | Movement / All quiet |
| Trust this computer (on a Mac) | Only on iPhone, only when the connection is really blocked |

## Who builds what

| Area | Owner |
|---|---|
| Navigation (Home/Rooms/Settings), first-run shell and Mac first-run, Home screen, Rooms, Settings + Advanced, floor-plan visual style (plan2d), copy pass | seefy-b2 |
| Scan experience on the phone: prep cards, camera overlay (mini-map, instruction, progress ring), review with quality verdict, measure-a-wall scale fix, honest layout confidence | seefy-ad |
| Real-time mapping (stop in seconds), mini-map data stream, phone-friendly editor | seefy-32 |
| First-time-user walkthroughs of each build, friction list on ct; the article | seefy-39 |

## Order

1. Scan → review → save a room, end to end on the phone, honest verdict (seefy-ad, seefy-32).
2. New navigation, onboarding shell, Settings/Advanced split, copy pass (seefy-b2).
3. Home with status and the home plan; floor-plan visual style (seefy-b2).
4. Mini-map during scan, measure-a-wall, phone editor.

Done means: a person who has never seen Seefy, given only the phone with the QR scanned, ends
up with a saved room and the Home screen without asking a question.
