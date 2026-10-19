// Background jobs (server jobs.py): building a scan's map and joining scans into a space's map.
// The server sends {type: "jobs", jobs: [...]} whenever one changes; GET /api/jobs gives the list.
// Each job: {id, kind: "scan" | "join", label, state, stage, progress, elapsed_s, cpu_pct, ram_mb,
// scan_id?, space_id?}. States: queued, running, paused, done, failed, cancelled.

import { conn } from "./conn";
import { h, toast } from "./ui";

export type Job = Record<string, any>;

let jobs: Job[] = [];
const listeners = new Set<(jobs: Job[]) => void>();
conn.on("jobs", (m) => {
  jobs = m.jobs ?? [];
  listeners.forEach((fn) => fn(jobs));
});

/** Call fn now (after loading the list) and whenever jobs change; returns an unsubscribe. */
export function onJobs(fn: (jobs: Job[]) => void): () => void {
  listeners.add(fn);
  conn.api("/api/jobs").then((r: any) => {
    jobs = r.jobs ?? jobs;
    fn(jobs);
  }).catch(() => fn(jobs));
  return () => listeners.delete(fn);
}

export const isActive = (j: Job | undefined) => !!j && ["queued", "running", "paused"].includes(j.state);

/** The current job for a scan or a space's map, if one is queued, running or paused. */
export function jobFor(list: Job[], match: { scan_id?: string; space_id?: string }): Job | undefined {
  return [...list].reverse().find((j) => isActive(j) &&
    (match.scan_id ? j.kind === "scan" && j.scan_id === match.scan_id : j.kind === "join" && j.space_id === match.space_id));
}

const mins = (s: number) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

/** One line saying what a job is doing: "Matching photos · 42% · 3 min 10 s · 480% CPU". */
export function jobText(j: Job): string {
  if (j.state === "queued") return "Waiting for the job before it";
  const parts = [j.state === "paused" ? "Paused" : j.stage];
  if (j.progress != null) parts.push(`${Math.round(j.progress * 100)}%`);
  if (j.elapsed_s) parts.push(mins(j.elapsed_s));
  if (j.state === "running" && j.cpu_pct != null) parts.push(`${(j.cpu_pct / 100).toFixed(1)} cores`);
  return parts.join(" · ");
}

export function progressBar(j: Job): HTMLElement {
  const bar = h("div", { class: `job-bar ${j.state}${j.progress == null ? " unknown" : ""}` }, h("div"));
  (bar.firstChild as HTMLElement).style.width = `${Math.round((j.progress ?? 0.3) * 100)}%`;
  return bar;
}

export async function jobAction(j: Job, action: "pause" | "resume" | "cancel"): Promise<void> {
  try {
    await conn.api(`/api/jobs/${j.id}/${action}`, "POST");
  } catch (e: any) {
    toast(errMsg(e));
  }
}

/** Pause / Resume / Stop buttons for a job. */
export function jobButtons(j: Job): HTMLElement[] {
  const b = (label: string, action: "pause" | "resume" | "cancel", cls = "link-btn") =>
    h("button", { class: cls, onclick: (e: Event) => { e.stopPropagation(); e.preventDefault(); jobAction(j, action); } }, label);
  if (j.state === "running") return [b("Pause", "pause"), b("Stop", "cancel", "link-btn danger")];
  if (j.state === "paused") return [b("Resume", "resume"), b("Stop", "cancel", "link-btn danger")];
  if (j.state === "queued") return [b("Cancel", "cancel", "link-btn danger")];
  return [];
}

/** The server's reason from a failed conn.api call, without the method, path and JSON around it. */
export function errMsg(e: any): string {
  const s = String(e?.message ?? e);
  const m = s.match(/"detail":\s*"([^"]+)"/);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : s;
}
