"use strict";
// DeZhLive phone: mic -> VAD segments (16 kHz WAV) -> OpenAI transcription -> OpenAI translation.
// Everything runs in the browser; the API key never leaves this device except to api.openai.com.

// Test hook: only on localhost, "?mock" points the app at a local mock server instead of OpenAI.
const MOCK = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has("mock");
const API = MOCK ? location.origin + "/v1" : "https://api.openai.com/v1";
const GAPI = MOCK ? location.origin + "/v1beta" : "https://generativelanguage.googleapis.com/v1beta";
// USD per 1M tokens [input(audio), output]; Google AI Studio pricing checked 2026-11-20 (3.6/3.8 Flash double on 2027-01-01).
const GPRICE = { "gemini-3.8-flash": [0.75, 3.75], "gemini-3.6-flash": [0.75, 3.75], "gemini-3.5-flash-lite": [0.30, 2.50], "gemini-4-hydrogen": [1.5, 7.5] };
const PRICE = { asrPerMin: 0.0045, inPerM: 1.0, outPerM: 5.0 }; // gpt-transcribe / gpt-6.1-terra, checked 2026-11-20

const DEFAULTS = {
  provider: "gemini", gkey: "", gmodel: "gemini-3.8-flash", key: "", lang: "de", asr: "gpt-transcribe", mt: "gpt-6.1-terra", effort: "none", sil: 700, font: 22,
  topic: "Vortrag auf einem medizinischen Kongress über Brustkrebs, Mammakarzinom, Onkologie, neoadjuvante " +
    "Chemotherapie, brusterhaltende Operation, Mastektomie, triple-negativ, HER2-positiv, pathologische Komplettremission, Studie.",
  gloss: [
    "Mammakarzinom/Brustkrebs=乳癌", "brusterhaltende Operation (BET)=保留乳房手術（保乳手術）", "Mastektomie=乳房切除術",
    "neoadjuvant=術前（前導性）", "adjuvant=術後輔助", "triple-negativ=三陰性", "HER2-positiv=HER2陽性",
    "hormonrezeptor-positiv=荷爾蒙受體陽性", "pathologische Komplettremission (pCR)=病理完全反應（pCR）",
    "Strahlentherapie=放射治療", "Chemotherapie=化學治療", "Nebenwirkungen=副作用", "Rezidiv=復發", "Metastasen=轉移",
    "Gesamtüberleben=整體存活期", "progressionsfreies Überleben=無惡化存活期", "Patientinnen=病人",
  ].join("\n"),
};
const LANG_NAME = { de: "德文", en: "英文", fr: "法文", es: "西班牙文", it: "義大利文", nl: "荷蘭文", ja: "日文", ko: "韓文" };
// Phrases speech models tend to hallucinate on silence/noise.
const JUNK = [/untertitel/i, /amara\.org/i, /vielen dank für(s| das) zuschauen/i, /^\W*$/, /^(\s*(ja|äh|ähm|mhm)[.,!?\s]*)+$/i,
  /thanks for watching/i, /subtitles by/i];

const $ = id => document.getElementById(id);
let S = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem("dz.settings") || "{}"));
let rows = JSON.parse(localStorage.getItem("dz.rows") || "[]"); // {t, de, zh, err}
let cost = Number(localStorage.getItem("dz.cost") || 0);
let running = false, ctx, stream, node, wakeLock, chain = Promise.resolve(), history = [];

// ------------------------------------------------------------------ UI
function saveRows() { localStorage.setItem("dz.rows", JSON.stringify(rows.slice(-2000))); }
function setStatus(msg, err) { $("status").textContent = msg || ""; $("status").className = err ? "err" : ""; }
function showCost() { $("cost").textContent = cost ? "≈US$" + cost.toFixed(cost < 1 ? 3 : 2) : ""; }
function addCost(x) { cost += x; localStorage.setItem("dz.cost", cost); showCost(); }
function nearBottom() { const l = $("list"); return l.scrollHeight - l.scrollTop - l.clientHeight < 80; }

