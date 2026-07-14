#!/usr/bin/env node
// 주간 "실전 레시피" 생성기 — 백로그(recipes-catalog) → 도구 grounding → codex exec (구독 인증)
//   → 한 주 한 편, 깊은 단계별 워크플로우 회차 .md(.ni 시맨틱 HTML). 당선 /studio.
// build-local(매일 도감)과 짝: 이쪽은 churn 없이 *재현 가능한 따라하기 가이드* 한 편/주.
//   DRY_RUN=1 : 레시피 선택+프롬프트만(stderr) 출력, 파일 안 씀
//   FORCE=1   : 오늘 날짜 파일 있으면 덮어쓰기
//   RECIPE_ID=<id> : 로테이션 무시하고 특정 레시피 강제
//   ARTIFACT=<경로> : 결과 섹션에 <img> 주입(실제 산출물 이미지)
//   CODEX_MODEL=<선택>   CODEX_REASONING_EFFORT=low|medium|high|xhigh
import { readFile, writeFile, readdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";

const DRY_RUN = process.env.DRY_RUN === "1";
const FORCE = process.env.FORCE === "1";
const CODEX_MODEL = process.env.CODEX_MODEL || "";
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || "high";
const FORCE_RECIPE_ID = process.env.RECIPE_ID || "";
const ARTIFACT = process.env.ARTIFACT || "";

// ===== KST 날짜·슬러그 (build-local 동일) =====
const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const sinceIso = yesterday.toISOString().slice(0, 10);
const sinceTs = Math.floor(yesterday.getTime() / 1000);

const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
const dateStr = kst.toISOString().slice(0, 10);
const dayOfWeek = ["일", "월", "화", "수", "목", "금", "토"][kst.getUTCDay()];
const slug = `${dateStr}_${dayOfWeek}`;

// ===== fetch/strip/feed 헬퍼 (build-local 동일 — verbatim) =====
async function fetchWithRetry(url, { headers = {}, attempts = 3, baseDelayMs = 800 } = {}) {
  const mergedHeaders = {
    // 브라우저 UA — 봇 UA는 Food4Rhino·D5 등에서 403. 일반 RSS는 사람처럼 접근해야 200.
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
    ...headers,
  };
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: mergedHeaders });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (/HTTP (401|403|404)/.test(err.message)) throw err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}

