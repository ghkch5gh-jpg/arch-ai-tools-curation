#!/usr/bin/env node
// 도감 생성기 — scripts/tools-catalog.json(보강 카탈로그) → index.md 본문(단계별 .ni 도구 카드).
// /studio 랜딩이 이 index.md 본문을 "도구 도감"으로 렌더한다(영구 레퍼런스). 매일 새로 만들지 않음 —
// 카탈로그(가격·플랫폼·성숙도·파이프라인 hook)가 바뀔 때만 이 스크립트를 다시 돌린다.
//
//   node scripts/build-directory.mjs        # index.md 갱신
//   node scripts/build-directory.mjs --dry  # stdout 미리보기, 파일 안 씀
//
// 카드 스타일은 사이트의 기존 .ni CSS(news.css)를 그대로 재사용 — 새 CSS 불필요.
import { readFile, writeFile } from "node:fs/promises";

const DRY = process.argv.includes("--dry");

const catalog = JSON.parse(await readFile("scripts/tools-catalog.json", "utf8"));
const tools = catalog.tools || [];

// 단계 순서·한국어 라벨·아이콘(이모지 대신 짧은 기호 — 톤 유지)
const STAGES = [
  { key: "concept", label: "컨셉 · 다이어그램", desc: "대지·매싱·평면 대안을 자동으로 깔아보는 초기 검토 도구." },
  { key: "modeling", label: "모델링 · 라이노/GH/CAD", desc: "파라메트릭·환경분석·도면 자동화. 본 모델링 단계에 붙는 것들." },
  { key: "visual", label: "렌더 · CG · 이미지", desc: "뷰포트 AI 렌더부터 이미지 생성·업스케일까지, 비주얼 라인." },
  { key: "panel", label: "패널 · 보고서", desc: "누끼·벡터화·업스케일·레이아웃 — 패널 출력 직전 마무리." },
  { key: "technique", label: "기법 · 워크플로우", desc: "도구를 엮어 쓰는 실전 레시피(주간 회차에서 더 깊게 다룸)." },
];

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// 성숙도 → 짧은 배지 텍스트
const maturityBadge = (m) => {
  const v = String(m || "").trim();
  if (v.startsWith("정식")) return "정식";
  if (v.startsWith("베타")) return "베타";
  if (v.includes("연구") || v.includes("데모")) return "데모";
  return "확인필요";
};

function toolCard(t, n) {
  const stageKr = (STAGES.find((s) => s.key === t.stage) || {}).label || t.stage;
  const num = String(n).padStart(2, "0");
  const pts = [];
  if (t.price) pts.push(`<li>${esc(t.price)}</li>`);
  if (t.platform) pts.push(`<li>${esc(t.platform)}</li>`);
  if (t.korea && t.korea !== "확인 필요") pts.push(`<li>한국: ${esc(t.korea)}</li>`);
  const verified = t.verified
    ? `<span class="ni__verified">✓ 원문 대조</span>`
    : `<span class="ni__verified ni__verified--soft">○ 검색 기반</span>`;
  return `<article class="ni reveal">
  <header class="ni__h">
    <span class="ni__n">${num}</span>
    <a class="ni__t" href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)} <span class="ni__arrow">↗</span></a>
    <span class="ni__tr"><span class="ni__src">${esc(stageKr)}</span><span class="ni__score">${esc(maturityBadge(t.maturity))}</span></span>
  </header>
  <p class="ni__body">${esc(t.blurb)}</p>
  <ul class="ni__pts">${pts.join("")}</ul>
  <div class="ni__meta">
    <div class="ni__row ni__row--do"><dt>써먹기</dt><dd><p class="ni__do-text">${esc(t.hook)}</p></dd></div>
  </div>
  <footer class="ni__f">${verified}<a class="ni__story" href="${esc(t.url)}" target="_blank" rel="noopener">도구 보기 →</a></footer>
</article>`;
}

let n = 0;
const sections = [];
for (const stage of STAGES) {
  const group = tools.filter((t) => t.stage === stage.key);
  if (!group.length) continue;
  const cards = group.map((t) => toolCard(t, ++n)).join("\n");
  sections.push(`<section class="news-sec">
<h2 class="news-sec__t">${esc(stage.label)}</h2>
<p class="news-sec__lead">${esc(stage.desc)}</p>
${cards}
</section>`);
}

const verifiedCount = tools.filter((t) => t.verified).length;
const stageCount = STAGES.filter((s) => tools.some((t) => t.stage === s.key)).length;

const intro = `<section class="news-flow-sec reveal"><h2 class="news-flow__t">이 도감은</h2><div class="news-flow"><p>현상설계 산출물 — 컨셉·다이어그램 / 매싱 / 라이노·GH 모델 / 도면 / 렌더·CG / 패널 / 보고서 — 을 실제로 더 빨리·낫게 뽑게 해주는 AI·디지털 도구만 단계별로 모은 <strong>실무 도구 도감</strong>입니다. 가격·플랫폼·한국 사용성·성숙도를 빠짐없이 적고, 모르면 "확인 필요"로 둡니다. 데모면 데모, 별로면 별로라고 씁니다. 각 카드의 <strong>써먹기</strong>는 그 도구가 당신 파이프라인(AutoCAD·Illustrator·Rhino·Grasshopper·렌더·패널)에 어디서 붙는지를 짚습니다. <strong>매주 한 번</strong>, 이 도구들을 엮은 <strong>실전 레시피</strong>(실제로 돌려본 워크플로우 + 결과물)를 새 회차로 올립니다 — 위 ⭐에서 최신 레시피로.</p></div></section>`;

const body = `<div class="news">
${intro}
${sections.join("\n")}
<section class="news-flow-sec reveal"><div class="news-flow"><p class="news-foot">이 도감은 도구가 바뀔 때만 갱신됩니다(매일 재생성하지 않음). 가격·기능은 변하니 결제 전 원문 확인. 누락·오류 제보 환영.</p></div></section>
</div>`;

const md = `---
title: AI Design Stack
eyebrow: "STUDIO · 현상설계 실무 AI 도구 도감"
hero_title: "AI <em>Design Stack</em>"
description: 현상설계 결과물(컨셉·다이어그램·매싱·라이노/GH·렌더·패널·보고서)을 실제로 더 빨리·낫게 뽑게 해주는 AI 도구만 단계별로 모은 실무 도감. 가격·플랫폼·성숙도까지, 데모는 데모라고. 매주 실전 레시피 한 편.
stats:
  - num: "${tools.length}"
    lbl: "도구"
  - num: "${stageCount}"
    lbl: "단계"
  - num: "${verifiedCount}"
    lbl: "원문대조"
  - num: "주1"
    lbl: "레시피"
---

${body}
`;

if (DRY) {
  process.stdout.write(md);
  console.error(`\n[dry] 도구 ${tools.length}개 · 단계 ${stageCount}개 · 원문대조 ${verifiedCount}개 — index.md 미작성`);
} else {
  await writeFile("index.md", md, "utf8");
  console.log(`index.md 갱신 — 도구 ${tools.length}개 · 단계 ${stageCount}개 · 원문대조 ${verifiedCount}개`);
}
