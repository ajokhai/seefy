// Tiny DOM helpers.

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, any> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

export function fmt(v: number | null | undefined, digits = 1, unit = ""): string {
  return v == null || Number.isNaN(v) ? "–" : `${v.toFixed(digits)}${unit}`;
}

export function toast(text: string): void {
  const t = h("div", { class: "toast" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

// ---- bottom sheets (docs/UX.md: secondary tasks slide up; never prompt() or confirm()) ----------

/** Show a sheet over the current screen. build() gets close(); the returned close() dismisses it too. */
export function sheet(build: (close: () => void) => Node): { close: () => void } {
  const panel = h("div", { class: "sheet-panel", role: "dialog" });
  const back = h("div", { class: "sheet" }, panel);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.classList.remove("open");
    document.removeEventListener("keydown", onKey);
    setTimeout(() => back.remove(), 220);
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  back.addEventListener("click", (e) => e.target === back && close());
  document.addEventListener("keydown", onKey);
  panel.append(h("div", { class: "sheet-grip" }), build(close));
  document.body.append(back);
  requestAnimationFrame(() => back.classList.add("open"));
  return { close };
}

/** Ask for a short piece of text. Resolves null when dismissed. */
export function askText(title: string, opts: { value?: string; placeholder?: string; action?: string; hint?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let answer: string | null = null;
    const input = h("input", { type: "text", value: opts.value ?? "", placeholder: opts.placeholder ?? "", autocomplete: "off" }) as HTMLInputElement;
    const s = sheet((close) => {
      const done = () => {
        const v = input.value.trim();
        if (!v) return input.focus();
        answer = v;
        close();
      };
      input.onkeydown = (e) => e.key === "Enter" && done();
      return h("div", { class: "sheet-body" },
        h("h2", {}, title), opts.hint ? h("p", { class: "muted" }, opts.hint) : null, input,
        h("button", { class: "primary", onclick: done }, opts.action ?? "Save"));
    });
    const obs = new MutationObserver(() => {
      if (!input.isConnected) {
        obs.disconnect();
        resolve(answer);
      }
    });
    obs.observe(document.body, { childList: true });
    setTimeout(() => input.focus(), 60);
    void s;
  });
}

/** Ask to confirm something. Resolves true only when the action button is pressed. */
export function confirmSheet(title: string, body: string, action: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    let panel: HTMLElement;
    sheet((close) => (panel = h("div", { class: "sheet-body" },
      h("h2", {}, title), h("p", { class: "muted" }, body),
      h("button", { class: `primary ${danger ? "danger" : ""}`, onclick: () => { ok = true; close(); } }, action),
      h("button", { class: "link-btn", onclick: close }, "Cancel"))));
    const obs = new MutationObserver(() => {
      if (!panel.isConnected) {
        obs.disconnect();
        resolve(ok);
      }
    });
    obs.observe(document.body, { childList: true });
  });
}