function stripHtml(html, baseUrl) {
  const seen = new Set();
  let s = html.replace(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, inner) => {
      let url;
      try {
        url = new URL(href, baseUrl).href;
      } catch {
        url = href;
      }
      const text = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!text) return " ";
      if (/^(mailto:|tel:|javascript:|#)/i.test(url)) return ` ${text} `;
      if (text.length < 3) return ` ${text} `;
      const key = `${text}::${url}`;
      if (seen.has(key)) return ` ${text} `;
      seen.add(key);
      return ` ${text} (${url}) `;
    }
  );
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// RSS/Atom 공통 파서 (build-local 동일 + keywordRe 항목 필터: general 고볼륨 피드용)
function parseFeed(xml, max = 25, keywordRe = null) {
  const clean = (s) => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
  const blocks = xml.split(/<entry[\s>]|<item[\s>]/i).slice(1, keywordRe ? 40 : max + 1);
  const items = [];
  for (const b of blocks) {
    const title = clean((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    let link = (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1];
    if (!link) link = clean((b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]);
    const date = ((b.match(/<(updated|pubDate|published|dc:date)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2] || "").slice(0, 10);
    const desc = clean((b.match(/<(description|summary)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2] || "").slice(0, 200);
    if (!title) continue;
    if (keywordRe && !keywordRe.test(`${title} ${desc} ${link}`)) continue; // general 피드는 관련 항목만
    items.push(`- ${title} (${(link || "").trim()})${date ? ` · ${date}` : ""}${desc ? `\n  ${desc}` : ""}`);
    if (items.length >= max) break;
  }
  return items.join("\n");
}

// general(고볼륨 일반) 피드에서 현상설계 AI/렌더/도구 관련 항목만 통과시키는 키워드.
const ARCH_KW = /\b(AI|render|rendering|render(?:er|ing)?|diffusion|ControlNet|generative|gen-?AI|Rhino|Grasshopper|parametric|computational|BIM|Revit|SketchUp|3D|text-to|image-to|sketch-to|upscal|ComfyUI|Stable Diffusion|Midjourney|LoRA|Veras|Enscape|Lumion|D5|Twinmotion|Krea|Magnific|Forma|plugin|workflow|visuali[sz]|neural|NeRF|gaussian)\b|렌더|렌더링|라이노|그래스호퍼|파라메트릭|디퓨전|생성형|업스케일|건축\s*AI|매싱/i;

// ===== 입력 로드 =====
const recipesCatalog = JSON.parse(await readFile("scripts/recipes-catalog.json", "utf8"));
const RECIPES = Array.isArray(recipesCatalog.recipes) ? recipesCatalog.recipes : [];
if (!RECIPES.length) { console.error("recipes-catalog.json 에 레시피가 없습니다."); process.exit(1); }

let TOOLS = [];
try {
  TOOLS = JSON.parse(await readFile("scripts/tools-catalog.json", "utf8")).tools || [];
} catch (e) {
  console.warn(`tools-catalog.json 로드 실패: ${e.message} — grounding 없이 진행`);
}
const toolById = new Map(TOOLS.map((t) => [t.id, t]));

let SOURCES = [];
try {
  SOURCES = JSON.parse(await readFile("scripts/sources.json", "utf8"));
} catch (e) {
  console.warn(`sources.json 로드 실패: ${e.message} — '이번 주 새 소식' 생략`);
}

// ===== 오늘 파일 존재 체크 =====
const existing = (await readdir(".")).filter((f) => f === `${slug}.md`);
if (existing.length && !FORCE && !DRY_RUN) {
  console.log(`${slug}.md 이미 존재 — 종료 (FORCE=1로 강제 재생성)`);
  process.exit(0);
}

// ===== 레시피 선택 (LRU 로테이션) =====
// 회차 파일들의 frontmatter `recipe_id` 를 읽어 '가장 최근에 쓴 회차 인덱스(0=가장 최근)'를 구한다.
// 한 번도 안 쓴 레시피를 최우선, 그다음 가장 오래 안 쓴 것. RECIPE_ID 로 강제 가능.
const allMd = (await readdir(".")).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f) && f !== `${slug}.md`);
const sortedMd = allMd.sort().reverse(); // 최신 파일 먼저 (index 0 = 가장 최근 회차)
const recipeLastSeen = new Map(); // recipe_id → 가장 최근 등장 회차 인덱스 (0=가장 최근)
for (let i = 0; i < sortedMd.length; i++) {
  let fm = "";
  try {
    const m = (await readFile(sortedMd[i], "utf8")).replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
    fm = m ? m[1] : "";
  } catch { continue; }
  const rid = (fm.match(/^recipe_id:\s*(.+)$/m) || [])[1];
  if (rid) {
    const id = rid.trim().replace(/^["']|["']$/g, "");
    if (!recipeLastSeen.has(id)) recipeLastSeen.set(id, i); // 첫 등장(=가장 최근)만 기록
  }
}
const seenRank = (r) => recipeLastSeen.get(r.id) ?? 9999; // 미사용=9999(최우선)

let recipe;
if (FORCE_RECIPE_ID) {
  recipe = RECIPES.find((r) => r.id === FORCE_RECIPE_ID);
  if (!recipe) { console.error(`RECIPE_ID="${FORCE_RECIPE_ID}" 가 카탈로그에 없습니다.`); process.exit(1); }
  console.log(`레시피 강제 지정: ${recipe.id}`);
} else {
  // 가장 오래 안 쓴(또는 한 번도 안 쓴) 순으로 정렬, 동률이면 카탈로그 순서 안정 정렬
  const ranked = RECIPES.map((r, i) => ({ r, rank: seenRank(r), idx: i }))
    .sort((a, b) => (b.rank - a.rank) || (a.idx - b.idx));
  recipe = ranked[0].r;
  const usedCount = RECIPES.filter((r) => recipeLastSeen.has(r.id)).length;
  console.log(`레시피 선택(LRU): ${recipe.id} — "${recipe.title}" (사용된 레시피 ${usedCount}/${RECIPES.length}, 이 레시피 rank=${seenRank(recipe)}${seenRank(recipe) === 9999 ? " 한 번도 안 씀" : ` ${seenRank(recipe) + 1}회차 전 사용`})`);
}

// ===== 도구 체인 grounding =====
// chain 의 각 id 를 tools-catalog 로 해석하고, url 을 best-effort fetch 해 현재 가격·기능을 grounding.
// own:* 는 요한님 자체 로컬 도구 — fetch 없이 레시피 힌트로 기술.
const OWN_TOOLS = {
  "own:cad_to_ai_jsx": {
    label: "cad_to_ai_jsx (자체 도구)",
    desc: "요한님 자체 로컬 도구 (C:/cad_ai/cad_to_ai_jsx.py). AutoCAD DWG 도면을 Illustrator JSX 로 자동 변환 — plan/elevation/section 3모드. HATCH/SOLID/bulge/width·레이어 색·선·윤고딕 폰트·페이지(338.6×190.5mm) 자동. 외부 서비스 아님, 가격 없음, 플랫폼=로컬 Python+Illustrator.",
  },
};

async function groundChainTool(id) {
  if (id.startsWith("own:")) {
    const o = OWN_TOOLS[id] || { label: id.replace(/^own:/, "") + " (자체 도구)", desc: "요한님 자체 로컬 도구. 외부 링크 없음." };
    return { id, own: true, name: o.label, url: "", price: "—(자체 도구)", platform: "로컬", blurb: o.desc, source: "" };
  }
  const t = toolById.get(id);
  if (!t) {
    console.warn(`  chain 도구 미해석: ${id} (tools-catalog 에 없음)`);
    return { id, own: false, name: id, url: "", price: "확인 필요", platform: "확인 필요", blurb: "(카탈로그에 없음)", source: "" };
  }
  let source = "";
  if (/^https?:\/\//.test(t.url)) {
    try {
      const res = await fetchWithRetry(t.url, { attempts: 2, baseDelayMs: 500 });
      const ct = res.headers.get("content-type") || "";
      if (/text|html|json|xml/i.test(ct)) source = stripHtml(await res.text(), t.url).slice(0, 1800);
    } catch (e) { /* best-effort: grounding 실패해도 카탈로그 값으로 진행 */ }
  }
  return {
    id, own: false, name: t.name, url: t.url, price: t.price || "확인 필요",
    platform: t.platform || "확인 필요", blurb: t.blurb || "", hook: t.hook || "",
    stage: t.stage || "", maturity: t.maturity || "", korea: t.korea || "", source,
  };
}

const chain = Array.isArray(recipe.chain) ? recipe.chain : [];
console.log(`체인 ${chain.length}개 도구 grounding...`);
const chainTools = await Promise.all(chain.map(groundChainTool));
const groundedCount = chainTools.filter((c) => c.source).length;
console.log(`  원문 확보: ${groundedCount}/${chainTools.filter((c) => !c.own).length} (외부 도구 기준)`);

// 막힌·로그인·JS 소스(kind:"crawl")는 crawl.py(실제 크롬)로 우회. best-effort:
// 크롬/파이썬 없거나 막히면 조용히 "" 반환(작업은 절대 안 깨짐). 하드 타임아웃으로 행 방지.
function crawlFetch(url, { timeoutMs = 75000 } = {}) {
  const crawlPath = "../../_tools/crawl.py"; // work/_inspect/arch-ai-tools-curation → work/_tools/crawl.py
  const base = [crawlPath, url, "--headless", "--mode", "html", "--sleep", "3", "--scroll", "1"];
  // selenium 은 py -3.14 에만 깔려 있음 → 그게 1순위. 빈 출력(예: python에 selenium 없음)이면 다음 런처로.
  const launchers = [["py", ["-3.14", ...base]], ["python", base], ["py", base]];
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= launchers.length) return resolve("");
      const [cmd, args] = launchers[i++];
      let out = "", settled = false;
      const child = spawn(cmd, args, { cwd: process.cwd() });
      const done = (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } };
      const t = setTimeout(() => { try { child.kill(); } catch {} done(out); }, timeoutMs);
      child.stdout?.on("data", (d) => { out += d.toString(); });
      child.on("error", () => { if (!settled) { clearTimeout(t); next(); } });   // 런처 없음(ENOENT) → 다음
      child.on("close", () => { if (settled) return; if (out.trim()) done(out); else { clearTimeout(t); next(); } }); // 빈 출력 → 다음 런처
    };
    next();
  });
}

