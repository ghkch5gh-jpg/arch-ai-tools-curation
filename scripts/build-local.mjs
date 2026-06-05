#!/usr/bin/env node
// 로컬 생성기 — 수집 → claude -p (정액제) → 회차 .md(시맨틱 HTML) → index.md.
// 도메인: 현상설계 실무 AI 도구·기법 "AI 작업실" 일일 큐레이션 (당선 /studio).
// 레이아웃·말투는 dangsun /news·/curation·/trends 와 동일한 .ni 카드. 파이프라인 단계별 섹션.
//   DRY_RUN=1 : 수집+프롬프트만   FORCE=1 : 오늘 회차 강제 재생성   CLAUDE_MODEL=opus
import { readFile, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const DRY_RUN = process.env.DRY_RUN === "1";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "sonnet";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

const sources = JSON.parse(await readFile("scripts/sources.json", "utf8"));

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const sinceIso = yesterday.toISOString().slice(0, 10);
const sinceTs = Math.floor(yesterday.getTime() / 1000);

const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
const dateStr = kst.toISOString().slice(0, 10);
const dayOfWeek = ["일", "월", "화", "수", "목", "금", "토"][kst.getUTCDay()];
const slug = `${dateStr}_${dayOfWeek}`;

const existing = (await readdir(".")).filter((f) => f === `${slug}.md`);
if (existing.length && process.env.FORCE !== "1") {
  console.log(`${slug}.md 이미 존재 — 종료 (FORCE=1로 강제 재생성)`);
  process.exit(0);
}

async function fetchWithRetry(url, { headers = {}, attempts = 3, baseDelayMs = 800 } = {}) {
  const mergedHeaders = {
    "User-Agent": "Mozilla/5.0 (compatible; ArchAIToolsBot/1.0; +https://www.dangsun.kr)",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
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

// RSS/Atom 공통 파서
function parseFeed(xml, max = 25) {
  const clean = (s) => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
  const blocks = xml.split(/<entry[\s>]|<item[\s>]/i).slice(1, max + 1);
  return blocks
    .map((b) => {
      const title = clean((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
      let link = (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1];
      if (!link) link = clean((b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]);
      const date = ((b.match(/<(updated|pubDate|published|dc:date)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2] || "").slice(0, 10);
      const desc = clean((b.match(/<(description|summary)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2] || "").slice(0, 200);
      if (!title) return "";
      return `- ${title} (${(link || "").trim()})${date ? ` · ${date}` : ""}${desc ? `\n  ${desc}` : ""}`;
    })
    .filter(Boolean)
    .join("\n");
}

async function fetchSource(s) {
  try {
    let url = s.url.replaceAll("__SINCE__", sinceIso).replaceAll("__SINCE_TS__", String(sinceTs));
    const headers = {};
    if (GITHUB_TOKEN && /api\.github\.com/.test(url)) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

    const res = await fetchWithRetry(url, { headers });
    if (s.kind === "rss") return { ...s, text: parseFeed(await res.text(), 25).slice(0, 9000), ok: true };
    if (s.kind === "json") return { ...s, text: JSON.stringify(await res.json()).slice(0, 9000), ok: true };
    return { ...s, text: stripHtml(await res.text(), url).slice(0, 9000), ok: true };
  } catch (err) {
    console.warn(`수집 실패 ${s.name}: ${err.message}`);
    return { ...s, text: "", ok: false };
  }
}

console.log(`소스 ${sources.length}개 fetch 시작...`);
const fetched = await Promise.all(sources.map(fetchSource));
const okSources = fetched.filter((f) => f.ok && f.text);
console.log(`성공: ${okSources.length}/${sources.length}`);
if (okSources.length === 0) {
  console.error("모든 소스 fetch 실패");
  process.exit(1);
}

const allMd = (await readdir(".")).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f) && f !== `${slug}.md`);
const priorFiles = allMd.sort().reverse().slice(0, 2);
const priorUrls = new Set();
for (const f of priorFiles) {
  for (const m of (await readFile(f, "utf8")).matchAll(/href="(https?:\/\/[^"]+)"/g)) priorUrls.add(m[1]);
}

const SPEC = await readFile("CURATION_SPEC.md", "utf8");

// 도구 카탈로그 — 도감 프레임의 우물. 직전 2회차에서 다룬 url은 제외해 자연 로테이션.
let CATALOG = [];
try {
  CATALOG = JSON.parse(await readFile("scripts/tools-catalog.json", "utf8")).tools || [];
} catch (e) {
  console.warn(`tools-catalog.json 로드 실패: ${e.message} — 카탈로그 없이 진행`);
}
const catalogFresh = CATALOG.filter((t) => !priorUrls.has(t.url));
const catalogText = (catalogFresh.length ? catalogFresh : CATALOG)
  .map((t) => `- [${t.stage}] ${t.name} — ${t.blurb} (${t.url})`)
  .join("\n");

const prompt = `**중요 — 이 요청은 *채팅 응답* 형식입니다. 도구·검색·파일시스템 사용 금지. 응답은 한 덩어리 JSON만. 첫 글자부터 \`{\` 로 시작. 인사·보고문 금지.**

당신은 **한국 건축 현상설계 실무자를 위한 "AI 작업실" 큐레이터**입니다. 오늘(${dateStr}, ${dayOfWeek}요일) 회차를 작성하세요. 이건 *오늘의 뉴스*가 아니라 **실무 도구 도감**입니다 — 아래 '도구 카탈로그'에서 *오늘 소개할 도구를 골라*, 현상설계 산출물에 실제로 어떻게 써먹는지 실무 각도로 풀어 쓰세요. 그날 수집 소스에 *새로 뜬* 도구·기법·업데이트가 있으면 우선 배치하고, 나머지는 카탈로그에서 채워 **매일 충실한 한 호**를 만듭니다. *연구 논문·코드 모델·일반 전망이 아니라*, 컨셉·다이어그램·매싱·라이노/GH·도면·렌더/CG·패널·보고서를 **더 빨리·낫게 뽑게 해주는 도구**만.

# 명세
${SPEC}

# 도구 카탈로그 (오늘 소개 후보 — 직전 회차에서 다룬 건 이미 빠짐. 여기서 골라 스포트라이트)
${catalogText || "(카탈로그 비어있음 — 수집 소스로만)"}

규칙: 카탈로그 도구를 소개할 땐 url을 그 도구 사이트로(위 괄호 url). 카탈로그에 없어도 수집 소스의 신규 도구면 추가. body·가격·기능은 *아는 범위에서 정확히*, 모르면 단정 말고 '확인 필요'로.

# 말투 (이 톤을 그대로 따라하세요 — 레퍼런스 2개)

[예시 A — 비주얼(렌더) 도구]
본문: "Veras는 라이노·스케치업·레빗 화면을 그대로 받아 AI 렌더로 바꿔주는 플러그인입니다. 매스 모델만 있어도 '목조·벽돌·유리' 같은 한 줄 프롬프트로 분위기 렌더를 뽑아, 컨셉 단계 패널 배경을 분 단위로 채울 때 씁니다. 미드저니와 달리 내 모델 형상을 유지한다는 게 핵심입니다."
한줄평: "컨셉 패널·초기 투시 배경엔 바로 써먹힘. 다만 최종 제출용 정밀 렌더는 아직 손봐야 함 — 분위기용."
써먹기: "라이노 뷰포트 잡고 → Veras로 재질·시간대 프롬프트 → 패널 배경 렌더 5분. 일러 반입 전 Magnific으로 업스케일하면 인쇄 해상도까지."
성숙도: "정식 플러그인(Rhino/SketchUp/Revit), 구독제(무료 체험 있음). 렌더 단계에서 지금 가장 검증된 축."

[예시 B — 모델링/그래스호퍼]
본문: "그래스호퍼용 신규 정의가 Food4Rhino에 올라왔습니다. 대지 경계와 법규 높이를 넣으면 가능 매스 볼륨을 자동으로 빼주는 스크립트로, 현상 초기 '얼마나 앉힐 수 있나' 검토를 수동 모델링 없이 돌립니다. 테스트핏·Forma의 가벼운 무료판 느낌입니다."
한줄평: "초기 매싱 스터디 자동화엔 유용. 단 한국 건축법 직결은 아니라 용적·높이는 직접 넣어야 함."
써먹기: "GH에 정의 불러와 대지 polyline + 높이 제한 입력 → 매스 옵션 여러 개 자동 생성 → 라이노로 구워 다이어그램화. 배치 대안 빠르게 비교할 때."
성숙도: "무료 GH 정의(Rhino 7+). 베타 수준이지만 초기 검토엔 충분."

→ 해요체/합니다체 섞어 간결하게. 과장·영업체 금지. '한줄평'은 *써먹히나/데모인가/누구에게*를 정직하게, '써먹기'는 현상설계 *어느 산출물에 어떻게* 투입하는지 구체적으로(가능하면 시작 방법·링크), '성숙도'는 정식/베타/연구 데모 + 가격(무료/유료) + 왜 지금.

**누구나 이해하게:** 실무자가 1초 만에 "이걸 내 다음 작업에 쓸까 말까"를 판단하게 쓰세요. 건축 약어(렌더·매싱·다이어그램·플러그인·SD/DD) 그대로 OK. AI 약어(ControlNet·LoRA·diffusion 등)는 처음 등장 시 짧은 비유 한 줄. 가격·플랫폼·성숙도는 빠짐없이.

# 수집된 소스 (${okSources.length}개) — 여기 등장한 것만 사용, URL도 여기서만
${okSources.map((f) => `### ${f.name} [tag:${f.tag}]\n${f.text}`).join("\n\n---\n\n")}

# 직전 회차 URL (중복 금지)
${[...priorUrls].slice(0, 50).map((u) => `- ${u}`).join("\n") || "(없음)"}

# 출력 스키마 (이대로만)
\`\`\`
{
  "edition_note": "오늘 호 한 줄 소개 (~90자) — 어떤 단계/도구가 눈에 띄었는지",
  "intro": "맨 처음 흐름 요약 — '오늘은' 으로 시작. 쉽고 자연스러운 한국어 3~5문장. 오늘 다룬 도구들을 관통하는 묶음(렌더 도구를 모았다/모델링 자동화 위주 등). 그날 신규 업데이트가 있으면 그걸 앞세워 언급.",
  "outro": "맺음말 — 오늘 묶음을 한 발 물러나 본 소회 2~3문장. 담백하게.",
  "items": [
    {
      "section": "pick | concept | modeling | visual | panel | technique",
      "title": "도구·기법명 — 한국어 보조설명 곁들여 (예: 'Veras — 라이노 화면을 AI 렌더로')",
      "url": "도구 사이트 url(카탈로그) 또는 수집 소스의 원본 링크",
      "source": "출처태그. 카탈로그 도구면 \\"catalog\\". 수집 소스면 그 tag: mcneel | reddit-rhino | reddit-gh | reddit-arch | reddit-sd | parametricmonkey | archdaily | hn-render | hn-cad | arxiv-gr | d5 | evolvelab | shapediver",
      "score": 1-10 정수 (실무 투입 가능성 — 명세 3절 기준),
      "body": "본문 정확히 3~4문장 — 무슨 도구·기법이고 현상설계 어느 단계에 닿는지, 비슷한 도구에 빗대 한 줄",
      "points": ["가격·플랫폼 (예: 구독제 · Rhino/SketchUp 플러그인)", "입력→출력 (예: 매스 모델 → 분위기 렌더)", "(선택) 한계·주의 (예: 정밀 렌더는 아직)"],
      "gain": "한줄평 — 써먹히나/데모인가/누구에게 1~2문장. 정직하게.",
      "todo": "써먹기 — 현상설계 어느 산출물에 어떻게 투입하는지 구체적으로 1~2문장 (가능하면 시작 방법·링크)",
      "why_now": "성숙도 — 정식/베타/연구 데모 + 가격 + 왜 지금 1~2문장"
    }
  ]
}
\`\`\`

분량·분류 규칙:
- section "pick": **오늘 가장 주목할 1~3개** (단계 무관, 실무 투입 톱 — 신규 업데이트가 있으면 거기 우선). 나머지 섹션과 중복 금지.
- "concept"(컨셉·다이어그램) / "modeling"(라이노·GH·CAD) / "visual"(렌더·CG·이미지) / "panel"(패널·보고서) / "technique"(따라 할 워크플로우). 단계 골고루.
- 전체 **7~10개로 충실하게.** 도감이라 카탈로그에서 채워 매일 풍부해야 함 — *마른 날 없음*. 단 지어내기·과장은 금지(모르는 가격·기능은 '확인 필요'). 같은 도구를 직전 회차와 중복하지 말 것(카탈로그를 로테이션). 연구 논문·코드 모델만, 일반 전망·벤더 실적뉴스, 시공/부동산/BIM운영, 코딩 일반 도구는 제외.`;

console.log(`Prompt: ${(Buffer.byteLength(prompt, "utf8") / 1024).toFixed(1)} KB`);
if (DRY_RUN) {
  console.log("=== DRY RUN ===\n" + prompt.slice(0, 2800) + `\n...(전체 ${prompt.length}자)`);
  process.exit(0);
}

function callClaude(promptText) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text", "--allowedTools", "", "--model", CLAUDE_MODEL];
    console.log(`claude -p (${CLAUDE_MODEL}) 호출...`);
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "inherit"], shell: true });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("타임아웃 5분")); }, 5 * 60 * 1000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`claude exit ${code}`)); });
    child.stdin.write(promptText);
    child.stdin.end();
  });
}

