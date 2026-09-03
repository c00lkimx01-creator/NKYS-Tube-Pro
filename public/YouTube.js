/* NKYS Tube Pro client logic */
"use strict";
/* =====================================================================
   NKYS Tube Pro — single-file client
   ストリーム: yt.omada.cafe を最優先
   その他: Invidious インスタンスを役割別に分担（検索/急上昇/メタ/コメント/チャンネル）
   ===================================================================== */

const STREAM_PRIMARY = "https://yt.omada.cafe";

/* 役割分担プール — 各役割で別インスタンス群に振ることで負荷分散＆速度向上 */
const POOLS = {
  stream:  [STREAM_PRIMARY],
  video:   ["https://yt.omada.cafe","https://inv.nadeko.net","https://invidious.nerdvpn.de","https://invidious.jing.rocks","https://yewtu.be"],
  search:  ["https://invidious.nerdvpn.de","https://inv.nadeko.net","https://invidious.privacyredirect.com","https://invidious.reallyaweso.me","https://iv.melmac.space"],
  trending:["https://invidious.jing.rocks","https://yewtu.be","https://inv.nadeko.net","https://invidious.materialio.us","https://invidious.privacyredirect.com"],
  comments:["https://yewtu.be","https://invidious.nerdvpn.de","https://iv.melmac.space","https://invidious.jing.rocks","https://inv.nadeko.net"],
  channel: ["https://inv.nadeko.net","https://invidious.nerdvpn.de","https://yewtu.be","https://invidious.jing.rocks","https://iv.melmac.space"],
};
const FALLBACK_ALL = [...new Set(Object.values(POOLS).flat())];

/* Piped API（検索のショート判定・チャンネル取得の補完に使用） */
const PIPED = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
  "https://pipedapi.reallyaweso.me",
  "https://pipedapi.drgns.space",
];

/* ---------------- storage ---------------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem("nkys_" + k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem("nkys_" + k, JSON.stringify(v)); } catch (_) {} },
};
const S = {
  settings: Object.assign({ proxy: false, adaptive: false, autoplay: true, quality: "auto", theme: "dark", playerMode: "stream" }, LS.get("settings", {})),
  subs: LS.get("subs", []),
  history: LS.get("history", []),
  searches: LS.get("searches", []),
  subsView: LS.get("subsView", "row"),
  shortsPlayer: LS.get("shortsPlayer", "nocookie"),
  liked: LS.get("liked", []),
  later: LS.get("later", []),
  playlists: LS.get("playlists", {}),
  health: LS.get("health", {}),
};
const saveSettings = () => LS.set("settings", S.settings);
document.documentElement.dataset.theme = S.settings.theme;

/* ---------------- utils ---------------- */
const $ = (s, r) => (r || document).querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("on"), 2200); }
function fmtDur(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
}
function fmtNum(n) {
  n = Number(n || 0);
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, "") + "億";
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, "") + "万";
  return n.toLocaleString("ja-JP");
}
function ago(ts) {
  if (!ts) return "";
  const d = Math.max(0, Date.now() / 1000 - ts);
  const u = [[31536000, "年"], [2592000, "か月"], [604800, "週間"], [86400, "日"], [3600, "時間"], [60, "分"]];
  for (const [s, l] of u) if (d >= s) return Math.floor(d / s) + l + "前";
  return "たった今";
}
const isAbort = (e) => e && (e.name === "AbortError" || /abort/i.test(e.message || ""));

/* ---------------- network core ---------------- */
let USE_PROXY = S.settings.proxy;
const px = (u) => (USE_PROXY ? "/px?u=" + encodeURIComponent(u) : u);

const hRec = (b) => (S.health[b] || (S.health[b] = { fail: 0, ms: 1200 }));
let hTimer;
function saveHealth() { clearTimeout(hTimer); hTimer = setTimeout(() => LS.set("health", S.health), 800); }
function ok(b, ms) { const r = hRec(b); r.fail = Math.max(0, r.fail - 1); r.ms = Math.round(r.ms * .7 + ms * .3); saveHealth(); }
function bad(b) { hRec(b).fail++; saveHealth(); }
const rank = (l) => l.slice().sort((a, b) => (hRec(a).fail * 3000 + hRec(a).ms) - (hRec(b).fail * 3000 + hRec(b).ms));

function fetchJson(base, path, signal, timeout) {
  const c = new AbortController();
  const onA = () => c.abort();
  if (signal) signal.addEventListener("abort", onA, { once: true });
  const t = setTimeout(() => c.abort(), timeout || 7000);
  const t0 = performance.now();
  return fetch(px(base + path), { headers: { Accept: "application/json" }, signal: c.signal })
    .then((r) => { if (!r.ok) throw new Error(r.status + " " + base); return r.json(); })
    .then((j) => { ok(base, performance.now() - t0); return j; })
    .catch((e) => { if (!isAbort(e)) bad(base); throw e; })
    .finally(() => { clearTimeout(t); if (signal) signal.removeEventListener("abort", onA); });
}