function renderRow(r) {
  if (!r.el) {
    r.el = document.createElement("div");
    r.el.className = "row";
    r.el.innerHTML = '<div class="de"></div><div class="zh"></div>';
    $("list").appendChild(r.el);
  }
  const stick = nearBottom();
  r.el.classList.toggle("err", !!r.err);
  r.el.querySelector(".de").textContent = r.de || "";
  const zh = r.el.querySelector(".zh");
  zh.textContent = r.err || r.zh || (r.de ? "翻譯中…" : "辨識中…");
  zh.classList.toggle("pending", !r.zh && !r.err);
  if (stick) $("list").scrollTop = $("list").scrollHeight;
}
function renderAll() { $("list").innerHTML = ""; rows.forEach(r => { delete r.el; renderRow(r); }); }

function applySettingsUI() {
  document.documentElement.style.setProperty("--zh", S.font + "px");
  document.body.classList.toggle("hide-de", !!S.hideDe);
}

$("btnDe").onclick = () => { S.hideDe = !S.hideDe; localStorage.setItem("dz.settings", JSON.stringify(S)); applySettingsUI(); };
$("btnSettings").onclick = openSettings;
function openSettings() {
  $("sProv").value = S.provider; $("sGkey").value = S.gkey; $("sGmodel").value = S.gmodel; showProv();
  $("sKey").value = S.key; $("sLang").value = S.lang; $("sTopic").value = S.topic; $("sGloss").value = S.gloss;
  $("sFont").value = S.font; $("sAsr").value = S.asr; $("sMt").value = S.mt; $("sEffort").value = S.effort; $("sSil").value = S.sil;
  $("dlg").showModal();
}
function showProv() { const g = $("sProv").value === "gemini"; $("boxG").hidden = !g; $("boxO").hidden = g; }
$("sProv").onchange = showProv;
const curKey = () => (S.provider === "gemini" ? S.gkey : S.key);
const provName = () => (S.provider === "gemini" ? "Gemini" : "OpenAI");
$("dlg").addEventListener("close", () => {
  if ($("dlg").returnValue !== "save") return;
  Object.assign(S, {
    provider: $("sProv").value, gkey: $("sGkey").value.trim(), gmodel: $("sGmodel").value.trim() || DEFAULTS.gmodel,
    key: $("sKey").value.trim(), lang: $("sLang").value, topic: $("sTopic").value.trim(), gloss: $("sGloss").value.trim(),
    font: +$("sFont").value, asr: $("sAsr").value.trim() || DEFAULTS.asr, mt: $("sMt").value.trim() || DEFAULTS.mt,
    effort: $("sEffort").value, sil: Math.max(300, +$("sSil").value || DEFAULTS.sil),
  });
  localStorage.setItem("dz.settings", JSON.stringify(S));
  applySettingsUI();
  setStatus("設定已儲存");
});
$("btnClear").onclick = () => {
  if (!rows.length || !confirm("清除畫面上的所有字幕？（建議先匯出）")) return;
  rows = []; history = []; saveRows(); renderAll();
};
$("btnExport").onclick = async () => {
  if (!rows.length) return setStatus("還沒有內容");
  const txt = rows.map(r => `[${new Date(r.t).toLocaleTimeString("zh-TW", { hour12: false })}]\n${r.de || ""}\n${r.zh || r.err || ""}\n`).join("\n");
  const name = "DeZhLive_" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") + ".txt";
  const file = new File([txt], name, { type: "text/plain" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) return await navigator.share({ files: [file], title: name });
  } catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; a.click();
};
$("btnStart").onclick = () => (running ? stop() : start());

// ------------------------------------------------------------------ glossary helpers
function glossPairs() {
  return S.gloss.split(/[;\n；]+/).map(x => x.split("=")).filter(p => p.length >= 2 && p[0].trim())
    .map(([a, ...b]) => [a.trim(), b.join("=").trim()]);
}
function keywords() {
  const out = new Set();
  for (const [src] of glossPairs()) for (const k of src.split("/")) {
    const w = k.replace(/\(.*?\)/g, "").replace(/[<>\r\n]/g, "").trim();
    if (w) out.add(w);
    const ab = k.match(/\(([^)]+)\)/); if (ab) out.add(ab[1].trim());
  }
  return [...out].slice(0, 100);
}

// ------------------------------------------------------------------ audio capture + VAD
const SR = 16000, FRAME = 320; // 20 ms frames
let pcm = [], pending = new Float32Array(0), noise = 0.004, voiced = 0, silent = 0, inSeg = false, preroll = [];