const raw = await callClaude(prompt);
const jm = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/\{[\s\S]*\}/);
if (!jm) { console.error("JSON 미발견:", raw.slice(0, 600)); process.exit(1); }
let data;
try { data = JSON.parse(jm[1] ?? jm[0]); } catch (e) { console.error("파싱 실패:", e.message, "\n", raw.slice(0, 600)); process.exit(1); }

// ===== 가벼운 검증: 선택 항목의 원문을 실제로 fetch 해서 가격·기능·플랫폼 대조·정정 =====
async function verifyItems(items) {
  if (!items.length) return items;
  console.log(`검증: ${items.length}개 항목 원문 fetch...`);
  const withSrc = await Promise.all(items.map(async (it) => {
    if (!/^https?:\/\//.test(it.url || "")) return { it, src: "" };
    try {
      const res = await fetchWithRetry(it.url, { attempts: 2, baseDelayMs: 500 });
      const ct = res.headers.get("content-type") || "";
      if (!/text|html|json|xml/i.test(ct)) return { it, src: "" };
      return { it, src: stripHtml(await res.text(), it.url).slice(0, 2200) };
    } catch { return { it, src: "" }; }
  }));
  const fetchedCount = withSrc.filter((x) => x.src).length;
  console.log(`  원문 확보: ${fetchedCount}/${items.length}`);
  if (!fetchedCount) return items.map((it) => ({ ...it, verified: false }));

  const payload = withSrc.map((x, i) => ({
    idx: i, title: x.it.title, body: x.it.body, gain: x.it.gain, todo: x.it.todo, why_now: x.it.why_now,
    source_excerpt: x.src || "(원문 못 가져옴)",
  }));
  const vPrompt = `**채팅 응답. 도구·검색 금지. 응답은 JSON 배열 하나만, 첫 글자 [ 로 시작.**
당신은 건축 AI 도구 팩트체커입니다. 각 항목은 [작성된 요약(body/gain/todo/why_now)] + [원문 발췌(source_excerpt)]. 원문에 비춰:
- 원문에 근거하면 그대로(작은 표현만 다듬기), 원문에 없는 사실·과장(가격/플랫폼/기능/성숙도 오류, 데모를 정식처럼 과장 등)은 원문 기준으로 정정.
- source_excerpt 가 "(원문 못 가져옴)" 이면 검증 불가 → 손대지 말고 verified=false.
- 한국어·기존 말투 유지. 건축 약어 유지.
각 항목 반환: { "idx": 정수, "body": "...", "gain": "...", "todo": "...", "why_now": "...", "verified": true/false, "note": "정정했으면 한 줄, 없으면 빈 문자열" }

# 항목
${JSON.stringify(payload)}

# 출력 (JSON 배열만)`;
  let vraw;
  try { vraw = await callClaude(vPrompt); }
  catch (e) { console.warn(`검증 호출 실패: ${e.message} — 원본 유지`); return items.map((it) => ({ ...it, verified: false })); }
  const vm = vraw.match(/```json\s*([\s\S]*?)\s*```/) || vraw.match(/\[[\s\S]*\]/);
  if (!vm) { console.warn("검증 JSON 미발견 — 원본 유지"); return items.map((it) => ({ ...it, verified: false })); }
  let verdicts;
  try { verdicts = JSON.parse(vm[1] ?? vm[0]); } catch { console.warn("검증 파싱 실패 — 원본 유지"); return items.map((it) => ({ ...it, verified: false })); }
  const byIdx = new Map(verdicts.map((v) => [v.idx, v]));
  let okCount = 0, fixCount = 0;
  const out = items.map((it, i) => {
    const v = byIdx.get(i);
    if (!v) return { ...it, verified: false };
    if (v.body && v.body !== it.body) fixCount++;
    if (v.verified) okCount++;
    return {
      ...it,
      body: v.body || it.body,
      gain: v.gain || it.gain,
      todo: v.todo || it.todo,
      why_now: v.why_now || it.why_now,
      verified: !!v.verified,
    };
  });
  console.log(`  검증 완료: 대조통과 ${okCount} · 정정 ${fixCount}`);
  return out;
}
data.items = await verifyItems(Array.isArray(data.items) ? data.items : []);

// ===== 시맨틱 HTML 렌더 (.ni 카드 — news·curation·trends 와 동일 폼) =====
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SECTIONS = [
  ["pick", "오늘 눈에 띈 것"],
  ["concept", "컨셉 · 다이어그램"],
  ["modeling", "모델링 · 라이노/GH/CAD"],
  ["visual", "렌더 · CG · 이미지"],
  ["panel", "패널 · 보고서"],
  ["technique", "기법 · 워크플로우"],
];
const SRC_LABEL = {
  mcneel: "McNeel", "reddit-rhino": "r/rhino", "reddit-gh": "r/grasshopper3d",
  "reddit-arch": "r/architecture", "reddit-sd": "r/StableDiffusion",
  parametricmonkey: "Parametric Monkey", archdaily: "ArchDaily",
  "hn-render": "Hacker News", "hn-cad": "Hacker News", "arxiv-gr": "arXiv",
  catalog: "도감", d5: "D5 Render", evolvelab: "EvolveLAB", shapediver: "ShapeDiver",
};
const isCmd = (s) => /(^\$|pip install|npm |npx |git clone|brew |docker|curl |uv |cargo |huggingface-cli|conda )/i.test(String(s || "").trim());
const HANGUL = /[가-힣]/;
const isPureCmd = (s) => isCmd(s) && !HANGUL.test(s.replace(/^\$\s*/, ""));
const CMD_TOKENS = "pipx|pip|npm|npx|pnpm|yarn|git|brew|docker|curl|wget|uvx|uv|cargo|conda|ollama|huggingface-cli|python3|python|node";
const CMD_RUN_RE = new RegExp(`(^|\\s)((?:${CMD_TOKENS})(?=\\s|$)[^\\uAC00-\\uD7A3\\n]*)`, "g");
const highlightCmds = (escaped) =>
  escaped.replace(CMD_RUN_RE, (_m, lead, run) => {
    const trail = run.match(/\s*$/)[0];
    return `${lead}<code class="ni__code">${run.slice(0, run.length - trail.length)}</code>${trail}`;
  });
const codeSpans = (escaped) =>
  escaped
    .replace(/`([^`\n]+)`/g, (_m, c) => `<code class="ni__code">${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, b) => `<strong>${b}</strong>`);