/* wave racing: 速いインスタンスから同時に投げ、失敗しても次の波で復旧 */
async function race(bases, path, signal, opt) {
  const o = opt || {}, wave = o.wave || 3, tos = o.timeouts || [4500, 7000, 10000];
  const list = rank(bases); const live = []; let last;
  for (let i = 0, w = 0; i < list.length; i += wave, w++) {
    if (signal && signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    for (const b of list.slice(i, i + wave)) live.push(fetchJson(b, path, signal, tos[Math.min(w, tos.length - 1)]));
    try { return await Promise.any(live); } catch (e) { last = e; }
  }
  throw last || new Error("no instance");
}

const cache = new Map(), TTL = 120000, inflight = new Map();
function api(role, path, opt) {
  const key = role + path;
  const c = cache.get(key);
  if (c && Date.now() - c.at < TTL) return Promise.resolve(c.v);
  if (inflight.has(key)) return inflight.get(key);
  const signal = (opt && opt.signal) || (nav.abort && nav.abort.signal);
  const bases = POOLS[role] || FALLBACK_ALL;
  const p = (async () => {
    try {
      const v = await race(bases, path, signal);
      cache.set(key, { v, at: Date.now() });
      return v;
    } catch (e) {
      if (isAbort(e)) throw e;
      const v = await race(FALLBACK_ALL, path, signal, { wave: 8, timeouts: [12000] }); // 全プール総当たり
      cache.set(key, { v, at: Date.now() });
      return v;
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ストリームは yt.omada.cafe を最優先。失敗時のみ他へフォールバック
   local=true を付けることで、omada.cafe 自身がストリーム URL を仲介する形になり、
   googlevideo 直リンクの CORS/帯域制限に左右されず確実に再生できる。 */
async function getVideo(id, signal) {
  const path = "/api/v1/videos/" + encodeURIComponent(id);
  let primary = null;
  try {
    primary = await fetchJson(STREAM_PRIMARY, path + "?local=true", signal, 6000);
    if (hasStreams(primary)) return primary;
  } catch (_) {}
  if (!primary) {
    try { primary = await fetchJson(STREAM_PRIMARY, path, signal, 5000); if (hasStreams(primary)) return primary; } catch (_) {}
  }
  const alt = await race(POOLS.video.filter((b) => b !== STREAM_PRIMARY), path, signal);
  if (primary && !hasStreams(alt)) return primary;
  if (primary) { alt.__metaOnly = false; }
  return alt || primary;
}
const hasStreams = (v) => !!(v && ((v.formatStreams && v.formatStreams.length) || (v.adaptiveFormats && v.adaptiveFormats.length) || v.hlsUrl));

/* ---------------- images ---------------- */
/* サムネは i.ytimg.com を直接使う（Invidious 経由より圧倒的に速い）。
   size: "m"=mqdefault(リスト/棚用・軽量) / "h"=hqdefault(グリッド用) */
function thumbUrl(v, size) {
  const id = v.videoId || v.id;
  if (id && /^[\w-]{11}$/.test(id)) {
    return "https://i.ytimg.com/vi/" + id + "/" + (size === "m" ? "mqdefault" : "hqdefault") + ".jpg";
  }
  const t = v.videoThumbnails || v.thumbnails;
  if (Array.isArray(t) && t.length) {
    const hit = t.find((x) => /maxres|high|medium/.test(x.quality || "")) || t[0];
    return abs(hit.url);
  }
  return "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg";
}
function shortThumbUrl(v) {
  const id = v.videoId || v.id;
  return id ? "https://i.ytimg.com/vi/" + id + "/hq720_2.jpg" : thumbUrl(v);
}
function authorImg(v) {
  const a = v.authorThumbnails;
  return a && a.length ? abs(a[a.length - 1].url) : "";
}
function abs(u) {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return STREAM_PRIMARY + u;
  return u;
}

/* ---------------- Piped ---------------- */
async function pipedGet(path, signal) {
  return race(PIPED, path, signal, { wave: 3, timeouts: [4500, 7000, 9000] });
}
const pipedId = (u) => {
  if (!u) return "";
  const m = String(u).match(/(?:v=|\/watch\?v=|\/shorts\/)([\w-]{11})/);
  return m ? m[1] : "";
};
const pipedChannelId = (u) => {
  const m = String(u || "").match(/channel\/([\w-]+)/);
  return m ? m[1] : "";
};
/* Piped の item を Invidious 形式へ正規化 */
function normPipedVideo(it) {
  return {
    type: "video",
    videoId: pipedId(it.url),
    title: it.title,
    author: it.uploaderName,
    authorId: pipedChannelId(it.uploaderUrl),
    authorThumbnails: it.uploaderAvatar ? [{ url: it.uploaderAvatar }] : [],
    lengthSeconds: it.duration > 0 ? it.duration : 0,
    viewCount: it.views > 0 ? it.views : 0,
    publishedText: it.uploadedDate || "",
    isShort: !!it.isShort || (it.duration > 0 && it.duration <= 180 && /shorts/i.test(it.url || "")),
    liveNow: !!it.isShort ? false : (it.duration <= 0 && it.views > 0),
  };
}
function normPipedChannel(it) {
  return {
    type: "channel",
    authorId: pipedChannelId(it.url),
    author: it.name,
    authorThumbnails: it.thumbnail ? [{ url: it.thumbnail }] : [],
    subCount: it.subscribers > 0 ? it.subscribers : 0,
    videoCount: it.videos > 0 ? it.videos : 0,
    description: it.description || "",
    authorVerified: !!it.verified,
  };
}
/* 動画IDを確実に取得する（Piped/Invidious/shorts URL いずれにも対応） */
function vidOf(v) {
  if (!v) return "";
  const cands = [v.videoId, v.id, v.url, v.videoUrl, v.link, v.href];
  for (const c of cands) {
    if (!c) continue;
    if (/^[\w-]{11}$/.test(c)) return c;
    const m = String(c).match(/(?:\/shorts\/|v=|\/watch\?v=|youtu\.be\/|\/embed\/)([\w-]{11})/);
    if (m) return m[1];
  }
  return "";
}
const isShortVid = (v) => !!v.isShort || (v.lengthSeconds > 0 && v.lengthSeconds <= 180);
/* ライブ判定: Invidious は liveNow / Piped は duration<=0 かつ views あり */
const isLive = (v) => !!(v && (v.liveNow || v.isLive || v.live || v.type === "livestream" ||
  (v.hlsUrl && !(v.lengthSeconds > 0)) || (v.lengthSeconds === 0 && v.publishedText === "LIVE")));

/* ---------------- router ---------------- */
const nav = { abort: null };
function go(path, replace) {
  if (replace) history.replaceState({}, "", path); else history.pushState({}, "", path);
  render();
}
addEventListener("popstate", render);
document.addEventListener("click", (e) => {
  const n = e.target.closest("[data-nav]");
  if (n) { e.preventDefault(); const t = n.dataset.nav; go(t === "home" ? "/" : "/" + t); }
});

const view = () => $("#view");
function setChips(items, active, onPick) {
  const c = $("#chips"); c.innerHTML = "";
  if (!items) { c.style.display = "none"; return; }
  c.style.display = "flex";
  items.forEach((it) => {
    const b = el("button", "chip" + (it === active ? " on" : ""), esc(it));
    b.onclick = () => onPick(it);
    c.appendChild(b);
  });
}
/* ゴーストスクリーン（横表示リスト / ショート棚 / チャンネル行） */
function ghostList(n) {
  const w = el("div", "ghost-list");
  for (let i = 0; i < (n || 8); i++) {
    const r = el("div", "ghost-row");
    r.innerHTML = '<div class="g-thumb skel"></div><div class="g-body">' +
      '<div class="g-line skel" style="width:80%"></div>' +
      '<div class="g-line skel" style="width:40%;height:12px"></div>' +
      '<div class="g-line skel" style="width:55%;height:12px"></div>' +
      '<div class="g-line skel" style="width:90%;height:12px"></div></div>';
    w.appendChild(r);
  }
  return w;
}
function ghostShelf(n) {
  const w = el("div", "ghost-shelf");
  for (let i = 0; i < (n || 8); i++) w.appendChild(el("div", "g-s skel"));
  return w;
}
function ghostChannels(n) {
  const w = el("div");
  for (let i = 0; i < (n || 2); i++) {
    const r = el("div", "ghost-ch");
    r.innerHTML = '<div class="g-av skel"></div><div style="flex:1"><div class="g-line skel" style="width:200px"></div>' +
      '<div class="g-line skel" style="width:120px;height:12px"></div></div>';
    w.appendChild(r);
  }
  return w;
}
function ghostRelated(n) {
  const w = el("div", "ghost-rel");
  for (let i = 0; i < (n || 12); i++) {
    const r = el("div", "gr-row");
    r.innerHTML = '<div class="gr-thumb skel"></div><div class="gr-body">' +
      '<div class="gr-line skel" style="width:95%"></div>' +
      '<div class="gr-line skel" style="width:55%;height:12px"></div>' +
      '<div class="gr-line skel" style="width:40%;height:12px"></div></div>';
    w.appendChild(r);
  }
  return w;
}
function ghostHomeShorts(n) {
  const w = el("div", "ghost-short-shelf");
  for (let i = 0; i < (n || 8); i++) w.appendChild(el("div", "ghost-short skel"));
  return w;
}
function ghostHomeVideos(n, grid) {
  const w = el("div", grid ? "ghost-grid" : "ghost-video-shelf");
  for (let i = 0; i < (n || 8); i++) {
    const c = el("div", (grid ? "ghost-grid-card " : "") + "ghost-video-card");
    c.innerHTML = '<div class="ghost-video-thumb skel"></div><div class="ghost-video-meta">' +
      '<div class="ghost-avatar skel"></div><div class="ghost-copy">' +
      '<div class="ghost-line skel" style="width:94%"></div>' +
      '<div class="ghost-line skel" style="width:62%;height:12px"></div>' +
      '<div class="ghost-line skel" style="width:48%;height:12px"></div></div></div>';
    w.appendChild(c);
  }
  return w;
}
function loading(n) {

  const g = el("div", "grid");
  for (let i = 0; i < (n || 12); i++) {
    const c = el("div", "card");
    c.innerHTML = '<div class="thumb skel"></div><div class="meta"><div class="skel" style="width:36px;height:36px;border-radius:50%"></div>' +
      '<div style="flex:1"><div class="skel" style="height:14px;margin-bottom:8px"></div><div class="skel" style="height:12px;width:60%"></div></div></div>';
    g.appendChild(c);
  }
  view().innerHTML = ""; view().appendChild(g);
}

/* ---------------- cards ---------------- */
function videoCard(v, mode) {
  const id = v.videoId || v.id;
  const card = el("div", (mode === "list" ? "list-item" : mode === "rel" ? "rel-item" : "card"));
  const live = isLive(v);
  const dur = live ? '<span class="dur live">ライブ</span>'
    : (v.lengthSeconds ? '<span class="dur">' + fmtDur(v.lengthSeconds) + "</span>" : "");
  const av = mode ? "" : '<img loading="lazy" decoding="async" width="36" height="36" src="' + esc(authorImg(v) || "https://i.ytimg.com/vi/" + id + "/default.jpg") + '" alt="">';
  card.innerHTML =
    '<div class="thumb"><img loading="lazy" decoding="async" width="480" height="270" src="' +
      esc(thumbUrl(v, mode ? "m" : "h")) + '" alt="">' + dur + "</div>" +
    '<div class="meta">' + av + "<div style=\"min-width:0\">" +
      '<div class="mtitle">' + esc(v.title) + "</div>" +
      '<div class="msub">' + esc(v.author || "") + "</div>" +
      '<div class="msub">' + (v.viewCount ? fmtNum(v.viewCount) + "回視聴・" : "") + esc(v.publishedText || ago(v.published)) + "</div>" +
    "</div></div>";
  card.onclick = () => go("/watch?v=" + id);
  return card;
}
function renderGrid(list, mode) {
  const wrap = el("div", mode === "list" ? "" : "grid");
  (list || []).filter((v) => (v.type ? v.type === "video" || v.type === "shortVideo" : true) && (v.videoId || v.id))
    .forEach((v) => wrap.appendChild(videoCard(v, mode)));
  if (!wrap.children.length) wrap.appendChild(el("div", "empty", "結果が見つかりませんでした"));
  return wrap;
}

/* ---------------- pages ---------------- */
const HOME_CHIPS = ["すべて", "音楽", "ゲーム", "ニュース", "ライブ", "アニメ", "スポーツ", "料理", "学習", "テクノロジー", "コメディ"];
let homeChip = "すべて";

/* Home: Piped と Invidious を同時取得し、片方の障害でも表示を継続 */
async function homeFeed(chip, signal) {
  const q = chip === "すべて" ? "" : chip;
  const invPath = q
    ? "/api/v1/search?q=" + encodeURIComponent(q) + "&type=video&region=JP&sort_by=relevance"
    : "/api/v1/trending?region=JP";
  const pipedPath = q
    ? "/search?q=" + encodeURIComponent(q) + "&filter=videos"
    : "/trending?region=JP";
  const [invResult, pipedResult] = await Promise.allSettled([
    api(q ? "search" : "trending", invPath, { signal }),
    pipedGet(pipedPath, signal),
  ]);
  if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
  const merged = [];
  const seen = new Set();
  const add = (v) => {
    const id = vidOf(v);
    if (!id || seen.has(id)) return;
    seen.add(id); merged.push(v);
  };
  if (invResult.status === "fulfilled") (invResult.value || []).filter((v) => v.type === "video" || v.type === "shortVideo" || v.videoId).forEach(add);
  if (pipedResult.status === "fulfilled") {
    const items = Array.isArray(pipedResult.value) ? pipedResult.value : (pipedResult.value?.items || []);
    items.filter((v) => v.type === "stream" || v.videoId || v.url).map((v) => v.videoId ? v : normPipedVideo(v)).forEach(add);
  }
  if (!merged.length) throw new Error("Home feed unavailable");
  return merged;
}

async function pageHome() {

  setChips(HOME_CHIPS, homeChip, (c) => { homeChip = c; pageHome(); });
  const root = view();
    root.innerHTML = "";
  const shortSec = el("section", "home-section home-ghost");
  shortSec.innerHTML = '<div class="home-section-head"><h2>Short</h2></div>';
  const shortShelf = el("div", "shelf-scroll");
  shortShelf.setAttribute("aria-busy", "true");
  shortShelf.appendChild(ghostHomeShorts(8));
  shortSec.appendChild(shortShelf);

  root.appendChild(shortSec);

    const recSec = el("section", "home-section home-ghost");
  recSec.innerHTML = '<div class="home-section-head"><h2>おすすめ</h2></div>';
  const recShelf = el("div", "home-video-shelf");
  recShelf.setAttribute("aria-busy", "true");
  recShelf.appendChild(ghostHomeVideos(5, false));
  recSec.appendChild(recShelf);

  root.appendChild(recSec);

    const normalSec = el("section", "home-section home-ghost");
  normalSec.innerHTML = '<div class="home-section-head"><h2>動画</h2></div>';
  const normalBox = el("div", "grid");
  normalBox.setAttribute("aria-busy", "true");
  normalBox.appendChild(ghostHomeVideos(8, true));
  normalSec.appendChild(normalBox);

  root.appendChild(normalSec);

  const signal = nav.abort.signal;
  const shortsPromise = fetchShorts(["#shorts", "shorts 音楽", "shorts ゲーム"], signal);
  const trendPromise = homeFeed(homeChip, signal);

  shortsPromise.then((items) => {
    if (signal.aborted) return;
        shortShelf.innerHTML = "";
    shortShelf.removeAttribute("aria-busy");
    (items || []).slice(0, 12).forEach((v) => shortShelf.appendChild(shortCard(v)));

    if (!shortShelf.children.length) shortSec.remove();
  }).catch(() => shortSec.remove());

  trendPromise.then((data) => {
    if (signal.aborted) return;
    const videos = (data || []).filter((v) => (v.type ? v.type === "video" || v.type === "shortVideo" : true) && (v.videoId || v.id));
        recShelf.innerHTML = "";
    recShelf.removeAttribute("aria-busy");
    (videos || []).slice(0, 10).forEach((v) => recShelf.appendChild(videoCard(v)));

    if (!recShelf.children.length) recSec.remove();
        normalBox.innerHTML = "";
    normalBox.removeAttribute("aria-busy");
    videos.slice(10).forEach((v) => normalBox.appendChild(videoCard(v)));

    if (!normalBox.children.length) normalBox.appendChild(el("div", "empty", "動画が見つかりませんでした"));
  }).catch((e) => {
    if (!isAbort(e) && !signal.aborted) {
            recSec.remove();
      normalBox.removeAttribute("aria-busy");
      normalBox.innerHTML = '<div class="empty">読み込みに失敗しました。再試行してください。</div>';

    }
  });
}

/* ---- search: 動画 + チャンネル + ショート棚 + ページネーション ---- */
function channelCard(c) {
  const id = c.authorId || c.channelId;
  const img = abs((c.authorThumbnails || []).slice(-1)[0]?.url || "");
  const row = el("div", "ch-result");
  const ver = c.authorVerified
    ? '<svg viewBox="0 0 24 24"><path d="M12 2l2.4 1.8 3-.3.9 2.9 2.7 1.4-1 2.9 1 2.9-2.7 1.4-.9 2.9-3-.3L12 22l-2.4-1.8-3 .3-.9-2.9L3 16.2l1-2.9-1-2.9 2.7-1.4.9-2.9 3 .3L12 2zm-1 13.2l5-5-1.2-1.2-3.8 3.8-1.9-1.9L7.9 12l3.1 3.2z"/></svg>' : "";
  row.innerHTML =
    '<img loading="lazy" decoding="async" width="88" height="88" src="' + esc(img) + '" alt="">' +
    '<div class="cr-body">' +
      '<div class="cr-name">' + esc(c.author) + ver + "</div>" +
      '<div class="cr-sub">' + (c.subCount ? fmtNum(c.subCount) + "人の登録者" : "") +
        (c.videoCount ? "・" + fmtNum(c.videoCount) + "本の動画" : "") + "</div>" +
      '<div class="cr-desc">' + esc(c.description || c.descriptionHtml || "") + "</div>" +
    "</div>" +
    '<button class="pill solid" data-sub="' + esc(id) + '">チャンネル登録</button>';
  row.onclick = (e) => {
    if (e.target.closest("[data-sub]")) {
      e.stopPropagation();
      if (!S.subs.some((x) => x.id === id)) { S.subs.push({ id, name: c.author, img }); LS.set("subs", S.subs); renderSubs(); toast("チャンネル登録しました"); }
      return;
    }
    go("/channel?c=" + id);
  };
  return row;
}
function shortCard(v) {
  const id = vidOf(v);
  const c = el("div", "short-card");
  c.innerHTML =
    '<div class="sc-thumb"><img loading="lazy" decoding="async" width="320" height="568" src="' + esc(shortThumbUrl(v)) +
      '" onerror="this.src=\'' + esc(thumbUrl(v, "m")) + '\'" alt=""></div>' +
    '<div class="sc-title">' + esc(v.title) + "</div>" +
    '<div class="sc-views">' + (v.viewCount ? fmtNum(v.viewCount) + "回視聴" : esc(v.publishedText || "")) + "</div>";
  c.onclick = () => go("/short/" + id);
  return c;
}
function shortsShelf(list, query) {
  const box = el("div", "shelf");
  const head = el("div", "shelf-head");
  head.innerHTML = '<svg viewBox="0 0 24 24"><path fill="var(--brand)" d="M17.77 10.32l-1.2-.5L18 9.06a4.13 4.13 0 001.56-5.6 4.1 4.1 0 00-5.55-1.62L5.1 6.5A4.13 4.13 0 003.5 12a4.1 4.1 0 002.28 1.96l.94.4-1.44.75a4.13 4.13 0 00-1.56 5.6 4.1 4.1 0 005.55 1.62l8.91-4.66a4.13 4.13 0 001.6-5.5 4.1 4.1 0 00-2.01-1.85z"/><path fill="#fff" d="M10 8.4l6.06 3.6L10 15.6V8.4z"/></svg><span>ショート</span>';
  const scr = el("div", "shelf-scroll");
  const seen = new Set();
  const add = (arr) => arr.forEach((v) => {
    const id = vidOf(v);
    if (!id || seen.has(id)) return;
    seen.add(id);
    scr.appendChild(shortCard(v));
  });
  add(list || []);
  box.appendChild(head); box.appendChild(scr);

  /* 横スクロールすると更にショートを読み込む */
  if (query) {
    const more = el("div", "shelf-more", "読み込み中…");
    scr.appendChild(more);
    let page = 2, busy = false, done = false;
    const loadMore = async () => {
      if (busy || done) return;
      busy = true;
      try {
        const nxt = await searchShorts(query, nav.abort && nav.abort.signal, page++);
        const fresh = (nxt || []).filter((v) => !seen.has(vidOf(v)));
        if (!fresh.length) { done = true; more.textContent = "以上"; }
        else { scr.removeChild(more); add(fresh); scr.appendChild(more); }
      } catch (_) { more.textContent = "再試行"; }
      finally { busy = false; }
    };
    scr.addEventListener("scroll", () => {
      if (scr.scrollLeft + scr.clientWidth > scr.scrollWidth - 600) loadMore();
    }, { passive: true });
    more.onclick = loadMore;
    setTimeout(() => { if (scr.scrollWidth <= scr.clientWidth + 40) loadMore(); }, 400);
  }
  return box;
}

async function searchVideos(q, page, signal) {
  const path = "/api/v1/search?q=" + encodeURIComponent(q) + "&type=video&region=JP&page=" + page;
  try {
    const d = await api("search", path, { signal });
    if (Array.isArray(d) && d.length) return d;
  } catch (e) { if (isAbort(e)) throw e; }
  const d2 = await pipedGet("/search?q=" + encodeURIComponent(q) + "&filter=videos", signal);
  return (d2.items || []).map(normPipedVideo).filter((v) => v.videoId);
}
async function searchChannels(q, signal) {
  try {
    const d = await pipedGet("/search?q=" + encodeURIComponent(q) + "&filter=channels", signal);
    const list = (d.items || []).map(normPipedChannel).filter((c) => c.authorId);
    if (list.length) return list;
  } catch (e) { if (isAbort(e)) throw e; }
  try {
    const d = await api("search", "/api/v1/search?q=" + encodeURIComponent(q) + "&type=channel", { signal });
    return (d || []).filter((c) => c.authorId);
  } catch (_) { return []; }
}
/* ショート検索: 複数ソース + 複数ページを合成して表示量を大幅に増やす */
async function searchShorts(q, signal, page) {
  page = page || 1;
  const out = [], seen = new Set();
  const push = (v) => {
    const id = vidOf(v);
    if (!id || seen.has(id)) return;
    seen.add(id); v.videoId = id; out.push(v);
  };
  const jobs = [
    pipedGet("/search?q=" + encodeURIComponent(q + " shorts") + "&filter=all", signal)
      .then((d) => (d.items || []).filter((i) => i.type === "stream").map(normPipedVideo).filter(isShortVid).forEach(push))
      .catch(() => {}),
    api("search", "/api/v1/search?q=" + encodeURIComponent(q + " #shorts") + "&type=video&region=JP&page=" + page, { signal })
      .then((d) => (d || []).filter(isShortVid).forEach(push)).catch(() => {}),
    api("search", "/api/v1/search?q=" + encodeURIComponent(q + " shorts") + "&type=video&region=JP&page=" + (page + 1), { signal })
      .then((d) => (d || []).filter(isShortVid).forEach(push)).catch(() => {}),
  ];
  await Promise.allSettled(jobs);
  return out;
}

let searchMore = null;
async function pageSearch(q, page) {
  setChips(null);
  $("#q").value = q;
  page = Math.max(1, parseInt(page, 10) || 1);
  const signal = nav.abort.signal;

  /* ゴーストスクリーンを即表示（体感速度優先） */
  const v0 = view();
  v0.innerHTML = "";
  const gShelf = el("div", "shelf");
  gShelf.appendChild(ghostShelf(8));
  const gCh = ghostChannels(2);
  const gList = ghostList(8);
  if (page === 1) { v0.appendChild(gShelf); v0.appendChild(gCh); }
  v0.appendChild(gList);

  /* 3系統を同時に投げて、返ってきた順に差し込む（最速表示） */
  const pVideos = searchVideos(q, page, signal);
  const pChannels = page === 1 ? searchChannels(q, signal) : Promise.resolve([]);
  const pShorts = page === 1 ? searchShorts(q, signal) : Promise.resolve([]);

  let videos;
  try { videos = await pVideos; }
  catch (e) {
    if (isAbort(e)) return;
    v0.innerHTML = '<div class="empty">検索に失敗しました。</div>';
    return;
  }
  if (signal.aborted) return;

  v0.innerHTML = "";
  const shelfSlot = el("div"), chSlot = el("div");
  if (page === 1) { v0.appendChild(shelfSlot); v0.appendChild(chSlot); }
  const listBox = el("div");
  videos.forEach((v) => listBox.appendChild(videoCard(v, "list")));
  if (!videos.length) listBox.appendChild(el("div", "empty", "結果が見つかりませんでした"));
  v0.appendChild(listBox);

  /* ページネーション: 下端で自動追加 + ボタンで ?page=N */
  const pager = el("div", "pager");
  const sentinel = el("div"); sentinel.id = "sentinel";
  const btnNext = el("button", "pill solid", "次のページ (" + (page + 1) + ") を表示");
  pager.appendChild(btnNext);
  v0.appendChild(sentinel);
  v0.appendChild(pager);

  let cur = page, busy = false, done = false;
  async function loadNext(navigate) {
    if (busy || done) return;
    busy = true;
    const g = ghostList(4); listBox.appendChild(g);
    try {
      const more = await searchVideos(q, cur + 1, signal);
      g.remove();
      if (!more.length) { done = true; btnNext.textContent = "これ以上の結果はありません"; btnNext.disabled = true; return; }
      cur++;
      more.forEach((v) => listBox.appendChild(videoCard(v, "list")));
      btnNext.textContent = "次のページ (" + (cur + 1) + ") を表示";
      if (navigate) history.replaceState({}, "", "/results?q=" + encodeURIComponent(q) + "&page=" + cur);
    } catch (e) { g.remove(); if (!isAbort(e)) toast("次のページを取得できませんでした"); }
    finally { busy = false; }
  }
  searchMore = loadNext;
  btnNext.onclick = () => go("/results?q=" + encodeURIComponent(q) + "&page=" + (cur + 1));
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadNext(true); }, { rootMargin: "600px" });
  io.observe(sentinel);
  signal.addEventListener("abort", () => io.disconnect(), { once: true });

  /* 遅れて届いたショート / チャンネルを差し込む */
  pShorts.then((sh) => { if (!signal.aborted && sh.length) shelfSlot.replaceWith(shortsShelf(sh, q)); else shelfSlot.remove(); }).catch(() => shelfSlot.remove());
  pChannels.then((ch) => {
    if (signal.aborted) return;
    if (!ch.length) return chSlot.remove();
    const wrap = el("div");
    ch.slice(0, 3).forEach((c) => wrap.appendChild(channelCard(c)));
    chSlot.replaceWith(wrap);
  }).catch(() => chSlot.remove());
}

/* ---- watch ---- */
let hls = null;
async function pageWatch(id) {
  setChips(null);
  if (!id) { view().innerHTML = '<div class="empty">動画が見つかりません</div>'; return; }

  /* 通信は即座に開始し、表示は後回しにしない（体感速度優先） */
  const dataPromise = getVideo(id, nav.abort.signal);
  const guessThumb = "https://i.ytimg.com/vi/" + encodeURIComponent(id) + "/hqdefault.jpg";
  const mode0 = S.settings.playerMode === "nocookie" ? "nocookie" : "stream";

  const wrap = el("div", "watch");
  wrap.innerHTML = `
    <div>
      <div id="playerWrap"></div>
      <h1 id="vtitle" class="skel" style="height:24px;width:70%;margin:12px 0 0;border-radius:6px"></h1>
      <div class="owner">
        <div class="skel" style="width:40px;height:40px;border-radius:50%"></div>
        <div style="flex:1"><div class="skel" style="height:14px;width:140px;margin-bottom:6px"></div><div class="skel" style="height:12px;width:90px"></div></div>
        <div class="actions">
          <div class="modegroup" id="modeGroup">
            <button class="pill" id="btnModeStream" title="独自プレーヤーで再生（高画質選択可）">ストリーム</button>
            <button class="pill" id="btnModeNocookie" title="YouTube (nocookie) 埋め込みで再生">Nocookie</button>
          </div>
          <select class="pill" id="qsel" title="画質" style="padding:0 10px"></select>
          <button class="pill" id="btnTheater" title="シアターモード">▭</button>
          <button class="pill" id="btnPip" title="ミニプレーヤー">⧉</button>
        </div>
      </div>
      <div id="desc" class="skel" style="height:60px;margin-top:16px"></div>
      <div class="sechead" id="commentHead"><span>コメント</span></div>
      <div id="comments"><div class="spinner"></div></div>
    </div>
    <aside id="side"></aside>`;
  view().innerHTML = ""; view().appendChild(wrap);
  $("#side").appendChild(ghostRelated(12));

  /* まずポスター画像だけ即表示し、体感の読み込み速度を上げる */
  mountPlayer(mode0, { poster: guessThumb });

  let v;
  try { v = await dataPromise; }
  catch (e) {
    if (!isAbort(e)) $("#playerWrap").innerHTML = '<div class="empty" style="color:#fff">動画を読み込めませんでした。</div>';
    return;
  }
  if (nav.abort.signal.aborted) return;

  const streams = pickStreams(v);
  const subbed = S.subs.some((s) => s.id === v.authorId);

  $("#vtitle").outerHTML = `<h1 id="vtitle">${esc(v.title)}${isLive(v) ? '<span class="livechip">ライブ</span>' : ""}</h1>`;
  $(".owner").innerHTML = `
    <img src="${esc(authorImg(v))}" alt="">
    <div>
      <div class="oname" id="goCh">${esc(v.author || "")}</div>
      <div class="osub">${fmtNum(v.subCountText ? 0 : v.subCount || 0)}${v.subCount ? "人の登録者" : ""}</div>
    </div>
    <button class="pill ${subbed ? "" : "solid"}" id="btnSub">${subbed ? "登録済み" : "チャンネル登録"}</button>
    <div class="actions">
      <div class="pillgroup">
        <button class="pill" id="btnLike"><svg viewBox="0 0 24 24"><path d="M18.8 9H14V4.6L11 12v8h7l3-8.6zM3 12h4v8H3z"/></svg>${fmtNum(v.likeCount || 0)}</button>
        <div class="sep"></div>
        <button class="pill"><svg viewBox="0 0 24 24" style="transform:rotate(180deg)"><path d="M18.8 9H14V4.6L11 12v8h7l3-8.6zM3 12h4v8H3z"/></svg></button>
      </div>
      <button class="pill" id="btnShare"><svg viewBox="0 0 24 24"><path d="M15 5.6L16.4 4 22 9.6 16.4 15 15 13.5l3-3H12a7 7 0 00-7 7v1H3v-1a9 9 0 019-9h6z"/></svg>共有</button>
      <button class="pill" id="btnLater"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 100 18 9 9 0 000-18zm.5 5H11v6l4.7 2.9.8-1.3-4-2.4z"/></svg>後で見る</button>
      <button class="pill" id="btnSave">保存</button>
      <div class="modegroup" id="modeGroup">
        <button class="pill" id="btnModeStream" title="独自プレーヤーで再生（高画質選択可）">ストリーム</button>
        <button class="pill" id="btnModeNocookie" title="YouTube (nocookie) 埋め込みで再生">Nocookie</button>
      </div>
      <select class="pill" id="qsel" title="画質" style="padding:0 10px"></select>
      <button class="pill" id="btnTheater" title="シアターモード">▭</button>
      <button class="pill" id="btnPip" title="ミニプレーヤー">⧉</button>
    </div>`;
  $("#desc").outerHTML = `<div id="desc"><b>${fmtNum(v.viewCount)}回視聴・${esc(v.publishedText || ago(v.published))}</b><div class="desc-body">${esc(v.description || "")}</div><button type="button" class="desc-more" aria-expanded="false">もっと見る</button></div>`;
  $("#commentHead").innerHTML = `<span>${fmtNum(v.commentCount || 0)} 件のコメント</span>`;

  window.__nkysStreams = streams;
  window.__nkysVideo = v;
  const qsel = $("#qsel");
  streams.forEach((s, i) => qsel.appendChild(new Option(s.label, i)));
  if (!streams.length) qsel.appendChild(new Option("再生不可", 0));
  else {
    let start = 0;
    const pref = S.settings.quality;
    if (pref !== "auto") { const i = streams.findIndex((s) => s.label.startsWith(pref)); if (i >= 0) start = i; }
    else if (S.settings.adaptive) { const i = streams.findIndex((s) => s.adaptive); if (i >= 0) start = i; }
    qsel.value = String(start);
  }

  /* 現在のモードでプレーヤーを本再生に切り替え */
  const curMode = $("#playerWrap").dataset.mode || mode0;
  mountPlayer(curMode, { id, v, streams, autoFallbackTried: false });
  wireModeToggle(id, v);

  addHistory(v);
  $("#desc .desc-more").onclick = (e) => {
    e.stopPropagation();
    const box = $("#desc"), opened = box.classList.toggle("open");
    e.currentTarget.textContent = opened ? "表示を減らす" : "もっと見る";
    e.currentTarget.setAttribute("aria-expanded", String(opened));
  };
  $("#goCh").onclick = () => v.authorId && go("/channel?c=" + v.authorId);
  $("#btnSub").onclick = () => {
    const i = S.subs.findIndex((s) => s.id === v.authorId);
    if (i >= 0) S.subs.splice(i, 1); else S.subs.push({ id: v.authorId, name: v.author, img: authorImg(v) });
    LS.set("subs", S.subs); renderSubs();
    $("#btnSub").textContent = i >= 0 ? "チャンネル登録" : "登録済み";
    $("#btnSub").classList.toggle("solid", i >= 0);
  };
  $("#btnLike").onclick = () => { toggleList("liked", v); toast("高く評価した動画を更新しました"); };
  $("#btnLater").onclick = () => { toggleList("later", v); toast("後で見るを更新しました"); };
  $("#btnShare").onclick = async () => {
    const url = location.origin + "/watch?v=" + id;
    if (navigator.share) { try { await navigator.share({ title: v.title, url }); return; } catch (_) {} }
    navigator.clipboard.writeText(url); toast("リンクをコピーしました");
  };
  $("#btnSave").onclick = () => savePlaylistPrompt(v);
  $("#btnTheater").onclick = () => {
    const on = !document.body.classList.contains("theater");
    document.body.classList.toggle("theater", on);
    $("#playerWrap").classList.toggle("theater", on);
    $("#main").classList.toggle("wide", on);
    $("#sidebar").classList.toggle("mini", on);
    $("#btnTheater").classList.toggle("on", on);
    toast(on ? "シアターモード" : "通常表示");
  };
  $("#btnPip").onclick = () => {
    const vp = $("#vp");
    if (vp && vp.requestPictureInPicture) vp.requestPictureInPicture().catch(() => {});
    else toast("Nocookie 再生中はミニプレーヤーを利用できません");
  };

  loadSide(v);
  loadComments(id);
}

/* プレーヤーの描画: mode = "stream"(独自プレーヤー) | "nocookie"(YouTube nocookie 埋め込み)
   opt.poster だけの初期呼び出し（データ未取得時）にも対応 */
function mountPlayer(mode, opt) {
  opt = opt || {};
  const box = $("#playerWrap");
  box.dataset.mode = mode;
  box.innerHTML = "";
  if (mode === "nocookie" && opt.id) {
    document.onkeydown = null;
    const f = el("iframe");
    f.id = "ytFrame"; f.allowFullscreen = true;
    f.allow = "autoplay; encrypted-media; picture-in-picture";
    f.referrerPolicy = "strict-origin-when-cross-origin";
    f.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(opt.id) +
      "?autoplay=" + (S.settings.autoplay ? 1 : 0) + "&rel=0&modestbranding=1";
    box.appendChild(f);
    return;
  }
  const vp = el("video");
  vp.id = "vp"; vp.controls = true; vp.playsInline = true; vp.preload = "auto";
  if (S.settings.autoplay) vp.autoplay = true;
  if (opt.poster) vp.poster = opt.poster;
  box.appendChild(vp);
  if (opt.streams && opt.streams.length) {
    let start = 0;
    const sel = $("#qsel");
    if (sel && sel.value) start = +sel.value;
    setSrc(vp, opt.streams[start]);
    vp.addEventListener("error", () => {
      if (opt.autoFallbackTried) return;
      opt.autoFallbackTried = true;
      toast("ストリーム再生に失敗したため Nocookie 再生に切り替えました");
      $("#btnModeNocookie") && $("#btnModeNocookie").click();
    }, { once: true });
  } else if (opt.v) {
    box.insertAdjacentHTML("beforeend",
      '<div class="empty" style="position:absolute;inset:0;display:grid;place-items:center;color:#fff">ストリームを取得できませんでした</div>');
  }
  vp.addEventListener("ended", () => {
    if (playlistNext()) return;
    const n = $("#side .rel-item"); if (S.settings.autoplay && n) n.click();
  });
  keyBindings(vp);
}

function wireModeToggle(id, v) {
  const bS = $("#btnModeStream"), bN = $("#btnModeNocookie"), qsel = $("#qsel");
  const sync = () => {
    const m = $("#playerWrap").dataset.mode;
    bS.classList.toggle("on", m !== "nocookie");
    bN.classList.toggle("on", m === "nocookie");
    if (qsel) qsel.style.display = m === "nocookie" ? "none" : "";
  };
  bS.onclick = () => {
    S.settings.playerMode = "stream"; saveSettings();
    mountPlayer("stream", { id, v, streams: window.__nkysStreams, autoFallbackTried: false });
    sync();
  };
  bN.onclick = () => {
    S.settings.playerMode = "nocookie"; saveSettings();
    mountPlayer("nocookie", { id, v });
    sync();
  };
  qsel && (qsel.onchange = () => {
    const vp = $("#vp"); if (!vp) return;
    const t = vp.currentTime, p = !vp.paused;
    setSrc(vp, window.__nkysStreams[+qsel.value]); vp.currentTime = t; if (p) vp.play();
  });
  sync();
}

function setSrc(vp, s) {
  if (!s) return;
  vp.src = USE_PROXY ? "/px?u=" + encodeURIComponent(s.url) : s.url;
  vp.load();
  if (S.settings.autoplay) vp.play().catch(() => {});
}
function pickStreams(v) {
  const out = [];
  (v.formatStreams || []).forEach((f) => {
    if (!f.url) return;
    out.push({ url: abs(f.url), label: (f.qualityLabel || f.quality || "auto") + " (音声込)", h: parseInt(f.qualityLabel) || 0, adaptive: false });
  });
  if (S.settings.adaptive) {
    (v.adaptiveFormats || []).filter((f) => f.url && /video\/mp4/.test(f.type || "") && f.qualityLabel).forEach((f) => {
      out.push({ url: abs(f.url), label: f.qualityLabel + " (映像のみ)", h: parseInt(f.qualityLabel) || 0, adaptive: true });
    });
  }
  if (v.hlsUrl) out.unshift({ url: abs(v.hlsUrl), label: "LIVE (HLS)", h: 9999, adaptive: true });
  out.sort((a, b) => b.h - a.h);
  return out;
}

async function loadSide(v) {
  const side = $("#side");
  let rec = v.recommendedVideos || [];
  if (!rec.length) {
    try { rec = await api("search", "/api/v1/search?q=" + encodeURIComponent(v.title.slice(0, 60)) + "&type=video"); } catch (_) {}
  }
  side.innerHTML = "";
  (rec || []).slice(0, 30).forEach((r) => side.appendChild(videoCard(r, "rel")));
  renderPlaylistPanel(side, v.videoId || v.id);
}

async function loadComments(id) {
  const box = $("#comments");
  try {
    const d = await api("comments", "/api/v1/comments/" + id + "?sort_by=top");
    box.innerHTML = "";
    (d.comments || []).slice(0, 50).forEach((c) => {
      const n = el("div", "comment");
      n.innerHTML = '<img loading="lazy" src="' + esc(abs((c.authorThumbnails || []).slice(-1)[0]?.url)) + '" alt="">' +
        '<div><div class="cname">' + esc(c.author) + " <span class=\"badge\">" + esc(c.publishedText || "") + "</span></div>" +
        '<div class="ctext">' + esc(c.content) + "</div>" +
        '<div class="clike">👍 ' + fmtNum(c.likeCount || 0) + "</div></div>";
      box.appendChild(n);
    });
    if (!box.children.length) box.innerHTML = '<div class="empty">コメントはありません</div>';
  } catch (_) { box.innerHTML = '<div class="empty">コメントを取得できませんでした</div>'; }
}

function keyBindings(vp) {
  document.onkeydown = (e) => {
    if (/input|textarea|select/i.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === " " || k === "k") { e.preventDefault(); vp.paused ? vp.play() : vp.pause(); }
    else if (k === "arrowright" || k === "l") vp.currentTime += k === "l" ? 10 : 5;
    else if (k === "arrowleft" || k === "j") vp.currentTime -= k === "j" ? 10 : 5;
    else if (k === "arrowup") { e.preventDefault(); vp.volume = Math.min(1, vp.volume + .1); }
    else if (k === "arrowdown") { e.preventDefault(); vp.volume = Math.max(0, vp.volume - .1); }
    else if (k === "m") vp.muted = !vp.muted;
    else if (k === "f") document.fullscreenElement ? document.exitFullscreen() : $("#playerWrap").requestFullscreen();
    else if (k === "t") $("#btnTheater")?.click();
    else if (k === "i") $("#btnPip")?.click();
    else if (k === ">") vp.playbackRate = Math.min(2, vp.playbackRate + .25);
    else if (k === "<") vp.playbackRate = Math.max(.25, vp.playbackRate - .25);
    else if (k === "escape" && document.body.classList.contains("theater")) $("#btnTheater")?.click();
    else if (/^[0-9]$/.test(k) && vp.duration) vp.currentTime = vp.duration * (+k / 10);
  };
}

/* ---- channel ---- */
/* チャンネルのショートを確実に取得（Invidious /shorts → Piped → 動画から短尺抽出） */
async function fetchChannelShorts(cid, fallbackVideos, signal) {
  const out = [], seen = new Set();
  const push = (v) => {
    const id = vidOf(v);
    if (!id || seen.has(id)) return;
    seen.add(id); v.videoId = id; v.isShort = true; out.push(v);
  };
  try {
    const d = await api("channel", "/api/v1/channels/" + cid + "/shorts", { signal });
    (d.videos || d || []).forEach(push);
  } catch (_) {}
  if (!out.length) {
    try {
      const d = await pipedGet("/channels/tabs?data=" + encodeURIComponent(JSON.stringify({ id: cid, tab: "shorts" })), signal);
      (d.content || []).map(normPipedVideo).forEach(push);
    } catch (_) {}
  }
  if (!out.length) (fallbackVideos || []).filter((x) => (x.lengthSeconds || 0) > 0 && x.lengthSeconds <= 180).forEach(push);
  return out;
}

async function pageChannel(cid) {
  setChips(null);
  view().innerHTML = '<div class="spinner"></div>';
  let ch, vidsRaw;
  try {
    [ch, vidsRaw] = await Promise.all([
      api("channel", "/api/v1/channels/" + cid),
      api("channel", "/api/v1/channels/" + cid + "/videos").catch(() => []),
    ]);
  } catch (e) { if (!isAbort(e)) view().innerHTML = '<div class="empty">チャンネルを取得できませんでした</div>'; return; }

  const subbed = S.subs.some((s) => s.id === cid);
  const avatar = abs((ch.authorThumbnails || []).slice(-1)[0]?.url);
  const banner = ch.authorBanners?.length ? abs(ch.authorBanners[0].url) : "";
  const allVideos = vidsRaw.videos || vidsRaw || ch.latestVideos || [];
  const handle = ch.authorHandle || (ch.author ? "@" + String(ch.author).replace(/\s+/g, "") : "");
  const chUrl = "youtube.com/channel/" + cid;
  const verifiedIcon = ch.authorVerified
    ? '<svg viewBox="0 0 24 24"><path d="M12 1l2.6 2.2 3.4-.4 1 3.3 3 1.7-1 3.4 1 3.4-3 1.7-1 3.3-3.4-.4L12 23l-2.6-2.2-3.4.4-1-3.3-3-1.7 1-3.4-1-3.4 3-1.7 1-3.3 3.4.4z"/></svg>'
    : "";

  view().innerHTML = "";
  const head = el("div");
  head.innerHTML =
    (banner ? '<img class="chBanner" src="' + esc(banner) + '" alt="">' : '<div class="chBanner"></div>') +
    '<div class="chHead">' +
      '<img class="chAvatar" src="' + esc(avatar) + '" alt="">' +
      '<div class="chInfo">' +
        '<div class="chName">' + esc(ch.author) + verifiedIcon + '</div>' +
        '<div class="chSubline">チャンネル登録者数 ' + fmtNum(ch.subCount) + '人</div>' +
        '<div class="chLink" id="chLink">' + esc((ch.description || "").split("\n")[0].slice(0, 60)) + esc(chUrl) +
          ' <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M9 6l6 6-6 6"/></svg></div>' +
        '<div class="chActions"><button class="pill ' + (subbed ? "" : "solid") + '" id="chSub">' +
          (subbed ? "登録済み" : "チャンネル登録") + '</button></div>' +
      '</div>' +
    '</div>' +
    '<div class="chTabs">' +
      '<div class="chTab on" data-tab="videos">動画</div>' +
      '<div class="chTab" data-tab="shorts">Shorts</div>' +
      '<div class="chTab" data-tab="playlists">再生リスト</div>' +
      '<div class="chTab" data-tab="about">概要</div>' +
    '</div>' +
    '<div id="chBody"></div>';
  view().appendChild(head);

  $("#chLink").onclick = () => { navigator.clipboard.writeText("https://" + chUrl); toast("チャンネルURLをコピーしました"); };
  $("#chSub").onclick = () => {
    const i = S.subs.findIndex((s) => s.id === cid);
    if (i >= 0) S.subs.splice(i, 1); else S.subs.push({ id: cid, name: ch.author, img: avatar });
    LS.set("subs", S.subs); renderSubs(); pageChannel(cid);
  };

  const body = $("#chBody");
  let sortMode = "new";
  const sortVideos = (arr) => {
    const a = arr.slice();
    if (sortMode === "new") a.sort((x, y) => (y.published || 0) - (x.published || 0));
    else if (sortMode === "old") a.sort((x, y) => (x.published || 0) - (y.published || 0));
    else a.sort((x, y) => (y.viewCount || 0) - (x.viewCount || 0));
    return a;
  };
  const sortBar = (onPick) => {
    const bar = el("div", "chSort");
    [["new", "最新順"], ["pop", "人気順"], ["old", "古い順"]].forEach(([k, label]) => {
      const b = el("button", "chip" + (sortMode === k ? " on" : ""), label);
      b.onclick = () => { sortMode = k; onPick(); };
      bar.appendChild(b);
    });
    return bar;
  };

  let shortsCache = null;
  const showTab = async (tab) => {
    document.querySelectorAll(".chTab").forEach((t) => t.classList.toggle("on", t.dataset.tab === tab));
    body.innerHTML = "";
    if (tab === "videos") {
      body.appendChild(sortBar(() => showTab("videos")));
      body.appendChild(renderGrid(sortVideos(allVideos)));
    } else if (tab === "shorts") {
      body.appendChild(sortBar(() => showTab("shorts")));
      const holder = el("div", "shortsGrid");
      body.appendChild(holder);
      if (!shortsCache) {
        body.appendChild(el("div", "spinner"));
        shortsCache = await fetchChannelShorts(cid, allVideos, nav.abort && nav.abort.signal);
        body.querySelector(".spinner")?.remove();
      }
      if (!shortsCache.length) { body.appendChild(el("div", "empty", "ショートはありません")); return; }
      sortVideos(shortsCache).forEach((v) => holder.appendChild(shortCard(v)));
    } else if (tab === "playlists") {
      try {
        const d = await api("channel", "/api/v1/channels/" + cid + "/playlists");
        const pls = d.playlists || d || [];
        if (!pls.length) return body.appendChild(el("div", "empty", "再生リストはありません"));
        const g = el("div", "grid");
        pls.forEach((p) => {
          const c = el("div", "card");
          const t = (p.videos && p.videos[0]) ? thumbUrl(p.videos[0]) : "";
          c.innerHTML = '<div class="thumb"><img loading="lazy" src="' + esc(t) + '" alt="">' +
            '<span class="dur">' + fmtNum(p.videoCount || 0) + "本</span></div>" +
            '<div class="meta"><div style="min-width:0"><div class="mtitle">' + esc(p.title) + "</div></div></div>";
          c.onclick = () => { if (p.videos && p.videos[0]) go("/watch?v=" + vidOf(p.videos[0])); };
          g.appendChild(c);
        });
        body.appendChild(g);
      } catch (_) { body.appendChild(el("div", "empty", "再生リストを取得できませんでした")); }
    } else {
      const about = el("div", "chAbout");
      about.textContent = ch.description || "概要は登録されていません。";
      body.appendChild(about);
    }
  };
  document.querySelectorAll(".chTab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
  showTab("videos");
}

/* ---- shorts (YouTube 準拠 UI / Nocookie 再生) ---- */
const SHORT_QUERIES = ["#shorts", "shorts 面白い", "shorts 音楽", "shorts ゲーム", "shorts 料理",
  "shorts アニメ", "shorts スポーツ", "shorts 猫", "shorts ダンス", "shorts 芸人"];
let shortsMuted = true;
const shortsSeen = new Set();

async function fetchShorts(queries, signal) {
  const res = await Promise.allSettled(queries.map((q) =>
    api("search", "/api/v1/search?q=" + encodeURIComponent(q) + "&type=video&region=JP", { signal })));
  const out = [];
  res.forEach((r) => {
    if (r.status !== "fulfilled") return;
    (r.value || []).forEach((v) => {
      const id = v.videoId || v.id;
      if (!id || shortsSeen.has(id)) return;
      if (!(v.lengthSeconds > 0 && v.lengthSeconds <= 180)) return;
      shortsSeen.add(id);
      out.push(v);
    });
  });
  /* Piped からも補完してさらに件数を増やす */
  if (out.length < 20) {
    try {
      const d = await pipedGet("/search?q=" + encodeURIComponent("shorts") + "&filter=videos", signal);
      (d.items || []).map(normPipedVideo).forEach((v) => {
        if (!v.videoId || shortsSeen.has(v.videoId)) return;
        if (!(v.lengthSeconds > 0 && v.lengthSeconds <= 180)) return;
        shortsSeen.add(v.videoId); out.push(v);
      });
    } catch (_) {}
  }
  for (let i = out.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

const ICO = {
  like: '<svg viewBox="0 0 24 24"><path d="M18.77 11h-4.23l1.52-4.94A1.54 1.54 0 0014.6 4a1.53 1.53 0 00-1.29.7L9 11H3v10h14.6a2 2 0 001.94-1.51l1.4-6A2 2 0 0018.77 11z"/></svg>',
  dislike: '<svg viewBox="0 0 24 24" style="transform:rotate(180deg)"><path d="M18.77 11h-4.23l1.52-4.94A1.54 1.54 0 0014.6 4a1.53 1.53 0 00-1.29.7L9 11H3v10h14.6a2 2 0 001.94-1.51l1.4-6A2 2 0 0018.77 11z"/></svg>',
  comment: '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 100 16h8v-8a8 8 0 00-8-8zM2 12a10 10 0 1110 10H2V12z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M15 5.6L16.4 4 22 9.6 16.4 15 15 13.5l3-3H12a7 7 0 00-7 7v1H3v-1a9 9 0 019-9h6z"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M22 7H2v1h20V7zm-9 5H2v1h11v-1zm0 5H2v1h11v-1zm3-3.5v7l6-3.5-6-3.5z"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M15 5v14l-5-4H6V9h4l5-4zm3.5 3.5l-1 1L19 11l-1.5 1.5 1 1L20 12l1.5 1.5 1-1L21 11l1.5-1.5-1-1L20 10l-1.5-1.5z"/></svg>',
  unmute: '<svg viewBox="0 0 24 24"><path d="M15 5v14l-5-4H6V9h4l5-4zm3 2.2a6 6 0 010 9.6l-.8-1a4.8 4.8 0 000-7.6l.8-1z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><path d="M12 16.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm0-6a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm0-6a1.5 1.5 0 110 3 1.5 1.5 0 010-3z"/></svg>',
};

function shortItem(v) {
  const id = vidOf(v);
  const s = el("div", "short");
  s.dataset.id = id;
  const liked = S.liked.some((x) => x.videoId === id);
  const subbed = S.subs.some((x) => x.id === v.authorId);
  s.innerHTML =
    '<div class="sh-stage">' +
      '<img class="sh-poster" src="' + esc(shortThumbUrl(v)) + '" onerror="this.src=\'' + esc(thumbUrl(v, "m")) + '\'" alt="">' +
      '<div class="sh-tapzone"></div>' +
      '<button class="sh-mute" aria-label="音声">' + ICO.unmute + '</button>' +
      '<button class="sh-open">動画ページ</button>' +
      '<div class="sh-overlay">' +
        '<div class="sh-owner">' +
          '<img src="' + esc(authorImg(v) || "https://i.ytimg.com/vi/" + id + "/default.jpg") + '" alt="">' +
          '<span class="sh-name">@' + esc(v.author || "") + "</span>" +
          '<button class="sh-sub">' + (subbed ? "登録済み" : "登録") + "</button>" +
        "</div>" +
        '<div class="sh-title">' + esc(v.title || "") + "</div>" +
        '<div class="sh-desc">' + esc(v.description || "") + "</div>" +
        '<div class="sh-views">' + (v.viewCount ? fmtNum(v.viewCount) + "回視聴" : esc(v.publishedText || "")) + "</div>" +
      "</div>" +
      '<div class="sh-side">' +
        '<div class="sh-actwrap"><button class="sh-act sh-like' + (liked ? " on" : "") + '">' + ICO.like + '</button><span class="sh-cnt">' + fmtNum(v.likeCount || 0) + "</span></div>" +
        '<div class="sh-actwrap"><button class="sh-act sh-dis">' + ICO.dislike + '</button><span class="sh-cnt">低評価</span></div>' +
        '<div class="sh-actwrap"><button class="sh-act sh-com">' + ICO.comment + '</button><span class="sh-cnt">コメント</span></div>' +
        '<div class="sh-actwrap"><button class="sh-act sh-share">' + ICO.share + '</button><span class="sh-cnt">共有</span></div>' +
        '<div class="sh-actwrap"><button class="sh-act sh-save">' + ICO.save + '</button><span class="sh-cnt">保存</span></div>' +
        '<div class="sh-actwrap"><button class="sh-act sh-more">' + ICO.more + '</button><span class="sh-cnt">その他</span></div>' +
      "</div>" +
    "</div>";

  const stage = s.querySelector(".sh-stage");
  const post = (func, args) => {
    const f = stage.querySelector("iframe");
    if (!f || !f.contentWindow) return;
    f.contentWindow.postMessage(JSON.stringify({ event: "command", func, args: args || [] }), "*");
  };
  s._post = post;
  s._syncMute = () => {
    const btn = s.querySelector(".sh-mute");
    if (btn) btn.innerHTML = shortsMuted ? ICO.mute : ICO.unmute;
    const vid = stage.querySelector("video");
    if (vid) vid.muted = shortsMuted;
    post(shortsMuted ? "mute" : "unMute");
  };
  s.querySelector(".sh-mute").onclick = (e) => {
    e.stopPropagation();
    shortsMuted = !shortsMuted;
    document.querySelectorAll(".short").forEach((n) => n._syncMute && n._syncMute());
  };
  let playing = true;
  s.querySelector(".sh-tapzone").onclick = () => {
    playing = !playing;
    const vid = stage.querySelector("video");
    if (vid) { playing ? vid.play().catch(() => {}) : vid.pause(); }
    post(playing ? "playVideo" : "pauseVideo");
  };
  s.querySelector(".sh-open").onclick = (e) => { e.stopPropagation(); go("/watch?v=" + id); };
  s.querySelector(".sh-desc").onclick = (e) => { e.stopPropagation(); openPanel("概要", v.description || "説明はありません"); };
  s.querySelector(".sh-like").onclick = (e) => {
    e.stopPropagation(); toggleList("liked", v);
    e.currentTarget.classList.toggle("on"); toast("高く評価した動画を更新しました");
  };
  s.querySelector(".sh-dis").onclick = (e) => {
    e.stopPropagation();
    e.currentTarget.classList.toggle("on");
    toast("低評価しました");
  };
  s.querySelector(".sh-share").onclick = async (e) => {
    e.stopPropagation();
    const url = location.origin + "/short/" + id;
    if (navigator.share) { try { await navigator.share({ title: v.title, url }); return; } catch (_) {} }
    navigator.clipboard.writeText(url); toast("リンクをコピーしました");
  };
  s.querySelector(".sh-save").onclick = (e) => { e.stopPropagation(); savePlaylistPrompt(v); };
  s.querySelector(".sh-sub").onclick = (e) => {
    e.stopPropagation();
    if (!v.authorId) return toast("チャンネル情報がありません");
    const i = S.subs.findIndex((x) => x.id === v.authorId);
    if (i >= 0) { S.subs.splice(i, 1); e.target.textContent = "登録"; }
    else { S.subs.push({ id: v.authorId, name: v.author, img: authorImg(v) }); e.target.textContent = "登録済み"; }
    LS.set("subs", S.subs); renderSubs();
  };
  s.querySelector(".sh-owner img").onclick = (e) => { e.stopPropagation(); v.authorId && go("/channel?c=" + v.authorId); };
  s.querySelector(".sh-name").onclick = (e) => { e.stopPropagation(); v.authorId && go("/channel?c=" + v.authorId); };

  /* --- パネル (コメント / 概要) --- */
  function closePanel() { const old = stage.querySelector(".sh-panel"); if (old) old.remove(); }
  function openPanel(title, text) {
    closePanel();
    const pn = el("div", "sh-panel");
    pn.innerHTML = '<div class="pn-head"><span>' + esc(title) + '</span><button aria-label="閉じる">✕</button></div><div class="pn-body"></div>';
    pn.onclick = (e) => e.stopPropagation();
    pn.querySelector("button").onclick = closePanel;
    pn.querySelector(".pn-body").textContent = text;
    stage.appendChild(pn);
    return pn;
  }
  s._openComments = async () => {
    const pn = openPanel("コメント", "読み込み中…");
    const body = pn.querySelector(".pn-body");
    try {
      const d = await api("comments", "/api/v1/comments/" + id + "?sort_by=top");
      body.textContent = ""; body.style.whiteSpace = "normal";
      (d.comments || []).slice(0, 50).forEach((c) => {
        const n = el("div", "comment");
        n.innerHTML = '<img loading="lazy" src="' + esc(abs((c.authorThumbnails || []).slice(-1)[0]?.url)) + '" alt="">' +
          '<div><div class="cname">' + esc(c.author) + ' <span class="badge">' + esc(c.publishedText || "") + "</span></div>" +
          '<div class="ctext">' + esc(c.content) + "</div>" +
          '<div class="clike">👍 ' + fmtNum(c.likeCount || 0) + "</div></div>";
        body.appendChild(n);
      });
      if (!body.children.length) body.textContent = "コメントはありません";
    } catch (_) { body.textContent = "コメントを取得できませんでした"; }
  };
  s.querySelector(".sh-com").onclick = (e) => { e.stopPropagation(); s._openComments(); };

  /* --- ⋯ メニュー: 再生方法の変更ほか --- */
  s.querySelector(".sh-more").onclick = (e) => {
    e.stopPropagation();
    const old = stage.querySelector(".sh-menu");
    if (old) return old.remove();
    const m = el("div", "sh-menu");
    const mode = S.shortsPlayer;
    m.innerHTML =
      '<div class="mt">再生方法</div>' +
      '<div class="mi' + (mode === "nocookie" ? " on" : "") + '" data-m="nocookie">YouTube 埋め込み (nocookie)</div>' +
      '<div class="mi' + (mode === "stream" ? " on" : "") + '" data-m="stream">ストリーム再生 (高速・広告なし)</div>' +
      '<div class="mt">その他</div>' +
      '<div class="mi" data-a="desc">概要を表示</div>' +
      '<div class="mi" data-a="comments">コメントを表示</div>' +
      '<div class="mi" data-a="watch">動画ページで開く</div>' +
      '<div class="mi" data-a="share">共有</div>';
    m.onclick = (ev) => {
      ev.stopPropagation();
      const t = ev.target.closest(".mi"); if (!t) return;
      if (t.dataset.m) {
        S.shortsPlayer = t.dataset.m; LS.set("shortsPlayer", S.shortsPlayer);
        toast("再生方法を変更しました");
        s._unmount(); s._mount();
      } else if (t.dataset.a === "desc") openPanel("概要", v.description || "説明はありません");
      else if (t.dataset.a === "comments") s._openComments();
      else if (t.dataset.a === "watch") go("/watch?v=" + id);
      else if (t.dataset.a === "share") s.querySelector(".sh-share").click();
      m.remove();
    };
    stage.appendChild(m);
    setTimeout(() => document.addEventListener("click", () => m.remove(), { once: true }), 0);
  };

  /* --- 再生 --- */
  s._mountNocookie = () => {
    const f = el("iframe");
    f.allow = "autoplay; encrypted-media; picture-in-picture";
    f.referrerPolicy = "strict-origin-when-cross-origin";
    f.setAttribute("allowfullscreen", "");
    f.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(id) +
      "?autoplay=1&mute=" + (shortsMuted ? 1 : 0) + "&controls=0&loop=1&playlist=" + encodeURIComponent(id) +
      "&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3&enablejsapi=1&origin=" + encodeURIComponent(location.origin);
    stage.insertBefore(f, stage.querySelector(".sh-tapzone"));
    playing = true;
    setTimeout(() => s._syncMute(), 1200);
  };
  s._mountStream = async () => {
    const vp = el("video");
    vp.playsInline = true; vp.loop = true; vp.autoplay = true; vp.muted = shortsMuted; vp.preload = "auto";
    stage.insertBefore(vp, stage.querySelector(".sh-tapzone"));
    try {
      const data = await getVideo(id, nav.abort && nav.abort.signal);
      const st = pickStreams(data);
      if (!st.length) throw new Error("no stream");
      vp.src = st[0].url;
      vp.play().catch(() => {});
      /* メタ情報を補完 */
      if (data) {
        const t = s.querySelector(".sh-title"); if (t && !t.textContent.trim()) t.textContent = data.title || "";
        v.description = v.description || data.description || "";
        v.author = v.author || data.author; v.authorId = v.authorId || data.authorId;
      }
      vp.onerror = () => { vp.remove(); s._mountNocookie(); };
    } catch (_) { vp.remove(); s._mountNocookie(); }
    playing = true;
  };
  /* --- メタ情報(タイトル/チャンネル/概要/高評価/コメント数)を確実に補完 --- */
  s._enriched = false;
  s._enrich = async () => {
    if (s._enriched || !id) return;
    s._enriched = true;
    let d;
    try { d = await getVideo(id, nav.abort && nav.abort.signal); } catch (_) { return; }
    if (!d) return;
    v.title = d.title || v.title;
    v.author = d.author || v.author;
    v.authorId = d.authorId || v.authorId;
    v.description = d.description || v.description || "";
    v.viewCount = d.viewCount || v.viewCount;
    v.likeCount = d.likeCount || v.likeCount;
    v.authorThumbnails = d.authorThumbnails || v.authorThumbnails;
    const q = (sel) => s.querySelector(sel);
    if (q(".sh-title")) q(".sh-title").textContent = v.title || "";
    if (q(".sh-desc")) q(".sh-desc").textContent = v.description || "";
    if (q(".sh-name")) q(".sh-name").textContent = "@" + (v.author || "");
    if (q(".sh-views")) q(".sh-views").textContent =
      (v.viewCount ? fmtNum(v.viewCount) + "回視聴" : (v.publishedText || ago(d.published) || ""));
    const av = authorImg(v);
    if (av && q(".sh-owner img")) q(".sh-owner img").src = av;
    const likeCnt = q(".sh-like") && q(".sh-like").parentElement.querySelector(".sh-cnt");
    if (likeCnt) likeCnt.textContent = fmtNum(v.likeCount || 0);
    const comCnt = q(".sh-com") && q(".sh-com").parentElement.querySelector(".sh-cnt");
    if (comCnt && d.commentCount) comCnt.textContent = fmtNum(d.commentCount);
    const sb = q(".sh-sub");
    if (sb) sb.textContent = S.subs.some((x) => x.id === v.authorId) ? "登録済み" : "登録";
    if (s._active) document.title = (v.title ? v.title + " - " : "") + "ショート - NKYS Tube Pro";
  };
  s._mount = () => {
    s._active = true;
    document.querySelectorAll(".short").forEach((n) => { if (n !== s) n._active = false; });
    s._enrich();
    /* URL を /short/{videoId} に同期 */
    if (id && location.pathname !== "/short/" + id) history.replaceState({}, "", "/short/" + id);
    document.title = (v.title ? v.title + " - " : "") + "ショート - NKYS Tube Pro";
    if (stage.querySelector("iframe") || stage.querySelector("video")) {
      const vid = stage.querySelector("video");
      if (vid) vid.play().catch(() => {});
      post("playVideo"); s._syncMute(); return;
    }
    if (S.shortsPlayer === "stream") s._mountStream(); else s._mountNocookie();
  };
  s._unmount = () => {
    const f = stage.querySelector("iframe"); if (f) f.remove();
    const vid = stage.querySelector("video"); if (vid) { vid.pause(); vid.removeAttribute("src"); vid.remove(); }
    const pn = stage.querySelector(".sh-panel"); if (pn) pn.remove();
    const mn = stage.querySelector(".sh-menu"); if (mn) mn.remove();
  };
  return s;
}

async function pageShorts(startId) {
  setChips(null);
  shortsSeen.clear();
  view().innerHTML = '<div class="spinner"></div>';
  const signal = nav.abort.signal;
  let list;
  try { list = await fetchShorts(SHORT_QUERIES, signal); }
  catch (e) { if (isAbort(e)) return; view().innerHTML = '<div class="empty">ショートを取得できませんでした</div>'; return; }
  if (signal.aborted) return;
  if (!list.length) { view().innerHTML = '<div class="empty">ショートが見つかりませんでした</div>'; return; }

  if (startId) {
    const i = list.findIndex((v) => vidOf(v) === startId);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
    else if (i < 0) {
      let meta = { videoId: startId, title: "", author: "" };
      try {
        const d = await getVideo(startId, signal);
        if (d) meta = Object.assign(meta, {
          title: d.title, author: d.author, authorId: d.authorId, description: d.description,
          viewCount: d.viewCount, likeCount: d.likeCount, authorThumbnails: d.authorThumbnails,
        });
      } catch (_) {}
      list.unshift(meta);
    }
  }

  const box = el("div"); box.id = "shortsView";
  view().innerHTML = ""; view().appendChild(box);
  const end = el("div", "shortsEnd", "読み込み中…");

  const io = new IntersectionObserver((es) => {
    es.forEach((e) => {
      if (e.isIntersecting) e.target._mount && e.target._mount();
      else e.target._unmount && e.target._unmount();
    });
  }, { threshold: .55 });

  const append = (arr) => arr.forEach((v) => { const n = shortItem(v); box.appendChild(n); io.observe(n); });
  append(list);
  box.appendChild(end);

  /* 無限スクロールでさらに読み込み、表示量を増やす */
  let busy = false, round = 0;
  const more = new IntersectionObserver(async (es) => {
    if (!es.some((e) => e.isIntersecting) || busy) return;
    busy = true; round++;
    try {
      const qs = SHORT_QUERIES.slice().sort(() => Math.random() - .5).slice(0, 4)
        .map((q) => q + (round > 1 ? " " + round : ""));
      const nxt = await fetchShorts(qs, signal);
      if (!nxt.length) { end.textContent = "これ以上のショートはありません"; more.disconnect(); }
      else { box.removeChild(end); append(nxt); box.appendChild(end); }
    } catch (_) { end.textContent = "読み込みに失敗しました"; }
    finally { busy = false; }
  }, { root: box, rootMargin: "800px" });
  more.observe(end);

  signal.addEventListener("abort", () => { io.disconnect(); more.disconnect(); }, { once: true });
}

/* ---- library pages ---- */
function localPage(title, list) {
  setChips(null);
  view().innerHTML = "";
  view().appendChild(el("div", "sechead", esc(title)));
  view().appendChild(renderGrid(list));
}
/* 登録チャンネル: 上部に登録チャンネルの一覧、その下に最新動画 */
function subsChannelList() {
  const wrap = el("div");
  const head = el("div", "subsHead");
  head.innerHTML = "<h2>登録チャンネル (" + S.subs.length + ")</h2>";
  const toggle = el("button", "pill", S.subsView === "row" ? "アイコン表示" : "リスト表示");
  toggle.onclick = () => {
    S.subsView = S.subsView === "row" ? "icon" : "row";
    LS.set("subsView", S.subsView); pageSubs();
  };
  head.appendChild(toggle);
  wrap.appendChild(head);

  const box = el("div", S.subsView === "row" ? "subsRows" : "subsIcons");
  S.subs.forEach((s) => {
    const row = el("div", S.subsView === "row" ? "subsRow" : "subsIcon");
    row.innerHTML = '<img loading="lazy" src="' + esc(s.img || "") + '" alt="">' +
      (S.subsView === "row"
        ? '<div class="sr-name">' + esc(s.name || "") + "</div>"
        : "<span>" + esc(s.name || "") + "</span>");
    const un = el("button", "pill", "登録解除");
    un.onclick = (e) => {
      e.stopPropagation();
      S.subs = S.subs.filter((x) => x.id !== s.id);
      LS.set("subs", S.subs); renderSubs(); pageSubs();
    };
    if (S.subsView === "row") { un.style.marginLeft = "auto"; row.appendChild(un); }
    row.onclick = () => go("/channel?c=" + s.id);
    box.appendChild(row);
  });
  wrap.appendChild(box);
  return wrap;
}

async function pageSubs() {
  setChips(null);
  view().innerHTML = "";
  if (!S.subs.length) {
    view().appendChild(el("div", "sechead", "登録チャンネル"));
    view().appendChild(el("div", "empty", "登録しているチャンネルはありません"));
    return;
  }
  view().appendChild(subsChannelList());
  const feed = el("div");
  feed.appendChild(el("div", "sechead", "最新の動画"));
  feed.appendChild(el("div", "spinner"));
  view().appendChild(feed);

  const res = await Promise.allSettled(S.subs.map((s) => api("channel", "/api/v1/channels/" + s.id + "/videos")));
  if (nav.abort && nav.abort.signal.aborted) return;
  const all = [];
  res.forEach((r) => { if (r.status === "fulfilled") all.push(...((r.value.videos || r.value || []).slice(0, 12))); });
  all.sort((a, b) => (b.published || 0) - (a.published || 0));
  feed.innerHTML = "";
  feed.appendChild(el("div", "sechead", "最新の動画"));
  feed.appendChild(renderGrid(all));
}

/* ---- playlists ---- */
let curList = null, curListIndex = 0;

function savePlaylistPrompt(v) {
  const dlg = $("#dlgSave"), box = $("#saveList");
  const draw = () => {
    box.innerHTML = "";
    const names = Object.keys(S.playlists);
    if (!names.length) box.appendChild(el("div", "row", '<span style="color:var(--fg-dim)">再生リストがありません。下で作成してください。</span>'));
    names.forEach((n) => {
      const has = (S.playlists[n] || []).some((x) => x.videoId === (v.videoId || v.id));
      const row = el("label", "row");
      row.innerHTML = '<input type="checkbox" ' + (has ? "checked" : "") + '> <span>' + esc(n) + '</span> <span class="badge">' + (S.playlists[n] || []).length + "本</span>";
      row.querySelector("input").onchange = (e) => {
        const arr = (S.playlists[n] = S.playlists[n] || []);
        const i = arr.findIndex((x) => x.videoId === (v.videoId || v.id));
        if (e.target.checked) { if (i < 0) arr.push(slim(v)); } else if (i >= 0) arr.splice(i, 1);
        LS.set("playlists", S.playlists);
        toast("「" + n + "」を更新しました");
        draw();
      };
      box.appendChild(row);
    });
  };
  draw();
  $("#btnNewPl").onclick = () => {
    const name = $("#newPlName").value.trim();
    if (!name) return;
    S.playlists[name] = S.playlists[name] || [];
    if (!S.playlists[name].some((x) => x.videoId === (v.videoId || v.id))) S.playlists[name].push(slim(v));
    LS.set("playlists", S.playlists);
    $("#newPlName").value = "";
    toast("「" + name + "」に保存しました");
    draw();
  };
  dlg.showModal();
}

const plThumb = (v) => "https://i.ytimg.com/vi/" + (v.videoId || v.id) + "/mqdefault.jpg";

function pagePlaylists() {
  setChips(null);
  view().innerHTML = "";
  const names = Object.keys(S.playlists);
  view().appendChild(el("div", "sechead", "再生リスト"));
  if (!names.length) return view().appendChild(el("div", "empty", "再生リストがありません。動画の「保存」から作成できます。"));
  names.forEach((n) => {
    const items = S.playlists[n] || [];
    const card = el("div", "plcard");
    card.innerHTML =
      '<img src="' + esc(items[0] ? plThumb(items[0]) : "") + '" alt="">' +
      '<div class="plmeta"><div class="plname">' + esc(n) + "</div>" +
      '<div class="plcount">' + items.length + "本の動画</div></div>";
    const play = el("button", "pill solid", "すべて再生");
    play.onclick = (e) => { e.stopPropagation(); if (items.length) go("/watch?v=" + items[0].videoId + "&list=" + encodeURIComponent(n) + "&index=0"); };
    const del = el("button", "pill", "削除");
    del.onclick = (e) => { e.stopPropagation(); if (confirm("「" + n + "」を削除しますか？")) { delete S.playlists[n]; LS.set("playlists", S.playlists); pagePlaylists(); } };
    const acts = el("div", "actions"); acts.appendChild(play); acts.appendChild(del);
    card.appendChild(acts);
    card.onclick = () => go("/playlist?list=" + encodeURIComponent(n));
    view().appendChild(card);
  });
}

function pagePlaylistDetail(name) {
  setChips(null);
  const items = S.playlists[name];
  view().innerHTML = "";
  if (!items) return view().appendChild(el("div", "empty", "再生リストが見つかりません"));
  const h = el("div", "sechead");
  h.innerHTML = esc(name) + ' <span class="badge">' + items.length + "本</span>";
  const play = el("button", "pill solid", "すべて再生");
  play.onclick = () => items.length && go("/watch?v=" + items[0].videoId + "&list=" + encodeURIComponent(name) + "&index=0");
  h.appendChild(play);
  view().appendChild(h);
  const grid = el("div", "grid");
  items.forEach((v, i) => {
    const c = videoCard(v);
    c.onclick = () => go("/watch?v=" + (v.videoId || v.id) + "&list=" + encodeURIComponent(name) + "&index=" + i);
    const rm = el("button", "pill", "削除");
    rm.style.marginTop = "8px";
    rm.onclick = (e) => { e.stopPropagation(); items.splice(i, 1); LS.set("playlists", S.playlists); pagePlaylistDetail(name); };
    c.appendChild(rm);
    grid.appendChild(c);
  });
  view().appendChild(grid);
}

/* 視聴ページの再生リストパネル */
function renderPlaylistPanel(side, id) {
  if (!curList || !S.playlists[curList]) return;
  const items = S.playlists[curList];
  let idx = items.findIndex((x) => x.videoId === id);
  if (idx < 0) idx = Math.min(curListIndex, items.length - 1);
  curListIndex = idx;
  const panel = el("div", "plpanel");
  const head = el("div", "plhead");
  head.innerHTML = "<div><b>" + esc(curList) + "</b><br><span>" + (idx + 1) + " / " + items.length + "</span></div>";
  const body = el("div", "plbody");
  items.forEach((v, i) => {
    const row = el("div", "plitem" + (i === idx ? " on" : ""));
    row.innerHTML = '<span class="plidx">' + (i === idx ? "▶" : i + 1) + "</span>" +
      '<img loading="lazy" src="' + esc(plThumb(v)) + '" alt="">' +
      '<div class="plt">' + esc(v.title) + "</div>";
    row.onclick = () => go("/watch?v=" + v.videoId + "&list=" + encodeURIComponent(curList) + "&index=" + i);
    body.appendChild(row);
  });
  panel.appendChild(head); panel.appendChild(body);
  side.prepend(panel);
}
function playlistNext() {
  if (!curList || !S.playlists[curList]) return false;
  const items = S.playlists[curList];
  const n = curListIndex + 1;
  if (n >= items.length) return false;
  go("/watch?v=" + items[n].videoId + "&list=" + encodeURIComponent(curList) + "&index=" + n);
  return true;
}

const slim = (v) => ({ videoId: v.videoId || v.id, title: v.title, author: v.author, authorId: v.authorId,
  lengthSeconds: v.lengthSeconds, viewCount: v.viewCount, published: v.published, videoThumbnails: v.videoThumbnails });
function toggleList(key, v) {
  const arr = S[key], id = v.videoId || v.id;
  const i = arr.findIndex((x) => x.videoId === id);
  if (i >= 0) arr.splice(i, 1); else arr.unshift(slim(v));
  LS.set(key, arr);
}
function addHistory(v) {
  const id = v.videoId;
  S.history = S.history.filter((x) => x.videoId !== id);
  S.history.unshift(slim(v));
  S.history = S.history.slice(0, 200);
  LS.set("history", S.history);
}

/* ---------------- sidebar ---------------- */
function renderSubs() {
  const box = $("#subList"); box.innerHTML = "";
  S.subs.forEach((s) => {
    const r = el("div", "subrow");
    r.innerHTML = '<img src="' + esc(s.img || "") + '" alt=""><span class="subrow-name">' + esc(s.name) + "</span>";
    r.onclick = () => go("/channel?c=" + s.id);
    box.appendChild(r);
  });
}

/* ---------------- render ---------------- */
function render() {
  if (nav.abort) nav.abort.abort();
  nav.abort = new AbortController();
  document.onkeydown = null;
  $("#playerWrap")?.classList.remove("theater");
  document.body.classList.remove("theater");
  $("#main").classList.remove("wide");
  scrollTo(0, 0);

  const p = location.pathname, sp = new URLSearchParams(location.search);
  document.querySelectorAll(".snav").forEach((n) =>
    n.classList.toggle("active", (n.dataset.nav === "home" && p === "/") || "/" + n.dataset.nav === p ||
      (n.dataset.nav === "shorts" && p.startsWith("/short"))));

  if (p === "/" ) { document.title = "NKYS Tube Pro"; return pageHome(); }
  if (p === "/results" || p === "/search") {
    const q = sp.get("q") || "";
    document.title = q + " - NKYS Tube Pro";
    if (typeof addSearchHistory === "function") addSearchHistory(q);
    return pageSearch(q, sp.get("page"));
  }
  if (p === "/watch") {
    curList = sp.get("list");
    curListIndex = Math.max(0, parseInt(sp.get("index"), 10) || 0);
    document.title = "再生中 - NKYS Tube Pro";
    return pageWatch(sp.get("v"));
  }
  if (p === "/channel") return pageChannel(sp.get("c"));
  const mShort = p.match(/^\/short\/([\w-]{11})$/i);
  if (mShort) return pageShorts(mShort[1]);
  if (p === "/shorts" || p === "/short") return pageShorts(sp.get("v"));
  if (p === "/subs") return pageSubs();
  if (p === "/history") return localPage("履歴", S.history);
  if (p === "/liked") return localPage("高く評価した動画", S.liked);
  if (p === "/watchlater") return localPage("後で見る", S.later);
  if (p === "/playlists") return pagePlaylists();
  if (p === "/playlist") return pagePlaylistDetail(sp.get("list") || "");
  view().innerHTML = '<div class="empty">ページが見つかりません</div>';
}

/* ---------------- chrome wiring ---------------- */
/* ---------------- 検索履歴サジェスト ---------------- */
const SUG_ICON = '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 00-9 9H1l2.6 2.6.05.1L6.3 12H4.3a7.7 7.7 0 117.7 7.7 7.66 7.66 0 01-5.44-2.26l-.92.92A8.97 8.97 0 1012 3zm.5 5v4.7l3.9 2.3.6-1-3.5-2.05V8h-1z"/></svg>';
function addSearchHistory(q) {
  q = String(q || "").trim();
  if (!q) return;
  S.searches = [q].concat(S.searches.filter((x) => x !== q)).slice(0, 30);
  LS.set("searches", S.searches);
}
function removeSearchHistory(q) {
  S.searches = S.searches.filter((x) => x !== q);
  LS.set("searches", S.searches);
}
let sugIndex = -1;
function hideSug() { $("#sugBox").classList.remove("on"); sugIndex = -1; }
function showSug() {
  const box = $("#sugBox"), term = $("#q").value.trim().toLowerCase();
  const list = S.searches.filter((x) => !term || x.toLowerCase().includes(term)).slice(0, 10);
  box.innerHTML = "";
  if (!list.length) return hideSug();
  list.forEach((q, i) => {
    const row = el("div", "sug" + (i === sugIndex ? " sel" : ""));
    row.innerHTML = SUG_ICON + '<span class="sug-t">' + esc(q) + '</span><span class="sug-x">削除</span>';
    row.onmousedown = (e) => {
      e.preventDefault();
      if (e.target.closest(".sug-x")) { removeSearchHistory(q); showSug(); return; }
      $("#q").value = q; addSearchHistory(q); hideSug();
      go("/results?q=" + encodeURIComponent(q));
    };
    box.appendChild(row);
  });
  box.classList.add("on");
}
$("#q").addEventListener("focus", showSug);
$("#q").addEventListener("input", () => { sugIndex = -1; showSug(); });
$("#q").addEventListener("blur", () => setTimeout(hideSug, 120));
$("#q").addEventListener("keydown", (e) => {
  const box = $("#sugBox");
  if (!box.classList.contains("on")) return;
  const rows = box.querySelectorAll(".sug");
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    sugIndex = (sugIndex + (e.key === "ArrowDown" ? 1 : -1) + rows.length + 1) % (rows.length + 1) - 0;
    if (sugIndex >= rows.length) sugIndex = -1;
    rows.forEach((r, i) => r.classList.toggle("sel", i === sugIndex));
    if (sugIndex >= 0) $("#q").value = rows[sugIndex].querySelector(".sug-t").textContent;
  } else if (e.key === "Escape") hideSug();
});

$("#searchForm").onsubmit = (e) => {
  e.preventDefault();
  const q = $("#q").value.trim();
  if (!q) return;
  addSearchHistory(q); hideSug();
  go("/results?q=" + encodeURIComponent(q));
};
$("#btnMenu").onclick = () => {
  if (innerWidth <= 840) { $("#sidebar").classList.toggle("open"); return; }
  $("#sidebar").classList.toggle("mini"); $("#main").classList.toggle("mini");
};
$("#scrim").onclick = () => $("#sidebar").classList.remove("open");
$("#btnTheme").onclick = () => {
  S.settings.theme = S.settings.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = S.settings.theme; saveSettings();
};
$("#btnSettings").onclick = () => {
  $("#setProxy").checked = S.settings.proxy;
  $("#setAdaptive").checked = S.settings.adaptive;
  $("#setAutoplay").checked = S.settings.autoplay;
  $("#setQuality").value = S.settings.quality;
  $("#setNocookieDefault").checked = S.settings.playerMode === "nocookie";
  $("#healthBox").textContent = "計測済みインスタンス: " +
    Object.entries(S.health).sort((a, b) => a[1].ms - b[1].ms).slice(0, 4)
      .map(([b, r]) => b.replace(/^https:\/\//, "") + " " + Math.round(r.ms) + "ms").join(" / ");
  $("#dlgSettings").showModal();
};
$("#setProxy").onchange = (e) => { S.settings.proxy = USE_PROXY = e.target.checked; saveSettings(); cache.clear(); };
$("#setAdaptive").onchange = (e) => { S.settings.adaptive = e.target.checked; saveSettings(); };
$("#setAutoplay").onchange = (e) => { S.settings.autoplay = e.target.checked; saveSettings(); };
$("#setQuality").onchange = (e) => { S.settings.quality = e.target.value; saveSettings(); };
$("#setNocookieDefault").onchange = (e) => { S.settings.playerMode = e.target.checked ? "nocookie" : "stream"; saveSettings(); };

/* サーバープロキシが利用できるなら自動で有効化（安定性向上） */
(async () => {
  try {
    const r = await fetch("/health", { cache: "no-store" });
    if (r.ok && LS.get("settings", {}).proxy === undefined) { USE_PROXY = S.settings.proxy = true; saveSettings(); }
  } catch (_) {}
})();

/* 起動時に急上昇をプリフェッチして体感速度を上げる */
api("trending", "/api/v1/trending?region=JP").catch(() => {});
renderSubs();
render();

/* UI scroll behavior */
document.addEventListener("scroll",function(){
  var h=document.querySelector("header");
  if(h) h.classList.toggle("scrolled", window.scrollY>4);
},{passive:true});