// ===== Reddit 공식 OAuth API (스크래핑은 IP단 'network security' 차단 → 정식 통로만 동작) =====
// 인증정보: gitignore 된 scripts/reddit.local.json {client_id, client_secret, user_agent, [username, password]}.
// 파일 없거나 토큰 실패면 reddit 소스는 조용히 스킵(빈 문자열) — 작업 안 깨짐.
let _redditToken = null, _redditTried = false;
async function redditToken() {
  if (_redditTried) return _redditToken;
  _redditTried = true;
  let cfg;
  try { cfg = JSON.parse(await readFile("scripts/reddit.local.json", "utf8")); } catch { return null; }
  if (!cfg.client_id || !cfg.client_secret) return null;
  const ua = cfg.user_agent || "windows:dangsun-studio:1.0 (by /u/unknown)";
  const basic = Buffer.from(`${cfg.client_id}:${cfg.client_secret}`).toString("base64");
  const body = (cfg.username && cfg.password)
    ? new URLSearchParams({ grant_type: "password", username: cfg.username, password: cfg.password })
    : new URLSearchParams({ grant_type: "client_credentials" }); // userless(앱 전용) — 공개 읽기엔 충분
  try {
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua },
      body,
    });
    if (!res.ok) return null;
    const j = await res.json();
    _redditToken = j.access_token ? { token: j.access_token, ua } : null;
    return _redditToken;
  } catch { return null; }
}
async function fetchReddit(apiUrl) {
  const t = await redditToken();
  if (!t) return "";
  try {
    const res = await fetch(apiUrl, { headers: { Authorization: `bearer ${t.token}`, "User-Agent": t.ua } });
    if (!res.ok) return "";
    const j = await res.json();
    const posts = (j.data?.children || []).map((c) => c.data).filter(Boolean);
    return posts.slice(0, 8).map((p) =>
      `- ${p.title} (https://reddit.com${p.permalink}) · ${new Date(p.created_utc * 1000).toISOString().slice(0, 10)}`
      + (p.selftext ? `\n  ${String(p.selftext).replace(/\s+/g, " ").slice(0, 150)}` : "")
    ).join("\n");
  } catch { return ""; }
}

