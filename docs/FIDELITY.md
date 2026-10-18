# Fidelity variables

Everything that changes how accurate Seefy ends up, so tests can vary one thing at a time.

## How to use this

- **Settings** live in the Sensors screen → Fidelity settings (stored in `data/config.json`; defaults in [server/seefy/config.py](../server/seefy/config.py)).
- **Every recorded pass** saves a full settings snapshot, the tag map and each phone's lens calibration in its `meta.json`. To compare two passes, compare those snapshots.
- **Passes accumulate.** Extra map passes add tag observations (and the solve uses all of them). Extra lens passes add views. Extra learn walks add training data. Resetting is explicit (Sensors screen).
- When testing, change one variable per pass and write it in the pass notes.

## Physical setup (not settings, but they matter most)

| Variable | Effect | Try |
|---|---|---|
| Number and spread of fixed WiFi devices | Each fixed transmitter the laptop hears is one sensing link. More links crossing the space give finer zones | Note which devices are on and where; add or move one per test |
| Laptop position | It's the receiver for every link; links run from each transmitter to it | Opposite side of the space from the router usually crosses more of the room |
| Signal tier (link RSSI / monitor-mode RSSI / CSI) | Biggest single jump in what can be sensed | Shown on the Sensors screen once Phase 3 lands |
| Tag count and placement | More tags, seen together, give a tighter map and fewer tracking gaps | 3–4 per room, on different walls, at chest height |
| Printed tag size | Bigger tags are detected further away, with less pose ambiguity | Measure the printed black square and enter it exactly |
| Lighting and motion blur | Blur and dim light cost tag detections | Walk slower in dim rooms |
| Number of learn passes, times of day, people | More varied data generalizes better | Repeat walks; vary one condition per pass |

## Tracking (phone camera)

| Setting | Default | Effect |
|---|---|---|
| `tag_size_m` | 0.10 | Must match the printed wall tags exactly. Sets the map's scale |
| `origin_tag_size_m` | 0.20 | Floor tag is printed larger: it's seen at a steep angle from chest height. In simulation, a small floor tag was the main source of map error |
| `origin_tag_id` | 0 | Which tag defines the world origin and "up" |
| `capture_width` × `capture_height` | 1280 × 720 | Higher resolution: more precise corners, slower detection |
| `detect_scale` | 1.0 | Downscale before detecting. 0.5 roughly quadruples speed but loses precision and range |
| `detect_max_fps` | 30 | Cap on detection rate |
| `corner_refinement` | subpix | `none` is fastest; `subpix` is precise; `apriltag` is most precise and slowest |
| `min_tag_px` | 24 | Tags smaller than this in the image are ignored (too imprecise) |
| `max_reproj_px` | 4.0 | Phone poses that fit worse than this are dropped |
| `body_offset_m` | 0.35 | Distance from a chest-height phone back to the torso centre. Affects every body-position label |

## Tag map

| Setting | Default | Effect |
|---|---|---|
| `keyframe_interval_s` | 0.25 | Min time between stored observations per phone. Lower stores more, similar frames |
| `min_tags_per_frame` | 2 | Frames must link this many tags |
| `max_frames` | 2000 | Observations used per solve, across all passes (evenly subsampled beyond this) |
| `huber_px` | 1.5 | Robust-loss scale. Lower ignores outliers harder |
| `min_obs_per_tag` | 3 | A tag needs this many observations before it joins the map |

The map reports a fit error (px) overall and per tag. Watch it fall as passes are added.

## Lens calibration

| Setting | Default | Effect |
|---|---|---|
| `min_views` / `max_views` | 12 / 80 | Views required and kept (best fits kept when trimming) |
| `min_tags_per_view` | 8 | Board tags a view needs to count |
| `fix_k3` | true | Simpler distortion model. Turn off only for wide or fisheye lenses |
| `outlier_view_factor` | 3.0 | Views with error above this × the median are dropped |

Without calibration, tracking assumes a 68° horizontal field of view. That works, but positions are less accurate.

## Clock sync

| Setting | Default | Effect |
|---|---|---|
| `interval_s` | 2.0 | Time between ping bursts |
| `burst` | 5 | Pings per burst |
| `window` | 60 | Samples kept |
| `rtt_slack_ms` | 2.0 | Samples within the fastest round trip + this are trusted |

Each 10 ms of sync error is about 1.4 cm of label error at walking pace. The Sensors screen shows the error bound per phone.

## Learn pass (used from Phase 4)

| Setting | Default | Effect |
|---|---|---|
| `baseline_s` | 30 | Empty-space capture length |
| `coverage_cell_m` | 0.25 | Floor grid for the coverage map |
| `target_samples_per_cell` | 60 | When a cell counts as covered |

Signal-capture settings (sample rates, window lengths, which links to use) arrive with Phase 3.
