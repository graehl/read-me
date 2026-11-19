// Your recordings: lists the takes this browser uploaded and downloads them one by one or as a zip.
// Downloads go through fetch because the owner token travels in a header, not in the URL.

import { OWNER_HEADER, existingOwnerToken } from "./owner-token.js";

const $ = (id) => document.getElementById(id);

async function fetchOwned(url, token) {
  const response = await fetch(url, { headers: { [OWNER_HEADER]: token } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return response;
}

async function download(url, fileName, token) {
  $("status").textContent = `Downloading ${fileName}…`;
  try {
    const blob = await (await fetchOwned(url, token)).blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    $("status").textContent = "";
  } catch (error) {
    $("status").textContent = `Download failed: ${error.message}`;
  }
}

function takeRow(take, token) {
  const row = document.createElement("li");
  const link = document.createElement("a");
  link.href = take.url;
  link.textContent = take.file_name;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    download(take.url, take.file_name, token);
  });
  const detail = document.createElement("span");
  detail.className = "take-detail";
  detail.textContent = ` ${take.duration_s.toFixed(1)} s${take.accepted ? " · kept" : ""} · ${take.line_text}`;
  row.append(link, detail);
  return row;
}

function renderGroups(takes, token) {
  const groups = new Map();
  for (const take of takes) {
    const key = `${take.request_id} · ${take.speaker}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(take);
  }
  $("groups").replaceChildren(
    ...[...groups].map(([title, group]) => {
      const section = document.createElement("section");
      const heading = document.createElement("h2");
      heading.textContent = title;
      const list = document.createElement("ul");
      list.className = "take-list";
      list.append(...group.map((take) => takeRow(take, token)));
      section.append(heading, list);
      return section;
    }),
  );
}

async function main() {
  const token = existingOwnerToken();
  if (!token) {
    $("status").textContent = "No recordings from this browser yet.";
    return;
  }
  let takes;
  try {
    takes = (await (await fetchOwned("/api/mine", token)).json()).takes;
  } catch (error) {
    $("status").textContent = `Cannot list your recordings: ${error.message}`;
    return;
  }
  $("take-count").textContent = `${takes.length} take${takes.length === 1 ? "" : "s"}`;
  if (takes.length === 0) {
    $("status").textContent = "No recordings from this browser yet.";
    return;
  }
  renderGroups(takes, token);
  $("download-zip").hidden = false;
  const includeRetried = $("include-retried");
  includeRetried.addEventListener("change", () => {
    $("download-all").textContent = includeRetried.checked ? "Download all takes (.zip)" : "Download kept takes (.zip)";
  });
  $("download-all").addEventListener("click", () => {
    if (includeRetried.checked) download("/api/mine/takes.zip", "read-me-takes.zip", token);
    else download("/api/mine/kept.zip", "read-me-kept.zip", token);
  });
}

main();