// ===== OPTIONAL: 이번 주 새 소식 (가벼운 수집) =====
// 고신호 core(collect:true)는 매주 + collect:false 보조 2개 + crawl 1개를 주차로 로테이션.
// 실패/빈손이어도 OK — 그 섹션은 정직하게 '잠잠'으로 처리. general 피드는 ARCH_KW로 항목 필터.
const weekIdx = Math.floor(now.getTime() / (7 * 864e5));
async function lightCollect() {
  if (!SOURCES.length) return [];
  const rot = (arr, n) => arr.length ? Array.from({ length: Math.min(n, arr.length) }, (_, k) => arr[(weekIdx + k) % arr.length]) : [];
  const core = SOURCES.filter((s) => s.collect && s.kind !== "crawl");        // 매주
  const extra = rot(SOURCES.filter((s) => !s.collect && s.kind !== "crawl"), 2); // 주차 로테이션
  const crawl = rot(SOURCES.filter((s) => s.kind === "crawl"), 1);             // 주당 최대 1 (best-effort)
  const picked = [...core, ...extra, ...crawl];
  const out = [];
  for (const s of picked) {
    try {
      const url = s.url.replaceAll("__SINCE__", sinceIso).replaceAll("__SINCE_TS__", String(sinceTs));
      const kw = s.general ? ARCH_KW : null;
      let text = "";
      if (s.kind === "reddit") {
        const raw = await fetchReddit(url); // 공식 OAuth API (인증 없으면 "")
        text = (kw ? raw.split("\n").filter((l) => kw.test(l)).join("\n") : raw).slice(0, 1600);
      } else if (s.kind === "crawl") {
        const raw = await crawlFetch(url); // --mode html (page_source)
        let t;
        if (/<item[\s>]|<entry[\s>]/i.test(raw)) t = parseFeed(raw, 8, kw);   // 피드면 파싱
        else { const st = stripHtml(raw, url); t = kw ? st.split("\n").filter((l) => kw.test(l)).join("\n") : st; } // 페이지면 본문
        text = t.slice(0, 1600);
      } else if (s.kind === "json") {
        const res = await fetchWithRetry(url, { attempts: 2, baseDelayMs: 500 });
        text = JSON.stringify(await res.json()).slice(0, 1600);
      } else if (s.kind === "html") {
        const res = await fetchWithRetry(url, { attempts: 2, baseDelayMs: 500 });
        text = stripHtml(await res.text(), url).slice(0, 1600);
      } else { // rss/atom
        const res = await fetchWithRetry(url, { attempts: 2, baseDelayMs: 500 });
        text = parseFeed(await res.text(), 6, kw).slice(0, 1600);
      }
      if (text && text.trim()) out.push({ name: s.name, tag: s.tag, text });
    } catch (e) {
      // 조용히 스킵 — 새 소식은 어디까지나 선택
    }
  }
  return out;
}
let news = [];
try { news = await lightCollect(); } catch { news = []; }
console.log(`이번 주 새 소식 수집: ${news.length}개 소스 확보 (core+로테이션)`);

