// All recordings: the owner's view of every stored take, by request and speaker, after a password
// login. The session is an HttpOnly cookie, so downloads are plain navigations to attachment URLs.

const $ = (id) => document.getElementById(id);

/** Download choices from the page's checkboxes: retried takes too, and capture-rate files. */
const choices = () => ({ retried: $("include-retried").checked, original: $("original-rate").checked });

const zipLabel = ({ retried }) => (retried ? "zip (all takes)" : "zip (kept)");
/** The zip route for a scope ("" for everything, "/<request>", "/<request>/<speaker>"). */
const zipUrl = (scope, { retried, original }) =>
  `/api/owner${scope}/${retried ? "takes" : "kept"}${original ? ".orig" : ""}.zip`;

function downloadButton(text, url) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link";
  button.textContent = text;
  button.addEventListener("click", () => location.assign(url()));
  return button;
}

function takeRow(take, { original }) {
  const useOriginal = original && take.has_original;
  const row = document.createElement("li");
  const link = document.createElement("a");
  link.href = useOriginal ? take.url.replace(/\.flac$/, ".orig.flac") : take.url;
  link.download = useOriginal ? take.file_name.replace(/\.flac$/, ".orig.flac") : take.file_name;
  link.textContent = link.download;
  const detail = document.createElement("span");
  detail.className = "take-detail";
  const rate = useOriginal ? take.source_sample_rate : 16000;
  detail.textContent = ` ${take.duration_s.toFixed(1)} s · ${rate / 1000} kHz${take.accepted ? " · kept" : ""} · ${take.line_text}`;
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

function renderGroups(takes) {
  const chosen = choices();
  const requests = [...groupBy(takes, (t) => t.request_id)].map(([requestId, requestTakes]) => {
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.append(`${requestId} `, downloadButton(zipLabel(chosen), () => zipUrl(`/${requestId}`, choices())));
    section.append(heading);
    for (const [speaker, speakerTakes] of groupBy(requestTakes, (t) => t.speaker)) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      const kept = speakerTakes.filter((t) => t.accepted).length;
      const zip = downloadButton(zipLabel(chosen), () => zipUrl(`/${requestId}/${speaker}`, choices()));
      // A click on a control inside <summary> would also toggle the list.
      zip.addEventListener("click", (event) => event.preventDefault());
      summary.append(`${speaker}: ${kept} kept, ${speakerTakes.length} takes `, zip);
      const list = document.createElement("ul");
      list.className = "take-list";
      list.append(...speakerTakes.map((take) => takeRow(take, chosen)));
      details.append(summary, list);
      section.append(details);
    }
    return section;
  });
  $("groups").replaceChildren(...requests);
  $("zip-all").textContent = chosen.retried ? "Download all takes (.zip)" : "Download kept takes (.zip)";
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
  renderGroups(takes);
  $("download-zip").hidden = false;
  for (const box of [$("include-retried"), $("original-rate")]) box.addEventListener("change", () => renderGroups(takes));
  $("zip-all").addEventListener("click", () => location.assign(zipUrl("", choices())));
}

main();