async function start() {
  if (!curKey()) { setStatus(`請先在設定填入 ${provName()} API 金鑰`, true); return openSettings(); }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.audioWorklet.addModule("recorder-worklet.js");
    const src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "tap");
    const ratio = ctx.sampleRate / SR;
    node.port.onmessage = e => onAudio(downsample(e.data, ratio));
    src.connect(node);
    const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute).connect(ctx.destination); // keep graph pulling on Safari
    if (ctx.state === "suspended") await ctx.resume();
  } catch (e) {
    setStatus("無法使用麥克風：" + e.message, true); cleanupAudio(); return;
  }
  running = true; resetSeg();
  $("btnStart").textContent = "停止"; $("btnStart").classList.add("on");
  setStatus("收音中… 手機請保持螢幕開著、靠近喇叭");
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {}
}
function stop() {
  if (inSeg) flushSeg();
  running = false; cleanupAudio();
  $("btnStart").textContent = "開始"; $("btnStart").classList.remove("on"); $("meter").className = "";
  setStatus("已停止");
}
function cleanupAudio() {
  try { node?.disconnect(); } catch (_) {}
  stream?.getTracks().forEach(t => t.stop());
  ctx?.close().catch(() => {});
  wakeLock?.release?.().catch(() => {});
  node = stream = ctx = wakeLock = null;
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && running) {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {}
    if (ctx?.state === "suspended") ctx.resume();
  }
});

function downsample(x, ratio) {
  if (Math.abs(ratio - 1) < 1e-3) return x;
  const n = Math.floor(x.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(x.length, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < b; j++) s += x[j];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}
function resetSeg() { pcm = []; voiced = 0; silent = 0; inSeg = false; }

function onAudio(chunk) {
  const buf = new Float32Array(pending.length + chunk.length);
  buf.set(pending); buf.set(chunk, pending.length);
  let off = 0;
  for (; off + FRAME <= buf.length; off += FRAME) frame(buf.subarray(off, off + FRAME));
  pending = buf.slice(off);
}
function frame(f) {
  let e = 0; for (let i = 0; i < f.length; i++) e += f[i] * f[i];
  const rms = Math.sqrt(e / f.length);
  const speech = rms > Math.max(noise * 3, 0.006);
  if (!speech) noise = noise * 0.995 + rms * 0.005; else noise = Math.min(noise * 1.0005, 0.05);
  $("meter").className = speech ? "speech" : "";
  const copy = f.slice(0);
  if (!inSeg) {
    preroll.push(copy); if (preroll.length > 15) preroll.shift(); // 300 ms pre-roll
    if (speech) { inSeg = true; pcm = preroll.splice(0); voiced = 1; silent = 0; }
    return;
  }
  pcm.push(copy);
  if (speech) { voiced++; silent = 0; } else silent++;
  const secs = pcm.length * 0.02;
  if ((silent * 20 >= S.sil && secs >= 1.5) || secs >= 14 || (silent * 20 >= 2000)) flushSeg();
}
function flushSeg() {
  const frames = pcm, v = voiced; resetSeg();
  if (v < 15) return; // < 0.3 s of speech: ignore
  const n = frames.reduce((a, f) => a + f.length, 0), all = new Float32Array(n);
  let o = 0; for (const f of frames) { all.set(f, o); o += f.length; }
  handleSegment(all);
}

function wav(samples) {
  const b = new ArrayBuffer(44 + samples.length * 2), d = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); d.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, SR, true);
  d.setUint32(28, SR * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, "data"); d.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); d.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([b], { type: "audio/wav" });
}

// ------------------------------------------------------------------ OpenAI calls
async function api(path, body, isForm, gemini) {
  const auth = gemini ? { "x-goog-api-key": S.gkey } : { Authorization: "Bearer " + S.key };
  const r = await fetch((gemini ? GAPI : API) + path, {
    method: "POST", body: isForm ? body : JSON.stringify(body),
    headers: Object.assign(auth, isForm ? {} : { "Content-Type": "application/json" }),
  });
  if (!r.ok) {
    let msg = r.status + ""; try { msg = (await r.json()).error?.message || msg; } catch (_) {}
    const err = new Error(msg); err.status = /api key not valid|API_KEY_INVALID/i.test(msg) ? 401 : r.status; throw err;
  }
  return r;
}
// Reads either a JSON body or a server-sent-event stream of transcript deltas.
async function readTranscript(r) {
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("event-stream")) { const j = await r.json(); return j.text || ""; }
  const txt = await r.text(); let done = "", delta = "";
  for (const line of txt.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const p = line.slice(5).trim(); if (!p || p === "[DONE]") continue;
    try { const j = JSON.parse(p); if (j.type?.endsWith(".done") && j.text != null) done = j.text; else if (j.delta) delta += j.delta; } catch (_) {}
  }
  return done || delta;
}