// ===== codex exec 프롬프트 조립 =====
const chainArrow = chainTools.map((c) => c.name).join(" → ");
const chainBlock = chainTools.map((c, i) => {
  if (c.own) return `### ${i + 1}. ${c.name} [own]\n- 역할/설명: ${c.blurb}\n- 가격: ${c.price} · 플랫폼: ${c.platform} (외부 링크 없음)`;
  return `### ${i + 1}. ${c.name} [${c.id}]
- url: ${c.url}
- 가격(카탈로그): ${c.price}
- 플랫폼(카탈로그): ${c.platform}
- 한국 사용성: ${c.korea || "확인 필요"}
- blurb: ${c.blurb}
- 실무 접점(hook): ${c.hook || "(없음)"}
- 원문 발췌(grounding): ${c.source || "(원문 못 가져옴 — 카탈로그 값 기준, 가격·기능 단정 말고 '확인 필요')"}`;
}).join("\n\n");

const newsBlock = news.length
  ? news.map((n) => `### ${n.name} [tag:${n.tag}]\n${n.text}`).join("\n\n---\n\n")
  : "(수집된 새 소식 없음 — '이번 주 새 소식' 섹션은 정직하게 '잠잠'으로 처리)";

const prompt = `**중요 — 이 요청은 *채팅 응답* 형식입니다. 도구·검색·파일시스템 사용 금지. 응답은 한 덩어리 JSON만. 첫 글자부터 \`{\` 로 시작. 인사·보고문 금지.**

당신은 **한국 건축 현상설계 실무자를 위한 "AI 작업실" 큐레이터**입니다. 오늘(${dateStr}, ${dayOfWeek}요일) **주간 실전 레시피** 한 편을 작성하세요. 이건 매일 도구를 훑는 도감이 아니라, **한 주에 한 편 — 도구 여러 개를 엮어 산출물 하나를 끝까지 뽑는, 재현 가능한 단계별 워크플로우 가이드**입니다.

핵심 원칙(반드시 지킬 것):
- 이 회차는 **따라하기 가이드**입니다. 우리는 도구를 실제로 자동 실행하지 않았습니다. 그러니 **"생성했다/뽑았다"는 식으로 실재하지 않는 산출물·전후 이미지를 지어내지 마세요.** 단계는 "이렇게 하면 됩니다" 톤(따라하기), 결과 평가는 "이 워크플로우로 여기까지 나온다(예상)"로.
- 가격·플랫폼은 아래 도구 정보 그대로. 원문 grounding 과 카탈로그가 엇갈리면 보수적으로, 모르면 '확인 필요'.
- 과장·영업체 금지. 데모면 데모. 슬랭("박다"·"꽂다") 금지(공개 사이트).
- 해요체/합니다체. 건축 약어(렌더·매싱·다이어그램·플러그인·SD/DD) 그대로 OK. AI 약어(ControlNet·LoRA·diffusion·업스케일 등)는 처음 등장 시 짧은 비유 한 줄.

# 이번 주 레시피
- id: ${recipe.id}
- 제목: ${recipe.title}
- 결과물(deliverable): ${recipe.deliverable}
- 목표(goal): ${recipe.goal}
- 난이도(level): ${recipe.level}
- 실행성(runnable): ${recipe.runnable} (guide=따라하기 가이드 / blender=Blender로 실물 가능 / cad-jsx=자체 도구로 실물 가능 / local-sd=ComfyUI/SD 설치 필요, 미설치 동안은 가이드)
- 도구 체인: ${chainArrow}
- 단계 힌트(stepsHint): ${recipe.stepsHint}
- 함정(pitfalls): ${recipe.pitfalls}

# 도구 체인 정보 (가격·플랫폼·기능 grounding — 이 값으로만 단정)
${chainBlock}

# 이번 주 새 소식 후보 (가볍게 수집 — 진짜 새것만 골라 쓰고, 없으면 '잠잠')
${newsBlock}

# 출력 스키마 (이대로만, JSON 하나)
\`\`\`
{
  "title": "${dateStr} (${dayOfWeek}) — ${recipe.title}",
  "hero_title": "히어로 제목 — 레시피 제목을 짧고 강하게 (예: '라이노 모델만으로 <em>패널 배경 투시</em> 30분')",
  "description": "한 줄 소개(~90자) — 무엇을 만드는 레시피인지",
  "summary": "description 과 같거나 살짝 다듬은 한 줄 (회차 목록에 노출)",
  "flow": "이번 레시피 흐름 — 1문단. 무엇을 만드는가(결과물) + 도구 체인 한 줄(A → B → C) + 누구에게/언제. 비용·시간 정직한 한 줄.",
  "materials": [
    {
      "id": "체인 도구 id 그대로 (own:* 포함)",
      "name": "도구명 (own 이면 '${OWN_TOOLS["own:cad_to_ai_jsx"]?.label || "자체 도구"}' 식 라벨)",
      "url": "도구 url (own 이면 빈 문자열)",
      "role": "이 체인에서 이 도구가 맡는 역할 1~2문장",
      "points": ["가격 (도구 정보 그대로)", "플랫폼 (도구 정보 그대로)"]
    }
  ],
  "steps": [
    {
      "title": "단계 제목 (예: '라이노 뷰·카메라 고정')",
      "action": "구체적 행동 2~4문장. '라이노 뷰를 고정하고 Veras에서 시드를 잠근 뒤 3컷' 수준으로 구체적으로 — 'AI로 렌더한다' 같은 추상 금지. 아는 범위의 실제 설정·파라미터를 넣되 모르면 단정 말 것.",
      "time": "예상 시간 (예: '약 5분')",
      "tip": "실무 팁 한 줄"
    }
  ],
  "result": "결과 — 정직한 평가. 이 워크플로우 산출물이 실제로 패널/보고서/모델에 쓸 수준인지, 한계와 '여기까지만 믿어라'. 우리가 자동 실행한 게 아니라 따라하기 가이드라는 점을 분명히. 2~4문장.",
  "pitfalls": ["함정/주의 (recipe.pitfalls 확장)", "..."],
  "alternative": "더 싸거나 무료인 대안 경로 1~2문장 (예: Magnific 대신 무료 Upscayl, remove.bg 대신 로컬 SD 누끼).",
  "news": [
    { "title": "진짜 새 소식이면 제목", "url": "원본 링크", "note": "왜 볼 만한지 한 줄" }
  ],
  "outro": "맺음말 1~2문장. 담백하게."
}
\`\`\`

규칙:
- "steps" 는 **4~7개.** 따라하면 실제로 재현되게 충분히 구체적으로. 도구별 디테일은 위 grounding 에서 끌어오기.
- "materials" 는 체인 도구 **전부**(순서대로, own:* 포함). 가격·플랫폼은 위 도구 정보 그대로.
- "news" 는 위 '새 소식 후보'에서 *정말 새롭고 이 독자에게 의미 있는 것만* 0~N개. 억지로 채우지 말 것 — 없으면 빈 배열 []. (없으면 스크립트가 '잠잠'으로 처리)
- 지어내기 금지: 실재하지 않는 산출물·전후 이미지를 만들었다고 쓰지 말 것. 모르는 가격·기능은 '확인 필요'.`;

