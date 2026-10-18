// Sensors screen: connection QR, devices, tag map, sessions, signal sources, fidelity settings.

import { conn } from "./conn";
import { fmt, h, toast } from "./ui";

export function sensorsScreen(): { el: HTMLElement; destroy: () => void } {
  const devices = h("div", { class: "table-wrap" });
  const tagmap = h("div");
  const sessions = h("div");
  const settings = h("div", { class: "settings" });

  const el = h(
    "div",
    { class: "sensors" },
    h("section", { class: "card connect" },
      h("img", { src: "/api/qr.svg", alt: "QR code for this page", width: 140, height: 140 }),
      h("div", {},
        h("h3", {}, "Open on your phone"),
        h("p", {}, "Scan the code with the phone's camera (same WiFi network)."),
        h("p", {}, h("a", { href: "/print.html", target: "_blank" }, "Print tags and the lens grid →")))),
    h("section", { class: "card" }, h("h3", {}, "Devices"), devices),
    h("section", { class: "card" }, h("h3", {}, "Tag map"), tagmap),
    h("section", { class: "card" },
      h("h3", {}, "Signal sources"),
      h("p", { class: "muted" },
        "WiFi signal capture comes in Phase 3. Seefy will detect what this laptop can report: link signal strength (any laptop), " +
        "per-packet signal strength from every fixed device it hears (monitor mode), or CSI on hardware that exposes it. " +
        "More fixed WiFi devices spread around the space, and more learn passes, both improve fidelity.")),
    h("section", { class: "card" }, h("h3", {}, "Recorded passes"), sessions),
    h("section", { class: "card" },
      h("h3", {}, "Fidelity settings"),
      h("p", { class: "muted" },
        "Every setting that affects accuracy. A snapshot is saved with each recorded pass so you can compare results. See docs/FIDELITY.md."),
      settings),
  );

  function renderDevices() {
    const ds = conn.state?.devices ?? [];
    if (!ds.length) {
      devices.replaceChildren(h("p", { class: "muted" }, "Nothing connected."));
      return;
    }
    devices.replaceChildren(
      h("table", {},
        h("thead", {}, h("tr", {}, ...["Device", "Role", "Mode", "Sync", "Camera→host", "Phone→host", "Poses/s", "Detect", "Lens"].map((t) => h("th", {}, t)))),
        h("tbody", {},
          ...ds.map((d: any) =>
            h("tr", {},
              h("td", {}, `${d.name}${d.id === conn.id ? " (this)" : ""}`, h("div", { class: "muted" }, d.ip)),
              h("td", {}, d.role),
              h("td", {}, d.mode),
              h("td", {}, d.sync?.err_ms != null ? `±${fmt(d.sync.err_ms, 1)} ms` : "–"),
              h("td", {}, fmt(d.capture_latency_ms, 0, " ms")),
              h("td", {}, fmt(d.net_latency_ms, 0, " ms")),
              h("td", {}, fmt(d.rates?.pose ?? 0, 0)),
              h("td", {}, d.status?.detect_ms != null ? `${fmt(d.status.detect_ms, 0)} ms @ ${fmt(d.status.fps, 0)} fps` : "–"),
              h("td", {}, d.role === "phone" ? (d.status?.lens_calibrated ? "calibrated" : "approx.") : "–"),
            )),
        ),
      ),
    );
  }

  function renderTagmap() {
    const tm = conn.tagmap;
    const st = conn.state?.tagmap;
    tagmap.replaceChildren(
      h("dl", { class: "stats" },
        h("dt", {}, "Mapped tags"), h("dd", {}, String(Object.keys(tm?.tags ?? {}).length)),
        h("dt", {}, "Frames"), h("dd", {}, `${tm?.frames ?? 0} (${tm?.frames_used ?? 0} used in last solve)`),
        h("dt", {}, "Passes"), h("dd", {}, String(tm?.passes ?? 0)),
        h("dt", {}, "Fit"), h("dd", {}, fmt(tm?.rms_px, 2, " px")),
        h("dt", {}, "Solve time"), h("dd", {}, `${fmt(tm?.solve_ms, 0, " ms")}${st?.solving ? " (solving…)" : ""}`)),
      h("div", { class: "row" },
        h("button", { onclick: () => conn.api("/api/tagmap/solve", "POST").catch((e) => toast(e.message)) }, "Solve now"),
        h("button", {
          class: "danger",
          onclick: async () => {
            if (confirm("Delete the tag map and every observation from all passes?")) await conn.api("/api/tagmap/reset", "POST");
          },
        }, "Reset map")),
    );
  }

  async function renderSessions() {
    try {
      const list = await conn.api("/api/sessions");
      sessions.replaceChildren(
        list.length
          ? h("table", {},
              h("thead", {}, h("tr", {}, ...["Pass", "Kind", "Duration", "Records", "Notes"].map((t) => h("th", {}, t)))),
              h("tbody", {},
                ...list.map((s: any) =>
                  h("tr", {},
                    h("td", {}, s.id),
                    h("td", {}, `${s.kind} #${s.pass}`),
                    h("td", {}, s.duration_s != null ? `${fmt(s.duration_s, 0)} s` : "recording"),
                    h("td", {}, Object.entries(s.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")),
                    h("td", {}, s.notes ?? ""),
                  ))))
          : h("p", { class: "muted" }, "No passes recorded yet."),
      );
    } catch {
      /* host restarting */
    }
  }

  async function renderSettings() {
    const { values, overrides } = await conn.api("/api/config");
    const inputs: [string, string, HTMLInputElement | HTMLSelectElement, any][] = [];
    const sections = Object.entries<any>(values).map(([section, keys]) =>
      h("fieldset", {},
        h("legend", {}, section),
        ...Object.entries<any>(keys).map(([key, v]) => {
          let input: HTMLInputElement | HTMLSelectElement;
          if (typeof v === "boolean") {
            input = h("input", { type: "checkbox" });
            (input as HTMLInputElement).checked = v;
          } else if (key === "corner_refinement") {
            input = h("select", {}, ...["none", "subpix", "contour", "apriltag"].map((o) => h("option", { value: o }, o)));
            input.value = v;
          } else if (key === "model") {
            input = h("select", {}, ...["lite", "full", "heavy"].map((o) => h("option", { value: o }, o)));
            input.value = v;
          } else {
            input = h("input", { type: typeof v === "number" ? "number" : "text", step: "any", value: v });
          }
          inputs.push([section, key, input, v]);
          const changed = overrides?.[section]?.[key] !== undefined;
          return h("label", { class: changed ? "changed" : "" }, h("span", {}, key), input);
        }),
      ),
    );
    const save = h("button", {
      class: "primary",
      onclick: async () => {
        const changes: any = {};
        for (const [section, key, input, orig] of inputs) {
          const val = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked
            : typeof orig === "number" ? Number(input.value) : input.value;
          if (val !== orig) (changes[section] ??= {})[key] = val;
        }
        await conn.api("/api/config", "PUT", changes);
        toast("Settings saved");
        renderSettings();
      },
    }, "Save");
    const reset = h("button", {
      onclick: async () => {
        if (confirm("Reset all settings to defaults?")) {
          await conn.api("/api/config/reset", "POST");
          renderSettings();
        }
      },
    }, "Reset to defaults");
    settings.replaceChildren(...sections, h("div", { class: "row" }, save, reset));
  }

  let lastSession: string | null = null;
  const offs = [
    conn.on("state", (m) => {
      renderDevices();
      renderTagmap();
      const sid = m.session?.id ?? null;
      if (sid !== lastSession) {
        lastSession = sid;
        renderSessions();
      }
    }),
    conn.on("tagmap", renderTagmap),
  ];
  renderDevices();
  renderTagmap();
  renderSessions();
  renderSettings().catch(() => {});

  return { el, destroy: () => offs.forEach((off) => off()) };
}