// Optional request fields are dropped one by one if the API rejects them (field names change between models).
let asrDrop = [];
async function transcribe(blob, prev) {
  const opt = {
    languages: f => f.append("languages[]", S.lang),
    keywords: f => keywords().forEach(k => f.append("keywords[]", k)),
    prompt: f => f.append("prompt", (S.topic + " " + prev).slice(-800)),
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const f = new FormData();
    f.append("file", blob, "seg.wav"); f.append("model", S.asr);
    for (const k of Object.keys(opt)) if (!asrDrop.includes(k)) opt[k](f);
    try { return await readTranscript(await api("/audio/transcriptions", f, true)); }
    catch (e) {
      if (e.status !== 400) throw e;
      const bad = Object.keys(opt).find(k => !asrDrop.includes(k) && e.message.toLowerCase().includes(k.replace(/s$/, "")));
      if (!bad) throw e;
      asrDrop.push(bad); console.warn("dropping unsupported transcription field", bad, e.message);
    }
  }
  throw new Error("語音辨識參數不相容");
}

function rules() {
  return "使用台灣繁體中文與台灣醫學慣用譯名（例如：乳癌、化療、放射治療）。句子不完整時照實翻出已有部分，不要自行補完。" +
    (S.gloss ? "\n專有名詞請優先使用以下對照（原文拼字或發音可能略有出入，請依發音辨認）：\n" + glossPairs().map(p => p.join(" = ")).join("\n") : "") +
    (S.topic ? "\n會議主題：" + S.topic : "");
}

// Gemini: one call does both transcription and translation of the audio segment.
const THINK = [{ thinkingBudget: 0 }, { thinkingLevel: "minimal" }, null];
let gThink = 0, gSchema = true;
function b64(blob) {
  return new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result.split(",")[1]); fr.onerror = no; fr.readAsDataURL(blob); });
}
async function geminiSegment(blob, hist) {
  const src = LANG_NAME[S.lang] || "外語";
  const system = `你是專業的醫學會議口譯員。你會收到一段${src}演講錄音：先逐字聽寫原文（${src}），再翻譯成台灣繁體中文。` + rules() +
    '\n以 JSON 回答：{"src": "原文聽寫", "zh": "中文翻譯"}。錄音中沒有可辨識的語音（只有噪音、掌聲、靜音）時，兩者都回空字串，不要編造內容。';
  const ctx = hist.length ? "前文（只供上下文參考，不要再翻譯）：\n" + hist.map(([a, b]) => a + "\n→ " + b).join("\n") + "\n\n" : "";
  const data = await b64(blob);
  for (;;) {
    const gc = { responseMimeType: "application/json" };
    if (gSchema) gc.responseSchema = { type: "OBJECT", properties: { src: { type: "STRING" }, zh: { type: "STRING" } }, required: ["src", "zh"] };
    if (THINK[gThink]) gc.thinkingConfig = THINK[gThink];
    const body = { systemInstruction: { parts: [{ text: system }] }, generationConfig: gc,
      contents: [{ role: "user", parts: [{ text: ctx + "請聽寫並翻譯這段錄音：" }, { inline_data: { mime_type: "audio/wav", data } }] }] };
    let j;
    try { j = await (await api(`/models/${encodeURIComponent(S.gmodel)}:generateContent`, body, false, true)).json(); }
    catch (e) {
      if (e.status === 400 && /think/i.test(e.message) && THINK[gThink]) { gThink++; continue; }
      if (e.status === 400 && /schema/i.test(e.message) && gSchema) { gSchema = false; continue; }
      throw e;
    }
    const u = j.usageMetadata || {}, pr = GPRICE[S.gmodel] || GPRICE["gemini-3.8-flash"];
    addCost(((u.promptTokenCount || 0) * pr[0] + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * pr[1]) / 1e6);
    const txt = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
    try { const o = JSON.parse(txt.replace(/^```(json)?|```$/g, "")); return { de: (o.src || "").trim(), zh: (o.zh || "").trim() }; }
    catch (_) { return { de: "", zh: txt }; }
  }
}