if (DRY_RUN) {
  process.stderr.write("=== DRY RUN — 선택된 레시피 ===\n");
  process.stderr.write(`${recipe.id} — ${recipe.title}\n`);
  process.stderr.write(`  결과물: ${recipe.deliverable} · 난이도: ${recipe.level} · 실행성: ${recipe.runnable}\n`);
  process.stderr.write(`  체인: ${chainArrow}\n`);
  process.stderr.write(`  grounding: ${groundedCount}/${chainTools.filter((c) => !c.own).length} 외부 도구 원문 확보, own 도구 ${chainTools.filter((c) => c.own).length}개\n`);
  process.stderr.write(`  이번 주 새 소식 수집: ${news.length}개 소스\n`);
  process.stderr.write(`\n=== 조립된 프롬프트 (${(Buffer.byteLength(prompt, "utf8") / 1024).toFixed(1)} KB) ===\n`);
  process.stderr.write(prompt + "\n");
  process.stderr.write(`\n=== DRY RUN 끝 — 파일 안 씀 ===\n`);
  process.exit(0);
}

// ===== codex exec 호출 (build-local 동일) =====
function callCodex(promptText) {
  return new Promise((resolve, reject) => {
    const args = ["exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only", "-c", `model_reasoning_effort=${CODEX_REASONING_EFFORT}`];
    if (CODEX_MODEL) args.push("--model", CODEX_MODEL);
    args.push("-");
    console.log(`codex exec (${CODEX_MODEL || "default"}, ${CODEX_REASONING_EFFORT}) 호출...`);
    const child = spawn(process.platform === "win32" ? "codex.cmd" : "codex", args, { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32", windowsHide: true });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("타임아웃 5분")); }, 5 * 60 * 1000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`codex exit ${code}`)); });
    child.stdin.write(promptText);
    child.stdin.end();
  });
}

const raw = await callCodex(prompt);
const jm = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/\{[\s\S]*\}/);
if (!jm) { console.error("JSON 미발견:", raw.slice(0, 600)); process.exit(1); }
let data;
try { data = JSON.parse(jm[1] ?? jm[0]); } catch (e) { console.error("파싱 실패:", e.message, "\n", raw.slice(0, 600)); process.exit(1); }

// ===== 시맨틱 HTML 렌더 (.ni 카드 — news·curation·trends 동일 폼) =====
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const codeSpans = (escaped) =>
  escaped
    .replace(/`([^`\n]+)`/g, (_m, c) => `<code class="ni__code">${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, b) => `<strong>${b}</strong>`);
