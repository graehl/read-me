// All recordings: the owner's view of every stored take, by request and speaker, after a password
// login. The session is an HttpOnly cookie, so downloads are plain navigations to attachment URLs.

const $ = (id) => document.getElementById(id);

const zipLabel = (retried) => (retried ? "zip (all takes)" : "zip (kept)");
/** The zip route for a scope ("" for everything, "/<request>", "/<request>/<speaker>"). */
const zipUrl = (scope, retried) => `/api/owner${scope}/${retried ? "takes" : "kept"}.zip`;

function downloadButton(text, url) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link";
  button.textContent = text;
  button.addEventListener("click", () => location.assign(url()));
  return button;
}

function takeRow(take) {
  const row = document.createElement("li");
  const link = document.createElement("a");
  link.href = take.url;
  link.download = take.file_name;
  link.textContent = take.file_name;
  const detail = document.createElement("span");
  detail.className = "take-detail";
  detail.textContent = ` ${take.duration_s.toFixed(1)} s${take.accepted ? " · kept" : ""} · ${take.line_text}`;
  row.append(link, detail);
  return row;
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

function heading(level, text, scope, retried) {
  const h = document.createElement(level);
  h.append(`${text} `, downloadButton(zipLabel(retried()), () => zipUrl(scope, retried())));
  return h;
}

function renderGroups(takes, retried) {
  const requests = [...groupBy(takes, (t) => t.request_id)].map(([requestId, requestTakes]) => {
    const section = document.createElement("section");
    section.append(heading("h2", requestId, `/${requestId}`, retried));
    for (const [speaker, speakerTakes] of groupBy(requestTakes, (t) => t.speaker)) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      const kept = speakerTakes.filter((t) => t.accepted).length;
      const zip = downloadButton(zipLabel(retried()), () => zipUrl(`/${requestId}/${speaker}`, retried()));
      // A click on a control inside <summary> would also toggle the list.
      zip.addEventListener("click", (event) => event.preventDefault());
      summary.append(`${speaker}: ${kept} kept, ${speakerTakes.length} takes `, zip);
      const list = document.createElement("ul");
      list.className = "take-list";
      list.append(...speakerTakes.map(takeRow));
      details.append(summary, list);
      section.append(details);
    }
    return section;
  });
  $("groups").replaceChildren(...requests);
}

async function showLogin() {
  $("login").hidden = false;
  $("login").addEventListener("submit", async (event) => {
    event.preventDefault();
    const response = await fetch("/api/owner/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: $("login-user").value.trim(), password: $("login-password").value }),
    });
    if (response.ok) {
      location.reload();
    } else {
      const body = await response.json().catch(() => ({}));
      $("status").textContent = body.error || `HTTP ${response.status}`;
    }
  });
}

async function main() {
  const response = await fetch("/api/owner/takes");
  if (response.status === 401) return showLogin();
  if (!response.ok) {
    $("status").textContent = `Cannot list recordings: HTTP ${response.status}`;
    return;
  }
  const { takes } = await response.json();
  $("take-count").textContent = `${takes.length} take${takes.length === 1 ? "" : "s"}`;
  if (takes.length === 0) {
    $("status").textContent = "No recordings yet.";
    return;
  }
  const includeRetried = $("include-retried");
  const retried = () => includeRetried.checked;
  renderGroups(takes, retried);
  $("download-zip").hidden = false;
  includeRetried.addEventListener("change", () => {
    $("zip-all").textContent = retried() ? "Download all takes (.zip)" : "Download kept takes (.zip)";
    renderGroups(takes, retried);
  });
  $("zip-all").addEventListener("click", () => location.assign(zipUrl("", retried())));
}

main();
