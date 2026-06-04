# arch-ai-tools-curation

현상설계 실무 AI 도구·기법 일일 큐레이션. 당선 사이트 `/studio` (메뉴 "AI 작업실") 의 콘텐츠 소스.

`/curation`(AI in Architecture — 연구·코드 모델)·`/trends`(설계공모 공고)와 **겹치지 않는다**.
여긴 *손에 잡히는 실무 도구*만 — 컨셉·다이어그램·매싱·라이노/GH·렌더/CG·패널·보고서를 실제로
더 빨리·낫게 뽑게 해주는 것.

## 구조

- `CURATION_SPEC.md` — 단일 기준 문서 (도메인·필터·섹션·톤). **편집 방향은 이 파일만 고치면 다음 회차부터 반영.**
- `scripts/sources.json` — 수집처 (McNeel·Reddit·Parametric Monkey·ArchDaily·HN·arXiv).
- `scripts/build-local.mjs` — 수집 → claude -p (정액제) → 검증 → `.ni` HTML 회차 + `index.md`.
- `scripts/run-daily.ps1` — Windows 작업 스케줄러용 (매일 09:30 KST).
- `YYYY-MM-DD_요일.md` — 회차 (시맨틱 HTML). `index.md` — 회차 목록 (자동 갱신).

## 수동 실행

```
npm run dry-run     # 수집 + 프롬프트만 (생성 안 함)
npm run build       # claude -p 로 오늘 회차 생성
FORCE=1 npm run build   # 오늘 회차 강제 재생성
```

사이트는 `lib/studio.ts` 가 이 repo를 GitHub raw로 읽어 `/studio` 로 렌더한다 (재배포 불필요).
