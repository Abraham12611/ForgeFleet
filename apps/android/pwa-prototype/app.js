/* FF-019 fixture prototype app: hash router + deterministic fixture rendering.
   No backend calls. Owner state (sleep toggle, decision answers, sent
   messages) persists in localStorage only. */
(function () {
  "use strict";

  var ROUTES = [
    "#/home", "#/projects", "#/project/demo", "#/project/demo/chat",
    "#/project/demo/tasks", "#/project/demo/prs", "#/project/demo/files",
    "#/inbox", "#/fleet", "#/more"
  ];

  var store = {
    get: function (k, d) {
      try {
        var v = localStorage.getItem("ff019:" + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem("ff019:" + k, JSON.stringify(v)); } catch (e) {}
    }
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function ago(ageS) {
    if (ageS < 60) return "just now";
    if (ageS < 3600) return Math.floor(ageS / 60) + " min ago";
    return Math.floor(ageS / 3600) + " h ago";
  }

  function pill(state) {
    var map = {
      verified: "ok", running: "ok", pass: "ok", extracted: "ok",
      ready: "", acknowledged: "", sent: "", queued: "",
      blocked: "warn", retry_wait: "warn", changes_requested: "warn",
      failed: "bad", fail: "bad", unknown: "bad", disconnected: "bad", busy: ""
    };
    var label = {
      verified: "Verified", running: "Running", pass: "Pass", extracted: "Extracted",
      ready: "Ready", acknowledged: "Acknowledged", sent: "Sent", queued: "Queued",
      blocked: "Blocked", retry_wait: "Retry wait", changes_requested: "Changes requested",
      failed: "Failed", fail: "Fail", unknown: "Unknown — not stopped, not healthy", disconnected: "Disconnected", busy: "Busy"
    }[state] || state;
    return '<span class="pill ' + (map[state] || "") + '">' + esc(label) + "</span>";
  }

  function freshness(ageS, source) {
    return '<p class="muted small">Updated ' + esc(ago(ageS)) + " · source: " + esc(source) + "</p>";
  }

  function renderStatus(fx) {
    var el = document.getElementById("statusline");
    var offline = !navigator.onLine || store.get("offline", false);
    var sleep = store.get("sleep", fx.sleep.enabled);
    var parts = [];
    if (offline) {
      parts.push('<span class="offline">Offline — showing last fixture snapshot; actions queue locally.</span>');
    } else {
      parts.push("Fixture snapshot · reconcile 5s target (fixture)");
    }
    parts.push(sleep ? "Sleep ON — questions queue, independent work continues." : "Sleep off");
    el.innerHTML = parts.join(" · ");
  }

  function tabFor(hash) {
    if (hash.indexOf("#/project") === 0 || hash === "#/projects") return "projects";
    if (hash.indexOf("#/inbox") === 0) return "inbox";
    if (hash.indexOf("#/fleet") === 0) return "fleet";
    if (hash.indexOf("#/more") === 0) return "more";
    return "home";
  }

  function markTabs(hash) {
    var cur = tabFor(hash);
    var links = document.querySelectorAll(".tabs a");
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute("data-tab") === cur) links[i].setAttribute("aria-current", "page");
      else links[i].removeAttribute("aria-current");
    }
  }

  function vHome(fx) {
    var unanswered = store.get("answers", {});
    var inboxN = unanswered[fx.decision.id] ? 0 : 1;
    var count = document.getElementById("inbox-count");
    count.hidden = inboxN === 0;
    count.textContent = inboxN;
    return "<h1>Home</h1>" +
      '<div class="card"><h3>' + esc(fx.project.name) + "</h3>" +
      '<p class="muted">' + esc(fx.project.repo) + " · " + esc(fx.project.branch) +
      " · budget $" + fx.project.budget.spent_usd + " of $" + fx.project.budget.ceiling_usd + "</p>" +
      "<p><strong>Verified:</strong> " + esc(fx.home.verified[0]) + "</p>" +
      "<p><strong>Blocked:</strong> " + esc(fx.home.blocked[0]) + "</p>" +
      "<p><strong>Next:</strong> " + esc(fx.home.next[0]) + "</p>" +
      '<div class="btnrow"><a class="btn" href="#/project/demo/chat">Open coordinator chat</a>' +
      '<a class="btn secondary" href="#/inbox">Review inbox (' + inboxN + ")</a></div></div>" +
      '<div class="card"><h3>Start something new</h3>' +
      '<p class="muted">New-goal composer lives in chat (walkthrough step 1–3).</p>' +
      '<div class="btnrow"><a class="btn secondary" href="#/project/demo/chat">New goal</a></div></div>';
  }

  function vProjects(fx) {
    return "<h1>Projects</h1>" +
      '<div class="card"><h3>' + esc(fx.project.name) + "</h3>" +
      '<p class="muted">' + esc(fx.project.repo) + " · " + esc(fx.project.branch) + "</p>" +
      '<div class="btnrow"><a class="btn" href="#/project/demo">Open project</a></div></div>';
  }

  function subtabs(base, cur) {
    var tabs = [["chat", "Chat"], ["tasks", "Tasks"], ["prs", "PRs"], ["files", "Files"]];
    var h = '<nav class="subtabs" aria-label="Project sections">';
    tabs.forEach(function (t) {
      h += '<a href="#/project/demo/' + t[0] + '"' +
        (cur === t[0] ? ' aria-current="page"' : "") + ">" + t[1] + "</a>";
    });
    return h + "</nav>";
  }

  function vProject(fx) {
    return "<h1>" + esc(fx.project.name) + "</h1>" +
      '<p class="muted">' + esc(fx.project.repo) + " · " + esc(fx.project.branch) + "</p>" +
      subtabs() +
      '<div class="card"><h3>Overview</h3><p class="muted">Pick a section above. Coordinator card, progress, alerts.</p></div>';
  }

  function vChat(fx) {
    var h = "<h1>Coordinator chat</h1>" + subtabs(0, "chat");
    var extra = store.get("sent", []);
    var msgs = fx.messages.concat(extra);
    msgs.forEach(function (m) {
      h += '<div class="msg ' + esc(m.from) + '"><div class="who">' + esc(m.from) + "</div>" +
        "<p>" + esc(m.text) + "</p>";
      (m.citations || []).forEach(function (c) {
        h += '<p class="muted small">Cited: ' + esc(c) + "</p>";
      });
      h += '<p class="muted small">Delivery: ' + esc(m.delivery) + "</p></div>";
    });
    var attached = store.get("attached", []);
    h += '<div class="composer" role="form" aria-label="Send a coordinator message">' +
      '<div class="composer-row"><input id="chat-input" type="text" maxlength="500" ' +
      'placeholder="Message the coordinator…" aria-label="Message the coordinator">' +
      '<button id="chat-send" type="button">Send</button></div>' +
      '<label class="field" for="chat-file">Attach context (fixture file picker)</label>' +
      '<input id="chat-file" type="file" multiple>' +
      (attached.length ? '<p class="muted small">Attached (fixture): ' + esc(attached.join(", ")) + "</p>" : "") +
      "</div>";
    return h;
  }

  function vTasks(fx) {
    var h = "<h1>Task board</h1>" + subtabs(0, "tasks") +
      '<p class="muted">Dependency list replaces the wide DAG table on narrow screens.</p>';
    fx.tasks.forEach(function (t) {
      h += '<details class="task" id="task-' + esc(t.id) + '"><summary>' +
        pill(t.state) + " <span>" + esc(t.title) + "</span></summary>" +
        "<p>" + esc(t.detail) + "</p>";
      if (t.deps && t.deps.length) h += '<p class="muted small">Depends on: ' + esc(t.deps.join(", ")) + "</p>";
      if (t.attempt) {
        h += freshness(t.attempt.age_s, t.attempt.source);
        h += '<p class="muted small">Attempt ' + esc(t.attempt.id) + "</p>";
      }
      if (t.state === "failed") {
        h += '<div class="banner bad"><strong>Failed.</strong> Lease fence held; safe retry keeps the same logical request ID.</div>' +
          '<div class="btnrow"><button type="button" data-retry="' + esc(t.id) + '">Retry safely</button></div>';
      }
      if (t.state === "blocked") {
        h += '<div class="btnrow"><a class="btn secondary" href="#/inbox">See blocking decision</a></div>';
      }
      h += '<div class="btnrow"><a class="btn secondary" href="#/project/demo/tasks">Worker thread (fixture)</a></div>';
      h += "</details>";
    });
    return h;
  }

  function vPRs(fx) {
    var pr = fx.pr;
    var passes = pr.checks.filter(function (c) { return c.status === "pass"; }).length;
    var h = "<h1>PR review summary</h1>" + subtabs(0, "prs") +
      '<div class="card"><h3>PR #' + esc(pr.id) + " — " + esc(pr.title) + "</h3>" +
      '<p class="muted small">Head SHA ' + esc(pr.head_sha) + " · verdict: " + esc(pr.verdict) + "</p>" +
      "<p><strong>Checks: " + passes + " of " + pr.checks.length + " passing</strong></p>";
    pr.checks.forEach(function (c) {
      h += '<div class="check"><span class="dot ' + esc(c.status) + '">' +
        (c.status === "pass" ? "✓" : "✗") + "</span><span>" + esc(c.name) + " — " + esc(c.status) + "</span></div>";
    });
    h += '<div class="banner warn"><strong>Merge disabled.</strong> ' + esc(pr.merge_blocked_reason) + "</div>" +
      '<div class="btnrow"><button type="button" disabled title="' + esc(pr.merge_blocked_reason) + '">Merge (disabled)</button>' +
      '<button type="button" class="secondary" data-req-changes="1">Request changes</button></div></div>';
    return h;
  }

  function vFiles(fx) {
    var h = "<h1>Project context</h1>" + subtabs(0, "files");
    fx.files.forEach(function (f) {
      h += '<div class="card"><h3>' + esc(f.name) + "</h3><p>" + pill(f.status) + "</p>";
      if (f.status === "failed") {
        h += '<div class="banner bad"><strong>Extraction failed.</strong> Retry parsing or replace the file; agents were not given its content.</div>' +
          '<div class="btnrow"><button type="button" class="secondary" data-retry-file="' + esc(f.name) + '">Retry extraction</button></div>';
      } else {
        h += '<p class="muted small">Revision ' + esc(f.version) + " · source pointer retained</p>";
      }
      h += "</div>";
    });
    return h;
  }

  function vInbox(fx) {
    var d = fx.decision;
    var answers = store.get("answers", {});
    var filter = store.get("inboxFilter", "needs");
    var h = "<h1>Decision inbox</h1>" +
      '<div class="subtabs" role="group" aria-label="Inbox filters">' +
      [["needs", "Needs me"], ["fyi", "FYI"], ["approved", "Approved"], ["archived", "Archived"]].map(function (f) {
        return '<a href="#/inbox" data-filter="' + f[0] + '"' +
          (filter === f[0] ? ' aria-current="page"' : "") + ">" + f[1] + "</a>";
      }).join("") + "</div>";
    if (filter !== "needs") {
      return h + '<div class="card"><h3>' + esc(filter === "fyi" ? "FYI" : filter === "approved" ? "Approved" : "Archived") +
        "</h3><p class=\"muted\">No items in this fixture filter.</p></div>";
    }
    if (answers[d.id]) {
      return h + '<div class="card"><h3>' + esc(d.title) + "</h3>" +
        '<p><strong>Answered (fixture):</strong> ' + esc(answers[d.id]) + "</p>" +
        '<p class="muted">Recorded as an immutable event; dependent tasks re-evaluate.</p></div>';
    }
    h += '<div class="card"><h3>' + esc(d.title) + "</h3>" +
      "<p><strong>Why blocked:</strong> " + esc(d.reason) + "</p>" +
      '<p class="muted">Blocked tasks: ' + esc(d.blocked_tasks.join(", ")) +
      " · from " + esc(d.source_agent) + "</p>" +
      '<p><strong>Recommended:</strong> ' + esc(d.recommended) + "</p>" +
      "<p><strong>Risk:</strong> " + esc(d.risk) + "</p>" +
      '<p class="muted">On timeout: ' + esc(d.default_on_timeout) + "</p>" +
      freshness(d.last_updated_age_s, "fixture") +
      '<label class="field" for="decision-choice">Your answer</label>' +
      '<select id="decision-choice">' +
      d.choices.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + "</option>"; }).join("") +
      "</select>" +
      '<div class="btnrow"><button type="button" id="decision-send">Answer decision</button></div></div>';
    return h;
  }

  function vFleet(fx) {
    var h = "<h1>Fleet</h1>" +
      '<p class="muted">Liveness is last-reconciled telemetry, never assumed from dispatch.</p>';
    fx.agents.forEach(function (a) {
      h += '<div class="card"><h3>' + esc(a.name) + "</h3>" +
        "<p>" + pill(a.state) + "</p>" +
        '<p class="muted">' + esc(a.model) + (a.task ? " · task " + esc(a.task) : " · no task") + "</p>" +
        freshness(a.heartbeat_age_s, "fixture heartbeat") + "</div>";
    });
    return h;
  }

  function vMore(fx) {
    var sleep = store.get("sleep", fx.sleep.enabled);
    var offline = store.get("offline", false);
    var h = "<h1>More</h1>" +
      '<div class="card"><h3>Sleep mode</h3>' +
      '<div class="switchrow"><input type="checkbox" id="sleep-toggle"' + (sleep ? " checked" : "") + ">" +
      "<label for=\"sleep-toggle\">Sleeping — queue questions, keep independent work running</label></div>" +
      '<p class="muted">' + esc(fx.sleep.note) + "</p></div>" +
      '<div class="card"><h3>Notifications</h3>' +
      '<p class="muted">Browser notifications where available. Native push ships with the Capacitor build (FF-025), not this prototype.</p>' +
      '<div class="switchrow"><input type="checkbox" id="notif-toggle">' +
      '<label for="notif-toggle">Notify me on decisions (fixture preference)</label></div></div>' +
      '<div class="card"><h3>Diagnostics</h3>' +
      '<div class="switchrow"><input type="checkbox" id="offline-toggle"' + (offline ? " checked" : "") + ">" +
      "<label for=\"offline-toggle\">Simulate offline (fixture)</label></div>" +
      '<p class="muted small">Service worker: app-shell cache v1. Audit trail: fixture only.</p></div>';
    return h;
  }

  function render(fx) {
    var hash = location.hash || "#/home";
    var view = document.getElementById("view");
    markTabs(hash);
    var html;
    if (hash === "#/projects") html = vProjects(fx);
    else if (hash === "#/project/demo/chat") html = vChat(fx);
    else if (hash === "#/project/demo/tasks") html = vTasks(fx);
    else if (hash === "#/project/demo/prs") html = vPRs(fx);
    else if (hash === "#/project/demo/files") html = vFiles(fx);
    else if (hash === "#/project/demo") html = vProject(fx);
    else if (hash.indexOf("#/inbox") === 0) html = vInbox(fx);
    else if (hash.indexOf("#/fleet") === 0) html = vFleet(fx);
    else if (hash.indexOf("#/more") === 0) html = vMore(fx);
    else html = vHome(fx);
    view.innerHTML = html;
    renderStatus(fx);
    wire(fx, hash);
  }

  function wire(fx, hash) {
    var send = document.getElementById("chat-send");
    if (send) {
      send.addEventListener("click", function () {
        var input = document.getElementById("chat-input");
        var text = input.value.trim();
        if (!text) { input.focus(); return; }
        var sent = store.get("sent", []);
        sent.push({ from: "owner", text: text, citations: [], delivery: "queued", age_s: 0 });
        store.set("sent", sent);
        input.value = "";
        render(fx);
      });
    }
    var file = document.getElementById("chat-file");
    if (file) {
      file.addEventListener("change", function () {
        var names = [];
        for (var i = 0; i < file.files.length; i++) names.push(file.files[i].name);
        store.set("attached", names);
        render(fx);
      });
    }
    var ds = document.getElementById("decision-send");
    if (ds) {
      ds.addEventListener("click", function () {
        var answers = store.get("answers", {});
        answers[fx.decision.id] = document.getElementById("decision-choice").value;
        store.set("answers", answers);
        render(fx);
      });
    }
    var filters = document.querySelectorAll("[data-filter]");
    for (var i = 0; i < filters.length; i++) {
      filters[i].addEventListener("click", function () {
        store.set("inboxFilter", this.getAttribute("data-filter"));
      });
    }
    var st = document.getElementById("sleep-toggle");
    if (st) st.addEventListener("change", function () { store.set("sleep", st.checked); renderStatus(fx); });
    var ot = document.getElementById("offline-toggle");
    if (ot) ot.addEventListener("change", function () { store.set("offline", ot.checked); renderStatus(fx); });
    var retries = document.querySelectorAll("[data-retry]");
    for (var j = 0; j < retries.length; j++) {
      retries[j].addEventListener("click", function () {
        this.textContent = "Retry queued (fixture — same request ID)";
        this.disabled = true;
      });
    }
  }

  function boot() {
    fetch("fixtures.json", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("fixture load failed: " + r.status);
      return r.json();
    }).then(function (fx) {
      window.addEventListener("hashchange", function () { render(fx); });
      window.addEventListener("online", function () { renderStatus(fx); });
      window.addEventListener("offline", function () { renderStatus(fx); });
      if (!location.hash) location.hash = "#/home";
      render(fx);
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("sw.js").catch(function () {});
      }
    }).catch(function (err) {
      document.getElementById("view").innerHTML =
        '<div class="banner bad"><strong>Fixture failed to load.</strong> ' + esc(err.message) + "</div>";
    });
  }

  window.__ff019 = { ROUTES: ROUTES };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