const inlineEsc = (s) => codeSpans(esc(s));
// hero_title 은 모델이 <em> 을 의도적으로 넣으므로 그 태그만 살리고 나머진 escape.
const heroSafe = (s) => esc(s).replace(/&lt;em&gt;/g, "<em>").replace(/&lt;\/em&gt;/g, "</em>");

let n = 0;

// 2) 재료 카드 — 체인 도구
function renderMaterial(m) {
  n += 1;
  const num = String(n).padStart(2, "0");
  const points = (m.points || []).map((p) => `<li>${inlineEsc(p)}</li>`).join("");
  const url = String(m.url || "").trim();
  const titleHtml = /^https?:\/\//.test(url)
    ? `<a class="ni__t" href="${esc(url)}" target="_blank" rel="noopener">${esc(m.name)} <span class="ni__arrow">↗</span></a>`
    : `<span class="ni__t">${esc(m.name)}</span>`;
  return `<article class="ni reveal">
  <header class="ni__h">
    <span class="ni__n">${num}</span>
    ${titleHtml}
    <span class="ni__tr"><span class="ni__src">재료</span></span>
  </header>
  <p class="ni__body">${inlineEsc(m.role)}</p>
  ${points ? `<ul class="ni__pts">${points}</ul>` : ""}
</article>`;
}

// 3) 단계 카드 — ni__n = 단계번호
function renderStep(s, i) {
  const num = String(i + 1).padStart(2, "0");
  const time = String(s.time || "").trim();
  const tip = String(s.tip || "").trim();
  return `<article class="ni reveal">
  <header class="ni__h">
    <span class="ni__n">${num}</span>
    <span class="ni__t">${esc(s.title)}</span>
    ${time ? `<span class="ni__tr"><span class="ni__score">${esc(time)}</span></span>` : ""}
  </header>
  <p class="ni__body">${inlineEsc(s.action)}</p>
  ${tip ? `<div class="ni__meta"><div class="ni__row ni__row--do"><dt>팁</dt><dd class="ni__do-text">${inlineEsc(tip)}</dd></div></div>` : ""}
</article>`;
}

