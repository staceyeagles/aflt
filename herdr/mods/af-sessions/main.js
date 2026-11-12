// af sessions: list tracked Cursor/Copilot sessions and focus or resume them.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, spaces, focused, run, theme, notify } from "herdr";

const REFRESH_MS = 8000;
const EXEC_TIMEOUT = 20000;
const RESUME_TIMEOUT = 60000;
const POLL_MS = 1000;
const POLL_MAX_MS = 15000;
const NARROW_PX = 160;

const RUNTIME_RANK = { running: 0, exited: 1, missing: 2, unknown: 3, "-": 4 };

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function basename(p) {
  if (!p) return "";
  const s = String(p).replace(/[/\\]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function relUsed(iso, now) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.floor((now - t) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function truncate(s, n) {
  const t = String(s || "");
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + "…";
}

function runtimeColor(t, runtime) {
  if (runtime === "running") return t.working || t.accent;
  if (runtime === "exited") return t.muted || t.dim;
  if (runtime === "missing" || runtime === "unknown") return t.blocked || t.unknown || t.dim;
  return t.dim;
}

function tabPresent(tabId) {
  if (!tabId) return false;
  for (const s of spaces()) {
    for (const tab of s.tabs || []) {
      if (tab.id === tabId) return true;
    }
  }
  return false;
}

function focusHerdr(spaceId, tabId) {
  if (spaceId) run("space.select", { id: String(spaceId) });
  if (tabId) run("tab.select", { id: String(tabId) });
}

/** Resolve and run `af` even when the app's PATH is minimal. */
async function execAf(args, timeout = EXEC_TIMEOUT) {
  const afBin = `${home()}/.local/bin/af`;
  try {
    const r = await exec(afBin, args, { timeout });
    const err = `${r.stderr || ""}${r.stdout || ""}`;
    if (r.code !== 0 && /node[: ].*not found|ENOENT|command not found/i.test(err)) {
      throw new Error("node-not-found");
    }
    return r;
  } catch (e) {
    const msg = String(e?.message || e);
    // Timeouts reject too; don't retry via zsh.
    if (/timed out|timeout/i.test(msg) && !/node-not-found/i.test(msg)) {
      return { code: 124, stdout: "", stderr: msg };
    }
    // Failed to start, or node missing under a shebang: fall back to login zsh.
    const cmdline = ["af", ...args].map(shellQuote).join(" ");
    return exec("/bin/zsh", ["-lc", cmdline], { timeout });
  }
}

function parseLsJson(text) {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") return { sessions: [], queryOk: false, error: "bad json" };
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    return { sessions, queryOk: Boolean(data.queryOk), error: null };
  } catch (e) {
    return { sessions: [], queryOk: false, error: "parse failed" };
  }
}

function sortSessions(list) {
  return [...list].sort((a, b) => {
    const ra = RUNTIME_RANK[a?.herdr?.runtime] ?? 9;
    const rb = RUNTIME_RANK[b?.herdr?.runtime] ?? 9;
    if (ra !== rb) return ra - rb;
    const ta = Date.parse(a?.lastUsed || "") || 0;
    const tb = Date.parse(b?.lastUsed || "") || 0;
    return tb - ta;
  });
}

export default class AfSessions extends View {
  init(_props, cx) {
    this.size = { width: 268, height: 200 };
    this.sessions = [];
    this.queryOk = true;
    this.error = null;
    this.refreshing = false;
    this.starting = {}; // title -> true while resume in flight / polling
    this.pollTask = null;
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await execAf(["ls", "--json", "--all"], EXEC_TIMEOUT);
        if (r.code !== 0) {
          const tail = String(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(-200);
          this.error = tail || `af ls failed (${r.code})`;
          this.sessions = [];
          this.queryOk = false;
        } else {
          const parsed = parseLsJson(r.stdout || "");
          if (parsed.error && parsed.sessions.length === 0) {
            this.error = parsed.error;
            this.sessions = [];
            this.queryOk = false;
          } else {
            this.sessions = sortSessions(parsed.sessions);
            this.queryOk = parsed.queryOk;
            this.error = parsed.queryOk ? null : "herdr query failed";
          }
        }
      } catch (e) {
        this.error = String(e?.message || e).slice(0, 200);
        this.sessions = [];
        this.queryOk = false;
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  async adoptAndFocus(row, cx) {
    const title = row.title;
    try {
      const r = await execAf(["adopt", title], EXEC_TIMEOUT);
      if (r.code !== 0) {
        notify({
          title: "af adopt failed",
          body: String(r.stderr || r.stdout || "").trim().slice(-240),
          level: "error",
        });
        return;
      }
      this.refresh(cx);
      const space = row.herdrApp?.space;
      const tab = row.herdrApp?.tab;
      if (space || tab) focusHerdr(space, tab);
    } catch (e) {
      notify({ title: "af adopt failed", body: String(e?.message || e).slice(0, 200), level: "error" });
    }
  }

  startPollFocus(row, cx) {
    const tabId = row.herdrApp?.tab;
    const spaceId = row.herdrApp?.space;
    const started = Date.now();
    if (this.pollTask) {
      try { this.pollTask.cancel(); } catch (_) { /* ignore */ }
      this.pollTask = null;
    }
    this.pollTask = cx.timer.every(POLL_MS, (cx) => {
      if (tabId && tabPresent(tabId)) {
        focusHerdr(spaceId, tabId);
        this.starting[row.title] = false;
        if (this.pollTask) {
          try { this.pollTask.cancel(); } catch (_) { /* ignore */ }
          this.pollTask = null;
        }
        cx.notify();
        return;
      }
      if (Date.now() - started >= POLL_MAX_MS) {
        this.starting[row.title] = false;
        if (this.pollTask) {
          try { this.pollTask.cancel(); } catch (_) { /* ignore */ }
          this.pollTask = null;
        }
        notify({
          title: "af resume",
          body: `Started "${row.title}" but the Herdr tab did not appear yet.`,
          level: "warning",
        });
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  onRowClick(row, cx) {
    const runtime = row?.herdr?.runtime;
    const space = row.herdrApp?.space;
    const tab = row.herdrApp?.tab;

    if (runtime === "running") {
      if (tab && tabPresent(tab)) {
        focusHerdr(space, tab);
        return;
      }
      // Running but not labeled into the app yet.
      cx.spawn(async (cx) => {
        await this.adoptAndFocus(row, cx);
        cx.notify();
      });
      return;
    }

    if (this.starting[row.title]) return;
    this.starting[row.title] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await execAf(["resume", row.title, "--no-open"], RESUME_TIMEOUT);
        if (r.code !== 0) {
          this.starting[row.title] = false;
          notify({
            title: "af resume failed",
            body: String(r.stderr || r.stdout || "").trim().slice(-240) || `exit ${r.code}`,
            level: "error",
          });
          cx.notify();
          return;
        }
        this.startPollFocus(row, cx);
        this.refresh(cx);
      } catch (e) {
        this.starting[row.title] = false;
        notify({ title: "af resume failed", body: String(e?.message || e).slice(0, 200), level: "error" });
        cx.notify();
      }
    });
  }

  dot(t, runtime) {
    return div()
      .size(7)
      .mx(3)
      .flex_none()
      .rounded(4)
      .bg(runtimeColor(t, runtime));
  }

  compactRow(row, t, selected) {
    const runtime = row?.herdr?.runtime || "-";
    return h_flex()
      .id(`af-rail-${row.id}`)
      .h(26)
      .px(8)
      .flex_none()
      .items_center()
      .justify_center()
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .when(Boolean(row.title), (el) => el.tooltip(String(row.title)))
      .on_click((_e, cx) => this.onRowClick(row, cx))
      .child(this.dot(t, runtime));
  }

  row(row, t, selected, now) {
    const runtime = row?.herdr?.runtime || "-";
    const folder = basename(row.cwd);
    const starting = Boolean(this.starting[row.title]);
    return h_flex()
      .id(`af-${row.id}`)
      .px(8)
      .py(4)
      .h(42)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(8)
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .cursor_pointer()
      .on_click((_e, cx) => this.onRowClick(row, cx))
      .child(this.dot(t, runtime))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .min_w(0)
              .child(div().min_w(0).flex_1().truncate().text_color(t.foreground).child(truncate(row.title, 28)))
              .when(starting, (el) =>
                el.child(
                  h_flex()
                    .flex_none()
                    .gap(4)
                    .items_center()
                    .text_size(11)
                    .text_color(t.dim)
                    .child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))
                    .child("starting…"),
                ),
              ),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .min_w(0)
              .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(folder))
              .when(Boolean(row.branch), (el) =>
                el.child(div().flex_none().text_size(11).text_color(t.dim).child(truncate(row.branch, 16))),
              )
              .child(div().flex_1())
              .child(div().flex_none().text_size(11).text_color(t.dim).child(row.status || ""))
              .child(div().flex_none().text_size(11).text_color(t.dim).child(relUsed(row.lastUsed, now))),
          ),
      );
  }

  sectionHeader(label, t) {
    return h_flex()
      .px(8)
      .pt(8)
      .h(28)
      .flex_none()
      .items_center()
      .text_size(11)
      .font_medium()
      .text_color(t.dim)
      .child(label);
  }

  render(cx) {
    const t = theme();
    const narrow = (this.size?.width ?? 268) < NARROW_PX;
    const now = Date.now();
    const currentTab = focused()?.tab;
    const list = this.sessions || [];
    const running = list.filter((s) => s?.herdr?.runtime === "running");
    const other = list.filter((s) => s?.herdr?.runtime !== "running");

    const rows = [];
    if (!narrow) {
      if (running.length) {
        rows.push(this.sectionHeader("Running", t));
        for (const s of running) {
          rows.push(this.row(s, t, currentTab && s.herdrApp?.tab === currentTab, now));
        }
      }
      if (other.length) {
        rows.push(this.sectionHeader(running.length ? "Other" : "Sessions", t));
        for (const s of other) {
          rows.push(this.row(s, t, currentTab && s.herdrApp?.tab === currentTab, now));
        }
      }
    } else {
      for (const s of list) {
        rows.push(this.compactRow(s, t, currentTab && s.herdrApp?.tab === currentTab));
      }
    }

    return v_flex()
      .id("root")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(12.5)
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      })
      .when(!narrow, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().text_size(11.5).font_medium().text_color(t.dim).child("af sessions"))
                .child(div().text_size(11).text_color(t.dim).child(String(list.length)))
                .when(this.refreshing, (el) =>
                  el.child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .loop("opacity", { from: 0.35, to: 1, period: 1000 })
                      .child("refreshing"),
                  ),
                ),
            )
            .child(
              div()
                .id("af-refresh")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .tooltip("Refresh now")
                .on_click((_e, cx) => this.refresh(cx))
                .child("↻"),
            ),
        ),
      )
      .when(Boolean(this.error) && !narrow, (el) =>
        el.child(div().px(12).pb(4).text_size(11).text_color(t.blocked || t.dim).child(truncate(this.error, 80))),
      )
      .when(list.length === 0 && !narrow && !this.error, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No af sessions.")),
      )
      .child(v_flex().id("af-list").flex_1().min_h(0).px(narrow ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows));
  }
}