let mtNoEffort = false;
async function translate(text) {
  const system = `你是專業的醫學會議口譯員。把使用者給的${LANG_NAME[S.lang] || "外語"}演講語音辨識稿翻譯成台灣繁體中文。` +
    "語音辨識可能有錯字，請依上下文推斷正確的專業術語。只輸出譯文本身，不要解釋、不要加引號、不要重複原文。" + rules();
  const messages = [{ role: "system", content: system }];
  for (const [a, b] of history.slice(-4)) messages.push({ role: "user", content: a }, { role: "assistant", content: b });
  messages.push({ role: "user", content: text });
  const body = { model: S.mt, messages };
  if (!mtNoEffort && S.effort) body.reasoning_effort = S.effort;
  let j;
  try { j = await (await api("/chat/completions", body)).json(); }
  catch (e) {
    if (e.status === 400 && body.reasoning_effort && /reason/i.test(e.message)) { mtNoEffort = true; return translate(text); }
    throw e;
  }
  const u = j.usage || {};
  addCost(((u.prompt_tokens || 0) * PRICE.inPerM + (u.completion_tokens || 0) * PRICE.outPerM) / 1e6);
  return (j.choices?.[0]?.message?.content || "").trim();
}

function friendly(e) {
  if (e.status === 401) return "金鑰無效，請到設定檢查";
  if (e.status === 429) return `${provName()} 用量上限或額度不足（429）`;
  if (e.status === 403) return `${provName()} 拒絕存取（403）：檢查金鑰權限或是否已開通付費`;
  if (e.status === 404) return "找不到模型，請到設定→進階檢查模型名稱";
  if (e instanceof TypeError) return "網路連線失敗";
  return "錯誤：" + e.message;
}

async function withRetry(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.status === 401 || e.status === 404 || e.status === 400) throw e;
    await new Promise(r => setTimeout(r, 1200));
    return fn();
  }
}

function handleSegment(samples) {
  const row = { t: Date.now() };
  rows.push(row); renderRow(row);
  if (S.provider === "gemini") {
    const p = withRetry(() => geminiSegment(wav(samples), history.slice(-3)));
    p.catch(() => {});
    chain = chain.then(async () => {
      try {
        const { de, zh } = await p;
        if ((!de && !zh) || (de && JUNK.some(rx => rx.test(de)))) { rows.splice(rows.indexOf(row), 1); row.el?.remove(); return; }
        Object.assign(row, { de, zh });
        history.push([de, zh]); if (history.length > 20) history.shift();
        if (running) setStatus("收音中…");
      } catch (e) { row.err = friendly(e); setStatus(row.err, true); }
      renderRow(row); saveRows();
    });
    return;
  }
  const prev = history.slice(-2).map(h => h[0]).join(" ");
  addCost(samples.length / SR / 60 * PRICE.asrPerMin);
  const asrP = withRetry(() => transcribe(wav(samples), prev));
  asrP.catch(() => {}); // handled in chain
  chain = chain.then(async () => {
    try {
      const de = (await asrP).trim();
      if (!de || JUNK.some(rx => rx.test(de))) { rows.splice(rows.indexOf(row), 1); row.el?.remove(); return; }
      row.de = de; renderRow(row);
      row.zh = await withRetry(() => translate(de));
      history.push([de, row.zh]); if (history.length > 20) history.shift();
      if (running) setStatus("收音中…");
    } catch (e) {
      row.err = friendly(e); setStatus(row.err, true);
    }
    renderRow(row); saveRows();
  });
}

// ------------------------------------------------------------------ boot
applySettingsUI(); renderAll(); showCost();
history = rows.filter(r => r.de && r.zh).slice(-4).map(r => [r.de, r.zh]);
if (!curKey()) setStatus("第一次使用：請按 ⚙️ 填入 API 金鑰");
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
if (MOCK) {
  S.key = S.key || "mock"; S.gkey = S.gkey || "mock";
  if (new URLSearchParams(location.search).get("mock") === "openai") S.provider = "openai";
  if (location.hash === "#autostart") setTimeout(start, 300);
  setInterval(() => fetch("/mock-report", { method: "POST", body: JSON.stringify({ status: $("status").textContent, cost: $("cost").textContent,
    rows: rows.map(r => ({ de: r.de, zh: r.zh, err: r.err })) }) }).catch(() => {}), 2000);
}
if (!window.isSecureContext) setStatus("需要 https 網址才能使用麥克風", true);