const inlineEsc = (s) => codeSpans(esc(s));
const todoProse = (s) => highlightCmds(codeSpans(esc(s)));
const stripBackticks = (s) => s.replace(/`/g, "");

const items = Array.isArray(data.items) ? data.items : [];
let n = 0;
function renderItem(it) {
  n += 1;
  const num = String(n).padStart(2, "0");
  const todo = String(it.todo || "").trim();
  const todoHtml = isPureCmd(todo)
    ? `<pre class="ni__cmd"><code>${esc(stripBackticks(todo).replace(/^\$\s*/, ""))}</code></pre>`
    : `<p class="ni__do-text">${todoProse(todo)}</p>`;
  const points = (it.points || []).map((p) => `<li>${inlineEsc(p)}</li>`).join("");
  const src = SRC_LABEL[it.source] || esc(it.source || "");
  const score = Number.isFinite(+it.score) ? `${+it.score}/10` : "";
  return `<article class="ni reveal">
  <header class="ni__h">
    <span class="ni__n">${num}</span>
    <a class="ni__t" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)} <span class="ni__arrow">↗</span></a>
    <span class="ni__tr">${src ? `<span class="ni__src">${src}</span>` : ""}${score ? `<span class="ni__score">${score}</span>` : ""}</span>
  </header>
  <p class="ni__body">${inlineEsc(it.body)}</p>
  ${points ? `<ul class="ni__pts">${points}</ul>` : ""}
  <div class="ni__meta">
    <div class="ni__row"><dt>한줄평</dt><dd>${inlineEsc(it.gain)}</dd></div>
    <div class="ni__row ni__row--do"><dt>써먹기</dt><dd>${todoHtml}</dd></div>
    <div class="ni__row ni__row--why"><dt>성숙도</dt><dd>${inlineEsc(it.why_now)}</dd></div>
  </div>
  <footer class="ni__f"><span class="ni__verified">${it.verified ? "✓ 원문 대조" : ""}</span><a class="ni__story" href="${esc(it.url)}" target="_blank" rel="noopener">도구 보기 →</a></footer>