const materials = Array.isArray(data.materials) ? data.materials : [];
const steps = Array.isArray(data.steps) ? data.steps : [];
const pitfalls = Array.isArray(data.pitfalls) ? data.pitfalls : [];
const newsItems = Array.isArray(data.news) ? data.news.filter((x) => x && x.title && /^https?:\/\//.test(String(x.url || ""))) : [];

// 4) 결과 카드 (단일 .ni) — ARTIFACT 있으면 <img> 주입, 없으면 따라하기 가이드 명시
let artHtml = "";
if (ARTIFACT) {
  let ok = false;
  try { await access(ARTIFACT); ok = true; } catch { console.warn(`ARTIFACT 경로 접근 불가: ${ARTIFACT} — 이미지 생략`); }
  if (ok) artHtml = `\n  <img class="ni__art" src="${esc(ARTIFACT)}" alt="레시피 산출물 예시">`;
}
const resultBody = inlineEsc(data.result || "");
const resultCard = `<article class="ni reveal">
  <header class="ni__h">
    <span class="ni__n">★</span>
    <span class="ni__t">결과 — 정직한 평가</span>
    <span class="ni__tr"><span class="ni__src">${ARTIFACT && artHtml ? "산출물" : "따라하기 가이드"}</span></span>
  </header>
  <p class="ni__body">${resultBody}</p>${artHtml}
</article>`;

// 5) 함정·대안 카드
const pitfallsList = pitfalls.map((p) => `<li>${inlineEsc(p)}</li>`).join("");
const altHtml = data.alternative ? `<div class="ni__meta"><div class="ni__row ni__row--do"><dt>대안</dt><dd class="ni__do-text">${inlineEsc(data.alternative)}</dd></div></div>` : "";
const pitfallCard = `<article class="ni reveal">
  <header class="ni__h">
    <span class="ni__n">!</span>
    <span class="ni__t">함정 · 대안</span>
  </header>
  ${pitfallsList ? `<ul class="ni__pts">${pitfallsList}</ul>` : ""}
  ${altHtml}
</article>`;

// 6) 이번 주 새 소식
const newsCards = newsItems.length
  ? newsItems.map((it) => `<article class="ni reveal">
  <header class="ni__h">
    <a class="ni__t" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)} <span class="ni__arrow">↗</span></a>
  </header>
  <p class="ni__body">${inlineEsc(it.note || "")}</p>
</article>`).join("\n")
  : `<div class="news-flow"><p>이번 주 새 도구·업데이트는 잠잠합니다. 레시피로 채웁니다.</p></div>`;

// ===== 본문 조립 =====
const flowHtml = data.flow
  ? `<section class="news-flow-sec reveal"><h2 class="news-flow__t">이번 레시피 흐름</h2><div class="news-flow"><p>${inlineEsc(data.flow)}</p></div></section>\n`
  : "";

const materialsHtml = materials.length
  ? `<section class="news-sec">\n<h2 class="news-sec__t">재료 — 쓰는 도구</h2>\n${materials.map(renderMaterial).join("\n")}\n</section>\n`
  : "";

const stepsHtml = steps.length
  ? `<section class="news-sec">\n<h2 class="news-sec__t">단계</h2>\n${steps.map(renderStep).join("\n")}\n</section>\n`
  : "";

const resultHtml = `<section class="news-sec">\n<h2 class="news-sec__t">결과 — 정직한 평가</h2>\n${resultCard}\n</section>\n`;
const pitfallHtml = `<section class="news-sec">\n<h2 class="news-sec__t">함정 · 대안</h2>\n${pitfallCard}\n</section>\n`;
const newsHtml = `<section class="news-flow-sec reveal">\n<h2 class="news-flow__t">이번 주 새 소식</h2>\n${newsCards}\n</section>\n`;
const outroHtml = data.outro ? `<div class="news-outro"><span class="news-outro__t">맺음말</span><p>${inlineEsc(data.outro)}</p></div>\n` : "";

const note = String(data.description || recipe.goal || "").replaceAll('"', "'").trim();
const summary = String(data.summary || note).replaceAll('"', "'").trim();
const heroTitle = String(data.hero_title || recipe.title).trim();
const titleLine = String(data.title || `${dateStr} (${dayOfWeek}) — ${recipe.title}`).replaceAll('"', "'").trim();

const md = `---
title: ${titleLine}
eyebrow: STUDIO · 주간 실전 레시피
hero_title: "${heroSafe(heroTitle).replaceAll('"', "'")}"
description: "${note}"
summary: ${summary}
recipe_id: ${recipe.id}
---

<div class="news">
${flowHtml}${materialsHtml}${stepsHtml}${resultHtml}${pitfallHtml}${newsHtml}${outroHtml}</div>
`;

await writeFile(`${slug}.md`, md);
console.log(`${slug}.md 저장 — 레시피 ${recipe.id} · 단계 ${steps.length}개 · 재료 ${materials.length}개 · 새 소식 ${newsItems.length}개`);
console.log(`완료: recipe_id=${recipe.id} → ${slug}.md`);
