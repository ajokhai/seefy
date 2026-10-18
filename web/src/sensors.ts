// Sensors screen: connection QR, devices, tag map, sessions, signal sources, fidelity settings.

import { conn } from "./conn";
import { fmt, h, toast } from "./ui";

// SF Symbols-style glyphs: iphone and laptopcomputer.
function deviceIcon(phone: boolean): HTMLElement {
  const span = h("span", { class: `device-icon ${phone ? "phone" : ""}` });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${
    phone ? '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>' : '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>'
  }</svg>`;
  return span;
}

export function sensorsScreen(): { el: HTMLElement; destroy: () => void } {
  const devices = h("div");
  const tagmap = h("div");
  const sessions = h("div", { class: "table-wrap" });
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
    h("section", { class: "card devices-card" }, h("h3", {}, "Devices"), devices),
    h("section", { class: "card tagmap-card" }, h("h3", {}, "Tag map"), tagmap),
    h("section", { class: "card signal-card" },
      h("h3", {}, "Signal sources"),
      h("p", { class: "muted" },
        "WiFi signal capture comes in Phase 3. Seefy will detect what this laptop can report: link signal strength (any laptop), " +
        "per-packet signal strength from every fixed device it hears (monitor mode), or CSI on hardware that exposes it. " +
        "More fixed WiFi devices spread around the space, and more learn passes, both improve fidelity.")),
    h("section", { class: "card passes-card" }, h("h3", {}, "Recorded passes"), sessions),
    h("section", { class: "card settings-card" },
      h("h3", {}, "Settings"),
      h("p", { class: "muted" },
        "Everything that affects accuracy, grouped by what it's for. Changed settings are highlighted. Each recording saves a copy of the settings, so you can compare passes made with different values."),
      settings),
  );

  function renderDevices() {
    const ds = conn.state?.devices ?? [];
    if (!ds.length) {
      devices.replaceChildren(h("p", { class: "muted" }, "Nothing connected."));
      return;
    }
    // One row per device: who it is on the left, the numbers that matter for its role on the right.
    const metric = (label: string, value: string) => h("div", { class: "metric" }, h("span", {}, label), h("b", {}, value));
    devices.replaceChildren(
      h("div", { class: "device-list" },
        ...ds.map((d: any) => {
          const phone = d.role === "phone";
          return h("div", { class: "device" },
            deviceIcon(phone),
            h("div", { class: "device-name" },
              h("b", {}, d.name, d.id === conn.id ? h("span", { class: "this" }, "This device") : null),
              h("span", { class: "muted" }, `${phone ? "Phone" : "Viewer"} · ${d.mode} · ${d.ip}`)),
            h("div", { class: "metrics" },
              metric("Sync", d.sync?.err_ms != null ? `±${fmt(d.sync.err_ms, 1)} ms` : "–"),
              metric("Network", fmt(d.net_latency_ms, 0, " ms")),
              ...(phone
                ? [
                    metric("Camera→host", fmt(d.capture_latency_ms, 0, " ms")),
                    metric("Poses/s", fmt(d.rates?.pose ?? 0, 0)),
                    metric("Detect", d.status?.detect_ms != null ? `${fmt(d.status.detect_ms, 0)} ms @ ${fmt(d.status.fps, 0)} fps` : "–"),
                    metric("Lens", d.status?.lens_calibrated ? "Calibrated" : "Approx."),
                  ]
                : [])));
        })),
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
    const { values, overrides, docs } = await conn.api("/api/config");
    const inputs: [string, string, HTMLInputElement | HTMLSelectElement, any][] = [];
    const choices: Record<string, string[]> = {
      corner_refinement: ["none", "subpix", "contour", "apriltag"],
      model: ["lite", "full", "heavy"],
      origin_mount: ["floor", "upright"],
      camera_model: ["SIMPLE_RADIAL", "RADIAL", "OPENCV", "PINHOLE"],
    };
    const order = Object.keys(docs ?? values);
    const sections = order.filter((sec) => values[sec]).map((section, n) => {
      const [title, about] = docs?.[section]?._ ?? [section, ""];
      const changedCount = Object.keys(overrides?.[section] ?? {}).length;
      return h("details", { class: "setting-group", open: n === 0 },
        h("summary", {}, h("span", {}, title), changedCount ? h("span", { class: "badge" }, `${changedCount} changed`) : null),
        h("p", { class: "muted" }, about),
        ...Object.entries<any>(values[section]).map(([key, v]) => {
          const [label, help, unit] = docs?.[section]?.[key] ?? [key, "", ""];
          let input: HTMLInputElement | HTMLSelectElement;
          if (typeof v === "boolean") {
            input = h("input", { type: "checkbox" });
            (input as HTMLInputElement).checked = v;
          } else if (choices[key]) {
            input = h("select", {}, ...choices[key].map((o) => h("option", { value: o }, o)));
            input.value = v;
          } else if (typeof v === "object") {
            input = h("input", { type: "text", value: JSON.stringify(v) });
          } else {
            input = h("input", { type: typeof v === "number" ? "number" : "text", step: "any", value: v });
          }
          inputs.push([section, key, input, v]);
          const changed = overrides?.[section]?.[key] !== undefined;
          return h("label", { class: `setting ${changed ? "changed" : ""}` },
            h("div", { class: "setting-text" }, h("b", {}, label), h("span", { class: "muted" }, help)),
            h("div", { class: "setting-input" }, input, unit ? h("span", { class: "unit" }, unit) : null));
        }),
      );
    });
    const save = h("button", {
      class: "primary",
      onclick: async () => {
        const changes: any = {};
        for (const [section, key, input, orig] of inputs) {
          let val: any;
          if (input instanceof HTMLInputElement && input.type === "checkbox") val = input.checked;
          else if (typeof orig === "number") val = Number(input.value);
          else if (typeof orig === "object") {
            try {
              val = JSON.parse(input.value || "{}");
            } catch {
              toast(`${key}: not valid JSON`);
              return;
            }
            if (JSON.stringify(val) === JSON.stringify(orig)) continue;
          } else val = input.value;
          if (val !== orig) (changes[section] ??= {})[key] = val;
        }
        await conn.api("/api/config", "PUT", changes);
        toast("Settings saved");
        renderSettings();
      },
    }, "Save changes");
    const reset = h("button", {
      onclick: async () => {
        if (confirm("Reset all settings to their defaults?")) {
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