</article>`;
}

let bodyHtml = "";
let total = 0;
for (const [key, label] of SECTIONS) {
  const secItems = items.filter((it) => it.section === key);
  if (!secItems.length) continue;
  total += secItems.length;
  bodyHtml += `<section class="news-sec">\n<h2 class="news-sec__t">${label}</h2>\n${secItems.map(renderItem).join("\n")}\n</section>\n`;
}
const orphans = items.filter((it) => !SECTIONS.some(([k]) => k === it.section));
if (orphans.length) {
  bodyHtml += `<section class="news-sec">\n<h2 class="news-sec__t">그 외</h2>\n${orphans.map(renderItem).join("\n")}\n</section>\n`;
  total += orphans.length;
}

const note = String(data.edition_note || "").replaceAll('"', "'").trim();
const introHtml = data.intro ? `<section class="news-flow-sec reveal"><h2 class="news-flow__t">이번 회차 흐름</h2><div class="news-flow"><p>${inlineEsc(data.intro)}</p></div></section>\n` : "";
const outroHtml = data.outro ? `<div class="news-outro"><span class="news-outro__t">맺음말</span><p>${inlineEsc(data.outro)}</p></div>\n` : "";
const md = `---
title: ${dateStr} (${dayOfWeek}) — AI 작업실
eyebrow: STUDIO · AI TOOLS DAILY
hero_title: "${dateStr.replaceAll("-", " · ")} <em>(${dayOfWeek})</em>"
description: "${note}"
summary: ${note}
---

