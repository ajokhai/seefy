# Seefy

Sense movement anywhere in a space using the WiFi network you're already on.

Fixed WiFi nodes (ESP32 boards) form a sensing mesh. You teach it by walking the space once with your phone: the phone's camera maps the rooms and tracks where you are, while the mesh records how the WiFi signal changes as your body moves through each spot. Afterwards, the system reads the mesh alone, with no camera, and shows which room people are in, where, and how they're moving.

Everything runs as one web app on your local network. There's no cloud and nothing to install on the phone.

**Status:** early build. See [docs/PLAN.md](docs/PLAN.md) for the full design and phases, and [docs/FIDELITY.md](docs/FIDELITY.md) for the settings that affect accuracy.

## Layout

| Path | What |
|---|---|
| `server/seefy/` | Host service (Python): HTTPS, WebSocket hub, clock sync, tag map, lens calibration, session recorder |
| `web/` | Browser app (TypeScript + Vite): Live, Learn and Sensors screens |
| `firmware/csi_node/` | ESP32 CSI node firmware (Phase 3) |
| `ml/` | Sensing models (Phase 5) |
| `legacy/` | The original DensePose-from-WiFi experiments |
| `docs/` | Plan, fidelity notes, the DensePose From WiFi paper |

## Background

This started as an attempt to reproduce [*DensePose From WiFi*](docs/papers/densepose-from-wifi.pdf) (Geng, Huang, De la Torre, 2022). That paper maps WiFi signal measurements to dense human pose using a camera-supervised network. Seefy keeps the camera-as-teacher idea and turns it into a practical, phone-calibrated system for whole spaces.

![WiFi DensePose](docs/img/wifi-densepose.png)