<div class="news">
${introHtml}${bodyHtml}${outroHtml}</div>
`;

await writeFile(`${slug}.md`, md);
console.log(`${slug}.md 저장 — 항목 ${total}개`);

// ===== index.md 재생성 =====
const files = (await readdir(".")).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f)).sort().reverse();
async function readSummaryOf(file) {
  try {
    const fm = (await readFile(file, "utf8")).replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return "";
    const s = fm[1].match(/^summary:\s*(.+)$/m);
    if (s) return s[1].trim();
    const d = fm[1].match(/^description:\s*"?(.+?)"?$/m);
    return d ? d[1].trim() : "";
  } catch { return ""; }
}
const entries = await Promise.all(files.map(async (f) => {
  const slugOnly = f.replace(".md", "");
  const summary = await readSummaryOf(f);
  const mm = slugOnly.match(/^(\d{4}-\d{2}-\d{2})_(.+)$/);
  const label = mm ? `${mm[1]} (${mm[2]})` : slugOnly;
  return summary ? `- [${label} — ${summary}](${slugOnly}.html)` : `- [${label}](${slugOnly}.html)`;
}));

const indexMd = `---
title: AI 작업실
eyebrow: STUDIO · AI TOOLS DAILY
hero_title: "현상설계 <em>AI 작업실</em>"
description: 매일, 현상설계 결과물(컨셉·다이어그램·매싱·라이노/GH·렌더·패널·보고서)을 실제로 더 빨리·낫게 뽑게 해주는 AI 도구·기법만 골라 정리합니다. 데모는 데모라고, 써먹히면 써먹힌다고.
stats:
  - num: "매일"
    lbl: "Daily"
  - num: "${sources.length}"
    lbl: "Sources"
  - num: "6"
    lbl: "Stages"
  - num: "${files.length}"
    lbl: "회차"
---

## 회차 목록

${entries.join("\n")}
{:.episode-list}

*매일 새 회차가 자동으로 추가됩니다.*

## 각 회차 구성

- **오늘 눈에 띈 것** — 그날 실무 투입 톱 1~3
- **컨셉·다이어그램 / 모델링(라이노·GH·CAD) / 렌더·CG·이미지 / 패널·보고서 / 기법·워크플로우**
- 항목마다 *한줄평 · 써먹기 · 성숙도* + 실무 투입 가능성 점수

## 이 큐레이션은

매일 **McNeel · Reddit(r/rhino·r/grasshopper3d·r/architecture·r/StableDiffusion) · Parametric Monkey · ArchDaily · Hacker News · arXiv** 를 자동으로 돌며, 현상설계 산출물에 실제로 써먹을 수 있는 AI 도구·기법만 골라 정리합니다. 연구 논문·코드 모델만 있는 것(→ AI in Architecture), 일반 전망·벤더 뉴스는 제외합니다. Claude Code 구독으로 로컬 생성하므로 별도 API 비용이 없습니다.
`;

await writeFile("index.md", indexMd);
console.log(`index.md 갱신 (${files.length}회차)`);
