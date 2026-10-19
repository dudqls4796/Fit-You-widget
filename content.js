/* =========================================================
   브랜드 사이즈 예측 위젯 - Chrome 확장 content script
   brand_size_widget/script.js의 렌더링/예측 로직을 그대로 포팅하되,
   데이터 취득 계층만 실제 무신사 상품 페이지에 맞게 바꿨습니다:
     - goodsNo: location.href에서 직접 추출
     - model/model.json, model/product_lookup.json: background service worker 메시지로 로드
     - 브랜드/상품명/카테고리: /api/brand 프록시 대신 이미 하이드레이션된 실제 페이지 DOM에서 직접 읽음
     - 실측 사이즈표: puppeteer로 렌더링해서 얻던 것을, 지금은 이미 우리가 그 실제 페이지
       안에서 실행되고 있으므로 DOM에서 직접(재시도 포함) 읽음
   원본 데모(brand_size_widget/)는 수정하지 않습니다.
========================================================= */
/* =============================================================================
   [파일 개요] content.js — 무신사 상품 상세 페이지(https://www.musinsa.com/products/*)에
   주입되어 "구매하기" 버튼 아래에 브랜드 기반 사이즈 추천 위젯을 띄우는 메인 스크립트.

   전체 흐름(inject 함수 기준)
     1. URL에서 상품 번호(goodsNo)를 뽑고, 아우터(카테고리 002) 상품인지 확인
     2. 모델 데이터·리뷰 요약·로그인 상태·실측표 준비를 병렬로 시작하고, 로그인 확인 후 구매 이력을 조회
     3. 구매하기(또는 품절/재입고 알림) 버튼을 찾아 그 아래에 Shadow DOM 위젯 삽입 + 로딩 표시
     4. 점수(−2 작아요 ~ +2 커요)를 계산하고, 평소 입는 사이즈/구매 이력 기준으로 추천 사이즈 결정
     5. 판매 사이즈 목록·실측표와 대조해 추천 문구, 경고, cm 비교 근거를 렌더링
     6. 이후 SPA 페이지 이동, 계정 전환, 확장 새로고침(orphan)을 감지해 위젯을 재삽입/정리

   코드 구역
     - 점수 구간·핏별 기준값·사이즈 사다리(SIZE_LADDER)와 사이즈 파싱/이동 유틸
     - 1) 모델 로드, 2) 비교 기준 목록, 로그인/캐시, 구매 이력·상품 리뷰 조회
     - 카테고리 게이트, 판매 사이즈 목록, 실측표 추출·비교(cm 폴백), 판단 기준 패널
     - 3) 예측 데이터 구성, 4) 렌더링, 5) 위젯 마운트, 6) 삽입 위치 탐색과 생명주기 관리
   ============================================================================= */

// 즉시 실행 함수(IIFE)로 감싸 전역 변수를 만들지 않는다. (WIDGET_HTML만 widget.html.js의 전역 상수를 사용)
(function () {
  "use strict";

  // DEV-ONLY AUTO-RELOAD (배포 전 제거) - BEGIN
  const DEV_RELOAD_PING_INTERVAL_MS = 2000;
  let devReloadPingTimer = null;

  function sendDevReloadPing() {
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        if (devReloadPingTimer !== null) clearInterval(devReloadPingTimer);
        devReloadPingTimer = null;
        return;
      }

      const pingPromise = chrome.runtime.sendMessage({ type: "DEV_RELOAD_PING" });
      if (pingPromise && typeof pingPromise.catch === "function") {
        void pingPromise.catch(() => {});
      }
    } catch (error) {
      // 확장 reload 직후 이전 content script 컨텍스트에서 발생하는 종료 오류는 무시한다.
    }
  }

  sendDevReloadPing();
  devReloadPingTimer = setInterval(sendDevReloadPing, DEV_RELOAD_PING_INTERVAL_MS);
  // DEV-ONLY AUTO-RELOAD (배포 전 제거) - END

  // 점수(−2~+2)를 사람이 읽는 여론 문구로 바꾸기 위한 구간표.
  // 점수가 각 구간의 max 이하인 첫 항목의 label을 쓴다(마지막 2.01은 +2까지 포함하기 위한 여유값).
  const SCORE_BAND = [
    { max: -1, label: "많이 작다는 여론이 강하게 우세" },
    { max: -0.2, label: "약간 작다는 여론 우세" },
    { max: 0.2, label: "정사이즈 여론 우세" },
    { max: 1, label: "약간 크다는 여론 우세" },
    { max: 2.01, label: "많이 크다는 여론이 강하게 우세" },
  ];
  // 점수에 해당하는 여론 문구(예: "약간 크다는 여론 우세")를 돌려준다.
  function getBandLabel(score) {
    return SCORE_BAND.find((b) => score <= b.max).label;
  }

  // 상품 URL(…/products/12345…)에서 상품 번호 문자열을 추출한다. 없으면 null.
  function extractGoodsNo(url) {
    const m = String(url || "").match(/products\/(\d+)/);
    return m ? m[1] : null;
  }

  // innerHTML에 넣을 문자열의 HTML 특수문자를 이스케이프해 XSS/마크업 깨짐을 막는다.
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  // 핏별 사이즈 조정 기준값(점수 절댓값 기준).
  //   down: 점수가 +(옷이 크게 나옴)일 때 사이즈를 줄이는 기준, up: 점수가 −(작게 나옴)일 때 키우는 기준
  //   one 초과 → 한 단계 조정, two 초과 → 두 단계 조정.
  // 슬림핏은 작아지는 쪽에 민감(down 기준이 낮음), 오버핏은 커지는 쪽을 허용(down 기준이 높음).
  const FIT_THRESHOLDS = {
    slim: { down: { one: 0.3, two: 0.7 }, up: { one: 0.45, two: 0.9 } },
    regular: { down: { one: 0.4, two: 0.9 }, up: { one: 0.3, two: 0.7 } },
    over: { down: { one: 0.55, two: 1.1 }, up: { one: 0.2, two: 0.55 } },
  };

  // 점수 절댓값(abs)과 핏·방향(dir: "down"|"up")으로 몇 단계(0/1/2) 조정할지 계산한다.
  // 알 수 없는 핏/방향이면 정핏(regular)·down 기준으로 대체한다.
  function getStepsForAbsScore(abs, fit, dir) {
    const table = FIT_THRESHOLDS[fit] || FIT_THRESHOLDS.regular;
    const t = table[dir] || table.down;
    if (abs <= t.one) return 0;
    if (abs <= t.two) return 1;
    return 2;
  }

  // 핏 코드 → 화면 표시 이름
  const FIT_LABELS = { slim: "슬림핏", regular: "정핏", over: "오버핏" };
  // "자세히 보기" 안의 핏별 사이즈 조정 기준표(#thresholdTableBody)를 FIT_THRESHOLDS 값으로 채운다.
  function renderThresholdTable(root) {
    const tbody = root.getElementById("thresholdTableBody");
    if (!tbody) return;
    tbody.innerHTML = "";
    Object.keys(FIT_THRESHOLDS).forEach((fit) => {
      const t = FIT_THRESHOLDS[fit];
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${escapeHtml(FIT_LABELS[fit] || fit)}</td>` +
        `<td>+${t.down.one} 초과 / +${t.down.two} 초과</td>` +
        `<td>-${t.up.one} 미만 / -${t.up.two} 미만</td>`;
      tbody.appendChild(tr);
    });
  }

  // 표준 한국 호수 ↔ cm 환산표. letter 표기(XS/S/M/...)와 숫자 표기(85/90/95/100...)가
  // 섞여 있는 상품들을 같은 축(cm) 위에서 비교하기 위해 쓴다.
  // 작은 사이즈 → 큰 사이즈 순서의 표준 사이즈 사다리. index 차이가 곧 '사이즈 단계' 차이다.
  const SIZE_LADDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "XXXXL"];
  // 각 표준 사이즈에 대응하는 한국식 호수(가슴둘레 cm). 5cm 간격.
  const SIZE_CM_MAP = {
    XXS: 80,
    XS: 85,
    S: 90,
    M: 95,
    L: 100,
    XL: 105,
    XXL: 110,
    XXXL: 115,
    XXXXL: 120,
  };

  // 일부 브랜드(특히 워크웨어/유니섹스 스트릿 브랜드)는 사이즈를 아예 "1","2","3","4" 같은
  // 순수 번호로만 매긴다(실제 확인: 러프사이드 Workaday Blouson, goodsNo 7046411 — 실측표까지
  // 있는데 사이즈 라벨은 "1"~"4"뿐). 이건 cm 호수도 letter도 아니라서 그 자체로는 다른
  // 상품과 비교할 축이 없다. 실제로 존재하는 번호형 사이즈 체계(Ted Baker, Komodo Fashion
  // 등)는 0~5의 6단계를 XXS~XL에 한 칸씩 그대로 대응시킨다(0=XXS,1=XS,2=S,3=M,4=L,5=XL) —
  // 이 세션에서 웹 검색으로 확인한, 실제 브랜드가 쓰는 유일한 근거 있는 대응표라 그대로
  // 가져다 쓴다(임의로 "1=S,2=M,3=L,4=XL"처럼 지어내지 않음). 다만 이건 표준이 없는 브랜드별
  // 번호를 "평균적으로" 표준 사이즈에 욱여넣는 것뿐이라 정확한 대응이 아니므로, 이 경로를
  // 탄 결과에는 항상 approximate:true를 달아 호출부가 "평균 환산" 안내 문구를 붙이게 한다.
  const NUMBERED_SIZE_MAP = { 0: "XXS", 1: "XS", 2: "S", 3: "M", 4: "L", 5: "XL", 6: "XXL" };

  // 판매 옵션에서 쓰는 영문 풀네임 별칭. parseSizeLetter에서만 표준 사이즈로 변환하고,
  // 화면 표기에는 원래 옵션 라벨을 그대로 사용한다. 공백·하이픈은 비교할 때만 제거한다.
  const NAMED_SIZE_ALIASES = {
    SMALL: "S",
    MEDIUM: "M",
    LARGE: "L",
    XSMALL: "XS",
    EXTRASMALL: "XS",
    XXSMALL: "XXS",
    XLARGE: "XL",
    EXTRALARGE: "XL",
    XXLARGE: "XXL",
    "2XLARGE": "XXL",
    DOUBLEXLARGE: "XXL",
    XXXLARGE: "XXXL",
    "3XLARGE": "XXXL",
    TRIPLEXLARGE: "XXXL",
    XXXXLARGE: "XXXXL",
    "4XLARGE": "XXXXL",
    QUADRUPLEXLARGE: "XXXXL",
  };

  // 현재 보고 있는 상품의 실측표에서 직접 뽑아낸 "이 브랜드만의" 번호↔표준사이즈 대응표
  // (deriveNumberedSizeMapFromChart가 채움). 있으면 위 일반 고정표보다 우선한다 — 같은
  // "2"라도 브랜드마다 실제 치수가 다를 수 있으므로, 이 상품 자체의 실측 데이터로 판단하는
  // 게 더 정확하다는 사용자 피드백에 따른 것. 실측표를 못 읽었거나(예: 실측표 자체가 없는
  // 상품) 판별에 못 쓸 만큼 애매하면(아래 유효성 검사 실패) null로 두고 일반표로 폴백한다.
  // 문자 표기(S/M/L...)든 숫자 호수 표기(85/90/95/100...)든 같은 cm 축으로 파싱한다
  // (요청: "95(M)"처럼 섞인 표기나, 한쪽은 "L" 다른쪽은 "100"처럼 표기 형식이 다른 두
  // 상품의 사이즈도 cm 환산으로 비교할 수 있어야 함).
  // [parseSizeLetter] 사이즈 표기 문자열을 표준 사이즈로 해석한다.
  //   반환: { letter: "M", index: 사다리 위치, cm: 호수, approximate?: true(번호형 평균 환산일 때) } 또는 null(해석 불가, 예: "F"/"FREE")
  //   해석 순서: ① 2XL~4XL/XXL 등 확장 XL 표기 → ② 5XL 이상은 범위 밖(null) → ③ 문자 표기(S/M/L…)
  //             → ④ 한 자리 번호(0~6, 상품 실측 매핑 우선) → ⑤ 2~3자리 숫자 호수(가장 가까운 사이즈, 3cm 이내)
  function parseSizeLetter(text, numberedSizeMap = null) {
    const raw = String(text || "");
    const upper = raw.toUpperCase();
    // 풀네임은 전체 라벨이 정확히 별칭과 일치할 때만 매핑해 "Largest" 같은 단어 일부를
    // 사이즈로 오인하지 않는다. 판매 옵션 원문은 호출부가 계속 보존한다.
    const compactLabel = upper.trim().replace(/[\s-]+/g, "");
    const namedLetter = Object.prototype.hasOwnProperty.call(NAMED_SIZE_ALIASES, compactLabel)
      ? NAMED_SIZE_ALIASES[compactLabel]
      : null;
    if (namedLetter) {
      return { letter: namedLetter, index: SIZE_LADDER.indexOf(namedLetter), cm: SIZE_CM_MAP[namedLetter] };
    }
    // Check numeric XL aliases before the normal XL token.  Without this,
    // the word-boundary rule below sees the "XL" suffix of "2XL" first.
    const extendedXl = upper.trim().match(/^(?:([2-4])\s*XL|(XX+L))$/);
    if (extendedXl) {
      const letter = extendedXl[2] || `${"X".repeat(Number(extendedXl[1]))}L`;
      if (SIZE_CM_MAP[letter] != null) {
        return { letter, index: SIZE_LADDER.indexOf(letter), cm: SIZE_CM_MAP[letter] };
      }
    }
    // 5XL 이상은 사다리(XXS~XXXXL) 밖이다. 아래 단어 경계 검사가 "5XL"의 "XL"만 보고
    // XL(105cm)로 뭉개지 않도록 해석 불가(null)로 처리한다.
    if (/^(?:[5-9]\s*XL|X{5,}L)$/.test(upper.trim())) return null;
    // 긴 표기부터 검사해야 "XXL" 안의 "XL", "XS" 안의 "S" 같은 부분 일치로 잘못 잡히지 않는다.
    const sorted = [...SIZE_LADDER].sort((a, b) => b.length - a.length);
    for (const letter of sorted) {
      if (new RegExp(`(^|[^A-Z])${letter}([^A-Z]|$)`).test(upper)) {
        return { letter, index: SIZE_LADDER.indexOf(letter), cm: SIZE_CM_MAP[letter] };
      }
    }
    // 순수 번호 하나뿐인 라벨("1","2","3","4"...) — 번호형 사이즈 체계로 보고 평균 매핑한다.
    // 2~3자리 cm 숫자(다음 분기)와 헷갈리지 않도록 "문자열 전체가 0~6 한 자리 숫자"일 때만
    // 적용한다.
    const numberedMatch = raw.trim().match(/^([0-6])$/);
    if (numberedMatch) {
      if (numberedSizeMap?.__status === "out-of-range") return null;
      const letter = (numberedSizeMap && numberedSizeMap[numberedMatch[1]]) || NUMBERED_SIZE_MAP[numberedMatch[1]];
      return { letter, index: SIZE_LADDER.indexOf(letter), cm: SIZE_CM_MAP[letter], approximate: true };
    }
    // 문자 표기가 없으면 "95", "100", "095"(앞자리 0으로 채운 표기 — 실제 무신사
    // 사이즈 옵션 목록에서 이 형태로 나오는 걸 라이브로 확인함) 같은 숫자 호수를 실측 cm으로
    // 보고, 표에서 가장 가까운 사이즈에 매핑한다(3cm 이내 오차만 인정 — 아예 다른 숫자를
    // 사이즈로 오인하지 않도록). \b 기반 정규식은 앞자리 0이 있으면 "95"를 못 찾아내므로
    // (0과 9 사이엔 단어 경계가 없음) 2~3자리 숫자를 통째로 찾아 정수로 파싱한다.
    const numMatch = raw.match(/\d{2,3}/);
    if (numMatch) {
      const cmValue = parseInt(numMatch[0], 10);
      let bestLetter = null;
      let bestDiff = Infinity;
      SIZE_LADDER.forEach((letter) => {
        const diff = Math.abs(SIZE_CM_MAP[letter] - cmValue);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestLetter = letter;
        }
      });
      if (bestLetter && bestDiff <= 3) {
        return { letter: bestLetter, index: SIZE_LADDER.indexOf(bestLetter), cm: cmValue };
      }
    }
    return null;
  }

  // [shiftSizeBySteps] 기준 사이즈 표기에서 steps 단계만큼 이동한 표준 사이즈를 구한다.
  //   dirSign: −1이면 작게, +1이면 크게, 0이면 그대로. 사다리 양 끝(XXS/XXXXL)을 넘지 않도록 자른다.
  //   반환: { text: 결과 사이즈, shifted: 실제로 바뀌었는지, steps: 실제 이동 단계, direction, original: 기준 사이즈 }
  //   기준 표기를 해석할 수 없으면 원래 표기를 그대로 돌려주고 original은 null.
  function shiftSizeBySteps(usualSizeText, steps, dirSign) {
    const parsed = parseSizeLetter(usualSizeText);
    if (!parsed) {
      return { text: usualSizeText, shifted: false, steps: 0, original: null };
    }
    const newIndex = Math.min(SIZE_LADDER.length - 1, Math.max(0, parsed.index + dirSign * steps));
    const actualSteps = Math.abs(newIndex - parsed.index);
    return {
      text: SIZE_LADDER[newIndex],
      shifted: newIndex !== parsed.index,
      steps: actualSteps,
      direction: newIndex < parsed.index ? "down" : newIndex > parsed.index ? "up" : "none",
      original: parsed.letter,
    };
  }

  // [shiftSize] '평소 입는 사이즈' 기준 추천: 상품 점수와 핏으로 조정 단계를 정해 사이즈를 이동한다.
  //   점수 > 0(크게 나옴) → 작게(down), 점수 < 0(작게 나옴) → 크게(up).
  function shiftSize(usualSizeText, score, fit) {
    const dir = score > 0 ? "down" : score < 0 ? "up" : null;
    const wantedSteps = dir ? getStepsForAbsScore(Math.abs(score), fit, dir) : 0;
    const dirSign = dir === "down" ? -1 : dir === "up" ? 1 : 0;
    return shiftSizeBySteps(usualSizeText, wantedSteps, dirSign);
  }

  // [getSizeAdjustment] 두 점수의 차이(diff = 현재 상품 − 기준 상품)를 사이즈 조정 안내로 바꾼다.
  //   구매 이력 기준 비교에서 사용. 반환 객체에는 단계 수, 방향, 짧은/긴 안내 문구, 주의 문구가 담긴다.
  function getSizeAdjustment(diff, fit) {
    const abs = Math.abs(diff);
    const dir = diff >= 0 ? "down" : "up";
    const dirSign = dir === "down" ? -1 : 1;
    const steps = getStepsForAbsScore(abs, fit, dir);

    if (steps === 0) {
      return { level: 0, steps: 0, dirSign, direction: "none", shortLabel: "그대로", label: "그대로 구매하는걸 추천드려요", note: null };
    }
    if (steps === 1) {
      return {
        level: 1,
        steps: 1,
        dirSign,
        direction: dir,
        shortLabel: dir === "up" ? "한 사이즈 크게" : "한 사이즈 작게",
        label: dir === "up" ? "한 사이즈 크게 구매하는걸 추천드려요" : "한 사이즈 작게 구매하는걸 추천드려요",
        note: null,
      };
    }
    return {
      level: 2,
      steps: 2,
      dirSign,
      direction: dir,
      shortLabel: dir === "up" ? "두 사이즈 크게" : "두 사이즈 작게",
      label: dir === "up" ? "두 사이즈 크게 구매하는걸 추천드려요" : "두 사이즈 작게 구매하는걸 추천드려요",
      note: "차이가 큰 편이라 신중하게 결정하세요",
    };
  }

  // ---------------------------------------------------------
  // 1) 모델 + 상품 조회 테이블 로드 (확장 리소스에서)
  // ---------------------------------------------------------
  // background에서 받아온 추천 모델(MODEL: 전체 평균 mu + 브랜드/카테고리 효과)과 상품별 조회표(LOOKUP)
  let MODEL = null;
  let LOOKUP = null;
  // 동시에 여러 곳에서 loadModel()을 불러도 요청은 한 번만 보내기 위한 진행 중 Promise
  let modelLoadPromise = null;

  // 기본값은 꺼져 있다. 문제 상품 URL에 ?sizeWidgetTiming=1 을 붙였을 때만 단계별
  // 경과 시간을 남겨, 일반 사용자의 콘솔을 불필요하게 채우지 않는다.
  const TIMING_DEBUG = new URL(location.href).searchParams.get("sizeWidgetTiming") === "1";

  // 상품 번호별 단계 시간 측정 로거를 만든다. 반환된 함수 timing(stage, extra)는
  // TIMING_DEBUG가 켜져 있을 때만 '시작 후 경과 ms'를 콘솔에 남긴다.
  function createTimingLogger(goodsNo) {
    const startedAt = performance.now();
    return (stage, extra = {}) => {
      if (!TIMING_DEBUG) return;
      const elapsedMs = Math.round(performance.now() - startedAt);
      // DevTools를 자동 수집하는 도구에서도 바로 읽을 수 있도록, 기존 객체 로그와 함께
      // 펼치지 않아도 되는 문자열 로그를 남긴다.
      console.debug(`[사이즈위젯][timing] 단계=${stage} ms=${elapsedMs}`);
      console.debug("[사이즈위젯][timing]", {
        goodsNo: String(goodsNo),
        stage,
        elapsedMs,
        ...extra,
      });
    };
  }

  // promise가 끝나는 데 걸린 시간을 stage 이름으로 기록하고, 결과/오류는 그대로 통과시킨다.
  function timePromise(timing, stage, promise) {
    const startedAt = performance.now();
    return Promise.resolve(promise).then(
      (value) => {
        timing(stage, { durationMs: Math.round(performance.now() - startedAt) });
        return value;
      },
      (error) => {
        timing(stage, { durationMs: Math.round(performance.now() - startedAt), failed: true });
        throw error;
      }
    );
  }

  // [loadModel] background(GET_MODEL_DATA)에서 MODEL·LOOKUP을 받아 전역에 저장한다. 실패하면 다음 호출에서 재시도.
  async function loadModel() {
    if (MODEL && LOOKUP) return;
    // 현재 상품 렌더링과 구매 이력 조회가 동시에 시작될 수 있다. 두 경로가 각각
    // 약 1MB lookup JSON을 service worker에서 구조 복제하지 않도록 한 번만 요청한다.
    if (!modelLoadPromise) {
      modelLoadPromise = chrome.runtime
        .sendMessage({ type: "GET_MODEL_DATA" })
        .then((response) => {
          if (!response?.ok || !response.model || !response.lookup) {
            throw new Error(`model data load failed${response?.error ? ` (${response.error})` : ""}`);
          }
          MODEL = response.model;
          LOOKUP = response.lookup;
        })
        .catch((error) => {
          modelLoadPromise = null;
          throw error;
        });
    }
    await modelLoadPromise;
  }

  // [marginalScore] 브랜드 또는 카테고리 하나만의 평균 점수(전체 평균 + 해당 효과)와 학습 건수를 돌려준다.
  //   kind: "brand" | "category". 모델에 없는 키면 전체 평균(mu)과 known:false.
  function marginalScore(kind, key) {
    const table = kind === "brand" ? MODEL.brandEffect : MODEL.categoryEffect;
    const entry = table[key];
    if (!entry) return { score: MODEL.mu, n: 0, known: false };
    return { score: Math.round((MODEL.mu + entry.effect) * 1000) / 1000, n: entry.n, known: true };
  }

  // [modelPredict] 리뷰 데이터가 없는 상품의 예측 점수 = 전체 평균(mu) + 브랜드 효과 + 카테고리 효과.
  //   모르는 브랜드/카테고리의 효과는 0으로 본다. 소수 셋째 자리로 반올림.
  function modelPredict(brand, category) {
    const b = MODEL.brandEffect[brand]?.effect ?? 0;
    const c = MODEL.categoryEffect[category]?.effect ?? 0;
    return Math.round((MODEL.mu + b + c) * 1000) / 1000;
  }

  // ---------------------------------------------------------
  // 2) 비교 기준 목록.
  //    - 항상 "평소 입는 사이즈"는 기본 기준으로 둔다. 더 이상 무신사 페이지 자체의
  //      사이즈 선택 컨트롤을 읽어오지 않는다(사용자 요청으로 자동 읽기/실시간 동기화를
  //      제거했다) — 사용자가 위젯 안의 드롭다운으로 직접 고르는 값을 그대로 쓴다.
  //    - 로그인 상태면 실제 구매 이력에서 뽑은 후보(가장 잘 맞았던 상품) 각각을
  //      "reference" 성격의 기준(refScore 보유)으로 추가한다 — 데모의 refGoodsNo 테스트
  //      입력을 대체하는 실제 데이터 버전.
  //    - 비로그인이면 로그인을 안내하는 비활성 행만 추가하고, 나머지 동작은
  //      "평소 입는 사이즈" 기준으로 그대로 degrade한다.
  // ---------------------------------------------------------
  // [buildBasisOptions] 위젯 '비교 기준' 목록에 들어갈 항목 배열을 만든다.
  //   항상 첫 항목은 '평소 입는 사이즈'(드롭다운). 이어서 로그인/이력 상태에 따라
  //   로그인 안내 · 확인 중 · 불러오기 실패 · 구매 이력 후보들(refScore 포함) · 이력 없음 중 하나를 붙인다.
  //   disabled 항목은 선택할 수 없는 안내용 행이다.
  function buildBasisOptions({ usualSize, loggedIn, purchaseHistory, historyStatus }) {
    const options = [
      {
        id: "usual",
        main: "평소 입는 사이즈",
        meta: `직접 선택 · ${usualSize || "M"}`,
        tag: "내 정보",
        selected: true,
        group: "usual-select",
        value: usualSize || "M",
      },
    ];

    if (!loggedIn && historyStatus !== "failed") {
      options.push({
        id: "login-hint",
        main: "구매 이력 기반 추천",
        meta: "무신사에 로그인하면 실제로 구매했던 아우터 중 가장 잘 맞았던 상품을 기준으로 비교할 수 있어요",
        tag: "로그인 필요",
        disabled: true,
        selected: false,
      });
    } else if (historyStatus === "loading") {
      options.push({
        id: "history-loading",
        main: "구매 이력 기반 추천",
        meta: "최근 구매한 아우터를 확인하고 있어요. 추천 결과는 먼저 표시됩니다.",
        tag: "확인 중",
        disabled: true,
        selected: false,
      });
    } else if (historyStatus === "failed") {
      options.push({
        id: "history-failed",
        main: "이력을 불러오지 못했어요",
        meta: "무신사 로그인 또는 구매 이력 서버에 연결하지 못했습니다. 잠시 후 다시 확인해 주세요.",
        tag: "불러오기 실패",
        disabled: true,
        selected: false,
      });
    } else if (Array.isArray(purchaseHistory) && purchaseHistory.length > 0) {
      // 후보가 여러 개일 수 있으므로 추천 기준용 드롭다운 하나로 묶어 보여준다.
      // 같은 후보 목록은 판단 기준 패널의 별도 select에도 쓰지만, 두 select의 선택 상태는
      // selectedBasisId(추천)와 decisionDraftId(판단 기준)로 분리한다.
      purchaseHistory.forEach((p) => {
        options.push({
          id: `reference-${p.goodsNo}`,
          main: p.name,
          // 실제 주문 내역(goodsOption)에서 뽑은 "구매한 사이즈"를 명시적으로 보여준다 —
          // 비교 로직(getDiffContext/실측 폴백)도 바로 이 값(p.sizeOption)을 그대로 쓴다.
          meta: `${p.brand} · ${p.category} · 구매 사이즈 ${p.sizeOption || "확인 안됨"} · 실측 점수 ${
            p.actualScore >= 0 ? "+" : ""
          }${p.actualScore}`,
          tag: p.sizeReview === "정사이즈" ? "정사이즈 리뷰" : "구매 이력",
          refScore: p.actualScore,
          selected: false,
          group: "history-select",
          refGoodsNo: p.goodsNo,
          sizeOption: p.sizeOption,
        });
      });
    } else {
      options.push({
        id: "history-empty",
        main: "구매 이력 기반 추천",
        meta: "최근 구매한 아우터 중 기준으로 쓸 수 있는 실측 데이터를 찾지 못했어요",
        tag: "정보 없음",
        disabled: true,
        selected: false,
      });
    }

    return options;
  }

  // ---------------------------------------------------------
  // 로그인 여부: 실제 로그인 세션으로 라이브 조사해서 찾은 무신사 자체 로그인 상태 API를
  // 우선 사용한다 — GET https://my.musinsa.com/api/member/v1/login-status
  //   → { data: { loggedIn: true/false, memberInfo: {...} } }
  // (이 API는 www.musinsa.com 상품 페이지에서 크로스 오리진으로 credentials:'include' fetch가
  // 실제로 성공하는 것을 확인함.) 네트워크 실패 등으로 이 API를 못 부르면, 헤더의
  // "로그인/회원가입" 링크(href에 /auth/login 포함) 존재 여부로 폴백한다 — 비로그인 세션에서
  // 라이브로 확인한 결과 이 링크는 비로그인일 때 항상 존재했다.
  // ---------------------------------------------------------
  // chrome.storage 캐시 유효 시간(ms): 로그인 2분, 구매 이력 5분, 일반 API 5분, 상품 카테고리 10분
  const CACHE_TTL = {
    login: 2 * 60 * 1000,
    history: 5 * 60 * 1000,
    api: 5 * 60 * 1000,
    category: 10 * 60 * 1000,
  };

  // [cacheGet] storage에서 key 캐시를 읽는다. 만료(expiresAt 경과)됐으면 지우고 null.
  //   확장 컨텍스트가 죽은 경우(확장 새로고침)엔 orphan 정리 후 null.
  async function cacheGet(key, ttl) {
    try {
      const stored = (await chrome.storage.local.get(key))[key];
      if (!stored) return null;
      // Legacy entries had only savedAt; treat them as expired according to
      // the caller's TTL and remove them as well.
      const expiresAt = Number(stored.expiresAt) || Number(stored.savedAt) + ttl;
      if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
        await chrome.storage.local.remove(key);
        return null;
      }
      return stored.value;
    } catch (err) {
      // 확장이 새로고침되어 이 인스턴스의 컨텍스트가 죽은 경우, 매번 경고를 반복하지 않고
      // 조용히 정리만 한다(teardownOrphan은 최초 1회만 로그를 남긴다).
      if (!isExtensionContextValid()) {
        teardownOrphan();
        return null;
      }
      console.warn("[사이즈위젯] 캐시 읽기 실패:", key, err);
      return null;
    }
  }

  // [cacheSet] 값을 만료 시각과 함께 storage에 저장하고, 저장 성공 여부와 관계없이 value를 그대로 돌려준다.
  async function cacheSet(key, value, ttl) {
    try {
      const savedAt = Date.now();
      await chrome.storage.local.set({ [key]: { savedAt, expiresAt: savedAt + ttl, value } });
    } catch (err) {
      if (!isExtensionContextValid()) {
        teardownOrphan();
      } else {
        console.warn("[사이즈위젯] 캐시 저장 실패:", key, err);
      }
    }
    return value;
  }

  // [getAccountIdentity] 로그인 상태 API 응답에서 계정 식별 문자열을 만든다(예: "member:12345").
  //   계정별로 구매 이력 캐시를 분리하고, 계정 전환을 감지하는 데 쓴다.
  function getAccountIdentity(data) {
    const member = data?.memberInfo;
    if (!member || typeof member !== "object") return data?.loggedIn ? "member:unknown" : "anonymous";
    const knownId = member.memberNo ?? member.memberId ?? member.id ?? member.email ?? member.nickname;
    return knownId != null ? `member:${knownId}` : `member:${JSON.stringify(member)}`;
  }

  // [getLoginState] 로그인 여부와 계정 식별자를 확인한다.
  //   forceRefresh가 아니면 2분 캐시를 먼저 쓰고, API 실패 시 헤더의 로그인 링크 유무(DOM)로 추정한다.
  //   반환: { loggedIn, identity, source, failed } — source는 "api"/"dom", 확장 컨텍스트가 끊긴 경우엔 기존 상태값(초기엔 "initial")
  async function getLoginState(forceRefresh = false) {
    if (!forceRefresh) {
      const cached = await cacheGet("sizeWidget:login", CACHE_TTL.login);
      if (cached) return cached;
    }
    try {
      const response = await fetchMusinsaResource(
        "https://my.musinsa.com/api/member/v1/login-status",
        "json"
      );
      const json = response.body;
      if (json && json.data && typeof json.data.loggedIn === "boolean") {
        return cacheSet("sizeWidget:login", {
          loggedIn: json.data.loggedIn,
          identity: getAccountIdentity(json.data),
          source: "api",
          failed: false,
        }, CACHE_TTL.login);
      }
      throw new Error("unexpected login-status shape");
    } catch (err) {
      if (!isExtensionContextValid()) {
        teardownOrphan();
        // 캐시 쓰기도 실패할 것이므로 시도하지 않고, 계정 변경으로 오인되지 않도록
        // 현재 인스턴스가 마지막으로 알던 상태를 그대로 반환한다.
        return { ...currentLoginInfo, source: currentLoginInfo.source, failed: true };
      }
      console.warn("[사이즈위젯] 로그인 상태 API 확인 실패, DOM 신호로 폴백:", err);
      const loggedIn = !document.querySelector('a[href*="/auth/login"]');
      return cacheSet("sizeWidget:login", {
        loggedIn,
        identity: loggedIn ? "dom:unknown" : "anonymous",
        source: "dom",
        failed: true,
      }, CACHE_TTL.login);
    }
  }

  // ---------------------------------------------------------
  // 실제 구매 이력 조회 (로그인 세션으로 라이브 조사해서 찾은 실제 API/페이지들만 사용):
  //
  // 1) 주문 내역: GET https://api.musinsa.com/api2/claim/store/mypage/integration/order
  //    ?page=0&size=<n>  (credentials:'include')
  //    → { data: [ { orderOptionList: [ { goodsNo, goodsName, brandName, orderStateText,
  //                                        orderDatetime, ... } ] } ] }
  //    "구매 확정"만 실제 완료된 구매로 인정한다(반품완료/결제오류/취소 등은 제외).
  //
  // 2) 각 후보 상품이 실제로 "아우터"인지: getCategory()로 1차 필터링(제목 키워드로 대부분의
  //    비아우터 상품을 걸러 불필요한 요청을 줄임) 후, 남은 후보만 그 상품 페이지 HTML을
  //    같은 오리진 fetch로 받아 __NEXT_DATA__ 안의 categoryDepth1Code를 실제로 확인한다
  //    (카테고리 게이트와 동일한 신호·동일한 파싱 로직). 이게 최종 판정 기준이며,
  //    getCategory()는 어디까지나 요청 수를 줄이기 위한 1차 필터일 뿐이다.
  //
  // 3) 점수: product_lookup.json(LOOKUP)에 해당 goodsNo가 있으면 실측 actualScore를,
  //    없으면 이미 로드된 MODEL로 modelPredict(brand, category)를 그대로 사용한다
  //    (현재 상품에서 쓰는 것과 동일한 predicted 로직).
  //
  // 4) 사용자 본인이 남긴 사이즈 자체 후기: GET
  //    https://goods.musinsa.com/api2/review/v1/mypage/reviews?page=1&size=<n>
  //    (credentials:'include')로 실제 "내가 쓴 후기" 목록을 확인했다. 다만 이 계정에는
  //    현재 구매확정된 아우터 2건(마인드브릿지 코트, 무신사 스탠다드 윈드브레이커 재킷) 중
  //    작성된 후기가 하나도 없었고, reviewContent는 자유 텍스트라 "정사이즈" 같은 구조화된
  //    필드가 없었다. 그래서 이 목록에 있는 리뷰 중 goodsNo가 일치하고 reviewContent에
  //    "정사이즈"/"작아요"/"커요" 문구가 그대로 포함된 경우에만 sizeReview로 반영하고
  //    (최선 판단, 구조화 데이터가 아니므로 보수적으로만 사용), 그 외에는 구매일 최신순으로
  //    후보를 정렬해 사용자가 직접 고르게 한다.
  // ---------------------------------------------------------
  // 주문 내역·내 후기 API 주소와 구매 이력 처리 상한값들
  const ORDER_LIST_API =
    "https://api.musinsa.com/api2/claim/store/mypage/integration/order?page=0&size=50";
  const MY_REVIEWS_API = "https://goods.musinsa.com/api2/review/v1/mypage/reviews?page=1&size=50";
  // 위젯에 보여줄 구매 이력 후보 최대 개수
  const MAX_HISTORY_CANDIDATES = 5;
  const MAX_CATEGORY_CHECK_FETCHES = 12; // 상품 페이지 확인 fetch 상한(요청 폭주 방지)
  // 상품 카테고리 확인 요청을 동시에 몇 개까지 보낼지
  const CATEGORY_FETCH_CONCURRENCY = 4;

  // [fetchMusinsaResource] background(FETCH_MUSINSA_RESOURCE)를 통해 무신사 URL을 대리 요청한다.
  //   HTTP 실패면 예외를 던지고, 성공이면 { ok, status, body } 응답을 돌려준다.
  async function fetchMusinsaResource(url, responseType = "json") {
    if (!isExtensionContextValid()) {
      teardownOrphan();
      throw new Error("extension context invalidated");
    }
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "FETCH_MUSINSA_RESOURCE",
        url,
        responseType,
      });
    } catch (err) {
      if (!isExtensionContextValid()) teardownOrphan();
      throw err;
    }
    if (!response?.ok) {
      throw new Error(`${url} → HTTP ${response?.status || 0}${response?.error ? ` (${response.error})` : ""}`);
    }
    return response;
  }

  // 실시간 리뷰 점수를 신뢰하기 위한 최소 사이즈 응답 수(이보다 적으면 기존 모델 예측 사용)
  const PRODUCT_REVIEW_MIN_RESPONSES = 10;
  // 공개 리뷰 요약은 점수 계산에 필요하지만, 응답이 없을 때 12초 동안 결과를 막을
  // 이유는 없다. 5초 후에는 기존 브랜드/카테고리 예측으로 안전하게 폴백한다.
  const PRODUCT_REVIEW_TIMEOUT_MS = 5000;
  // 상품 리뷰 요약 캐시: 24시간 보관, 최대 200개 상품, 최신 리뷰 목록은 10개만 조회
  const PRODUCT_REVIEW_CACHE_TTL = 24 * 60 * 60 * 1000;
  const PRODUCT_REVIEW_CACHE_LIMIT = 200;
  const PRODUCT_REVIEW_PAGE_SIZE = 10;
  // 상품 번호별 진행 중인 리뷰 요청(중복 요청 방지용)
  const productReviewRequests = new Map();

  // [fetchProductReviewResource] 리뷰 API를 5초 타임아웃으로 대리 요청하고 본문(body)만 돌려준다.
  async function fetchProductReviewResource(url) {
    if (!isExtensionContextValid()) {
      teardownOrphan();
      throw new Error("extension context invalidated");
    }
    const response = await chrome.runtime.sendMessage({
      type: "FETCH_MUSINSA_RESOURCE",
      url,
      timeoutMs: PRODUCT_REVIEW_TIMEOUT_MS,
    });
    if (!response?.ok) {
      throw new Error(`${url} → HTTP ${response?.status || 0}${response?.error ? ` (${response.error})` : ""}`);
    }
    return response.body;
  }

  // [getProductReviewCache] 상품 리뷰 요약 캐시를 읽는다. 24시간이 지났으면 삭제하고 null.
  async function getProductReviewCache(goodsNo) {
    const key = `sizeWidget:reviewCache:${goodsNo}`;
    try {
      const entry = (await chrome.storage.local.get(key))[key];
      if (!entry) return null;
      if (!Number.isFinite(entry.fetchedAt) || Date.now() - entry.fetchedAt >= PRODUCT_REVIEW_CACHE_TTL) {
        await chrome.storage.local.remove(key);
        return null;
      }
      return entry;
    } catch (err) {
      console.warn("[사이즈위젯] 상품 리뷰 캐시 읽기 실패:", err);
      return null;
    }
  }

  // [saveProductReviewCache] 상품 리뷰 요약을 저장하고, 캐시가 200개를 넘거나 만료된 항목은 오래된 순으로 정리한다.
  //   저장한 항목(fetchedAt 포함)을 돌려준다.
  async function saveProductReviewCache(goodsNo, reviewData) {
    const key = `sizeWidget:reviewCache:${goodsNo}`;
    const entry = { ...reviewData, fetchedAt: Date.now() };
    try {
      await chrome.storage.local.set({ [key]: entry });
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((item) => item.startsWith("sizeWidget:reviewCache:"));
      const ordered = keys
        .map((item) => ({ key: item, fetchedAt: Number(all[item]?.fetchedAt) || 0 }))
        .sort((a, b) => b.fetchedAt - a.fetchedAt);
      const remove = ordered.slice(PRODUCT_REVIEW_CACHE_LIMIT).map((item) => item.key);
      const expired = ordered
        .filter((item) => Date.now() - item.fetchedAt >= PRODUCT_REVIEW_CACHE_TTL)
        .map((item) => item.key);
      if (remove.length || expired.length) {
        await chrome.storage.local.remove([...new Set([...remove, ...expired])]);
      }
    } catch (err) {
      console.warn("[사이즈위젯] 상품 리뷰 캐시 저장 실패:", err);
    }
    return entry;
  }

  // API 응답이 { data: {...} }로 감싸져 있으면 안쪽 data를, 아니면 그대로 돌려준다.
  function unwrapReviewPayload(payload) {
    return payload?.data && typeof payload.data === "object" ? payload.data : payload;
  }

  // [summarizeProductReviews] 리뷰 설문 요약 API 응답에서 '사이즈' 문항의 답변 분포를 집계해 점수를 만든다.
  //   답변을 매우작음(−2)/작음(−1)/정사이즈(0)/큼(+1)/매우큼(+2) 5구간으로 분류하고,
  //   가중 평균 = 점수(actualScore), 각 구간 비율(%) = sizeDist, 총 응답 수 = reviewCount 로 돌려준다.
  function summarizeProductReviews(payload) {
    const data = unwrapReviewPayload(payload);
    const questions = Array.isArray(data?.questions) ? data.questions : [];
    const sizeQuestion = questions.find((question) =>
      /사이즈/.test(`${question?.attribute || ""} ${question?.questionText || ""}`)
    );
    const answers = Array.isArray(sizeQuestion?.answers) ? sizeQuestion.answers : [];
    const counts = { veryTight: 0, tight: 0, true: 0, big: 0, veryBig: 0 };
    const bucketForAnswer = (answer) => {
      const label = `${answer?.answerText || ""} ${answer?.answerShortText || ""}`.replace(/\s+/g, "");
      if (/매우작|많이작/.test(label)) return "veryTight";
      if (/조금작|작아요/.test(label)) return "tight";
      if (/정사이즈|보통/.test(label)) return "true";
      if (/조금커|조금큼|커요/.test(label)) return "big";
      if (/매우커|많이커|매우큼|많이큼/.test(label)) return "veryBig";
      return null;
    };
    answers.forEach((answer) => {
      const bucket = bucketForAnswer(answer);
      const count = Math.max(0, Number(answer?.count) || 0);
      if (bucket) counts[bucket] += count;
    });
    const reviewCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (!reviewCount) return { reviewCount: 0, sizeDist: null, actualScore: null };
    const weightedScore =
      -2 * counts.veryTight - counts.tight + counts.big + 2 * counts.veryBig;
    const sizeDist = Object.fromEntries(
      Object.entries(counts).map(([key, count]) => [key, Math.round((count / reviewCount) * 100)])
    );
    return {
      reviewCount,
      sizeDist,
      actualScore: Math.round((weightedScore / reviewCount) * 1000) / 1000,
    };
  }

  // [getProductReviewSamples] 최신 리뷰 목록에서 사이즈 체감·구매 사이즈·키·몸무게를 뽑아
  //   개수 집계와 평균 키/몸무게를 만든다(보조 정보이며 추천 점수 계산에는 쓰지 않음).
  function getProductReviewSamples(payload) {
    const data = unwrapReviewPayload(payload);
    const list = Array.isArray(data?.list) ? data.list : [];
    const samples = list.slice(0, PRODUCT_REVIEW_PAGE_SIZE).map((review) => {
      const profile = review?.userProfileInfo || {};
      const questions = review?.reviewSurveySatisfaction?.questions || [];
      const sizeQuestion = questions.find((question) => /사이즈/.test(question?.attribute || ""));
      const sizeAnswer = sizeQuestion?.answers?.[0]?.answerShortText || sizeQuestion?.answers?.[0]?.answerText || "";
      return {
        sizeFeel: sizeAnswer,
        purchasedSize: review?.goodsOption || "",
        height: Number(profile.userHeight) || null,
        weight: Number(profile.userWeight) || null,
      };
    }).filter((review) => review.sizeFeel || review.purchasedSize || review.height || review.weight);
    const countBy = (key) => samples.reduce((counts, review) => {
      if (review[key]) counts[review[key]] = (counts[review[key]] || 0) + 1;
      return counts;
    }, {});
    const averageOf = (key) => {
      const values = samples.map((review) => review[key]).filter(Number.isFinite);
      return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    };
    return {
      sampleCount: samples.length,
      sizeFeelCounts: countBy("sizeFeel"),
      purchasedSizeCounts: countBy("purchasedSize"),
      averageHeight: averageOf("height"),
      averageWeight: averageOf("weight"),
    };
  }

  // [getProductReviewResult] 상품의 리뷰 요약(점수용)과 최신 리뷰 목록(보조)을 조회해 캐시에 저장한다.
  //   같은 상품에 대한 요청이 진행 중이면 그 Promise를 재사용한다.
  //   요약 결과를 먼저 돌려주고, 목록은 늦게 와도 캐시에만 덧붙인다.
  function getProductReviewResult(goodsNo) {
    if (productReviewRequests.has(goodsNo)) return productReviewRequests.get(goodsNo);
    const promise = (async () => {
      const summaryUrl = `https://goods.musinsa.com/api2/review/v1/view/survey/${encodeURIComponent(goodsNo)}/summary`;
      const listUrl = `https://goods.musinsa.com/api2/review/v1/view/list?page=0&pageSize=${PRODUCT_REVIEW_PAGE_SIZE}&goodsNo=${encodeURIComponent(goodsNo)}&sort=new&selectedSimilarNo=${encodeURIComponent(goodsNo)}&myFilter=false&hasPhoto=false&isExperience=false`;
      // 목록은 현재 점수/추천 계산에서 사용하지 않는 보조 정보다. 요청은 기존처럼
      // 상품당 정확히 한 세트(요약 1회 + 목록 1회)만 보내되, 목록 지연이 최종 추천
      // 표시를 막지 않도록 요약과 분리한다.
      const samplesPromise = fetchProductReviewResource(listUrl)
        .then((reviews) => getProductReviewSamples(reviews))
        .catch((error) => {
          console.warn("[사이즈위젯] 최신 리뷰 목록 조회 실패:", error);
          return null;
        });
      const result = await saveProductReviewCache(goodsNo, {
        ...summarizeProductReviews(await fetchProductReviewResource(summaryUrl)),
        samples: null,
      });
      void samplesPromise.then((samples) => {
        if (samples) void saveProductReviewCache(goodsNo, { ...result, samples });
      });
      return result;
    })().finally(() => productReviewRequests.delete(goodsNo));
    productReviewRequests.set(goodsNo, promise);
    return promise;
  }

  // [fetchJson] JSON API를 요청하되, cacheKey가 있으면 5분 캐시를 먼저 확인하고 결과를 캐시한다.
  async function fetchJson(url, cacheKey) {
    const cached = cacheKey ? await cacheGet(cacheKey, CACHE_TTL.api) : null;
    if (cached) return cached;
    const json = (await fetchMusinsaResource(url, "json")).body;
    return cacheKey ? cacheSet(cacheKey, json, CACHE_TTL.api) : json;
  }

  // [fetchRealCategoryForGoodsNo] 다른 상품(구매 이력 상품)의 페이지 HTML을 받아 __NEXT_DATA__ 안에서
  //   그 상품의 category 객체(categoryDepth1Code 등)를 찾는다. 10분 캐시. 못 찾으면 예외.
  async function fetchRealCategoryForGoodsNo(goodsNo) {
    const cacheKey = `sizeWidget:category:${goodsNo}`;
    const cached = await cacheGet(cacheKey, CACHE_TTL.category);
    if (cached) return cached;
    const html = (
      await fetchMusinsaResource(`https://www.musinsa.com/products/${goodsNo}`, "text")
    ).body;
    const scriptMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!scriptMatch) throw new Error(`category ${goodsNo} → __NEXT_DATA__ 없음`);
    let json;
    try {
      json = JSON.parse(scriptMatch[1]);
    } catch (err) {
      throw new Error(`category ${goodsNo} → JSON 파싱 실패`);
    }
    const targetNo = String(goodsNo);
    let found = null;
    const seen = new Set();
    // JSON 트리를 깊이 10까지 재귀 탐색해, goodsNo가 일치하고 category 객체를 가진 노드를 찾는다(순환 참조 방지용 seen).
    (function search(obj, depth) {
      if (found || depth > 10 || !obj || typeof obj !== "object" || seen.has(obj)) return;
      seen.add(obj);
      if (
        obj.category &&
        typeof obj.category === "object" &&
        obj.goodsNo !== undefined &&
        String(obj.goodsNo) === targetNo
      ) {
        found = obj.category;
        return;
      }
      for (const key in obj) {
        if (found) return;
        search(obj[key], depth + 1);
      }
    })(json, 0);
    if (!found) throw new Error(`category ${goodsNo} → 카테고리 없음`);
    await cacheSet(cacheKey, found, CACHE_TTL.category);
    return found;
  }

  // [mapWithConcurrency] items를 최대 limit개씩 동시에 worker로 처리하고, 입력 순서대로 결과 배열을 돌려준다.
  async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const runWorker = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
    return results;
  }

  // [fetchPurchaseHistory] 로그인한 계정의 '구매 확정' 아우터 주문을 비교 기준 후보로 만든다.
  //   주문 내역 + 내 후기 조회 → 구매 확정만, 상품별 최신 주문 1건 → 상품명으로 아우터 후보 1차 필터
  //   → 실제 카테고리(002) 확인 → 점수(LOOKUP 실측 또는 모델 예측)·구매 사이즈 부여 → 정렬 후 최대 5개.
  //   반환: { status: "loaded"|"failed", items: 후보 배열 }. 계정 식별이 확실할 때만 5분 캐시한다.
  async function fetchPurchaseHistory(accountIdentity) {
    const cacheableIdentity = accountIdentity && !String(accountIdentity).includes("unknown");
    const historyKey = `sizeWidget:history:${encodeURIComponent(accountIdentity)}`;
    const cachedHistory = cacheableIdentity ? await cacheGet(historyKey, CACHE_TTL.history) : null;
    if (cachedHistory) return cachedHistory;
    try {
      const [orderJson, reviewJson] = await Promise.all([
        fetchJson(
          ORDER_LIST_API,
          cacheableIdentity ? `sizeWidget:orders:${encodeURIComponent(accountIdentity)}` : null
        ),
        fetchJson(
          MY_REVIEWS_API,
          cacheableIdentity ? `sizeWidget:reviews:${encodeURIComponent(accountIdentity)}` : null
        ),
      ]);

      // 내가 쓴 후기를 상품 번호별 본문으로 정리(정사이즈/작아요/커요 문구 탐지용)
      const myReviewsByGoodsNo = new Map();
      if (reviewJson && reviewJson.data && Array.isArray(reviewJson.data.list)) {
        reviewJson.data.list.forEach((rv) => {
          if (rv.goodsNo != null) myReviewsByGoodsNo.set(String(rv.goodsNo), rv.reviewContent || "");
        });
      }

      // 주문 → 주문 옵션(상품 단위)으로 펼친다.
      const allOptions = [];
      (orderJson.data || []).forEach((order) => {
        (order.orderOptionList || []).forEach((opt) => allOptions.push(opt));
      });

      // 실제로 완료된 구매만: "구매 확정"만 인정(결제오류/반품/취소 등 제외)
      const confirmed = allOptions.filter((o) => o.orderStateText === "구매 확정" && o.goodsNo);

      // goodsNo 기준 중복 제거, 가장 최근 주문(orderDatetime desc)만 남김
      const byGoodsNo = new Map();
      confirmed.forEach((o) => {
        const key = String(o.goodsNo);
        const prev = byGoodsNo.get(key);
        if (!prev || String(o.orderDatetime) > String(prev.orderDatetime)) {
          byGoodsNo.set(key, o);
        }
      });

      // 1차 필터: 제목 키워드로 아우터일 가능성이 있는 것만 남겨 불필요한 상품 페이지 요청을 줄인다.
      const likelyOuter = Array.from(byGoodsNo.values())
        .filter((o) => getCategory(o.goodsName || "") !== "기타")
        .sort((a, b) => String(b.orderDatetime).localeCompare(String(a.orderDatetime)))
        .slice(0, MAX_CATEGORY_CHECK_FETCHES);

      await loadModel();

      // 후보 상품마다 실제 카테고리를 확인하고, 아우터면 비교 기준 후보 객체를 만든다(동시 4개).
      const classified = await mapWithConcurrency(likelyOuter, CATEGORY_FETCH_CONCURRENCY, async (o) => {
        let category;
        try {
          category = await fetchRealCategoryForGoodsNo(o.goodsNo);
        } catch (err) {
          console.warn("[사이즈위젯] 구매 이력 상품 카테고리 확인 실패:", o.goodsNo, err);
          return { failed: true };
        }
        if (!category || category.categoryDepth1Code !== "002") return { failed: false, candidate: null }; // 실제로 아우터가 아니면 제외

        const goodsNoKey = String(o.goodsNo);
        const lookupEntry = LOOKUP[goodsNoKey];
        const categorySubtype = getCategory(o.goodsName || "");
        let actualScore;
        if (lookupEntry && typeof lookupEntry.actualScore === "number") {
          actualScore = lookupEntry.actualScore;
        } else {
          actualScore = modelPredict(o.brandName, categorySubtype);
        }
        actualScore = Math.round(actualScore * 1000) / 1000;

        let sizeReview;
        const reviewText = myReviewsByGoodsNo.get(goodsNoKey);
        if (reviewText) {
          if (reviewText.includes("정사이즈")) sizeReview = "정사이즈";
          else if (reviewText.includes("작아요")) sizeReview = "작아요";
          else if (reviewText.includes("커요")) sizeReview = "커요";
        }

        return { failed: false, candidate: {
          goodsNo: o.goodsNo,
          name: o.goodsName,
          brand: o.brandName,
          category: lookupEntry ? lookupEntry.category : categorySubtype,
          actualScore,
          sizeReview,
          orderDatetime: o.orderDatetime,
          // 실제로 구매한 사이즈 표기(예: "100", "L") — 사이즈 라벨 매칭이 안 될 때
          // 실측(cm) 비교 폴백에서 "이 사이즈 기준으로" 기준 상품 실측표를 조회하는 데 쓴다.
          sizeOption: extractSizeFromGoodsOption(o.goodsOption),
        }};
      });

      // 카테고리 확인이 전부 실패했으면 '불러오기 실패'로, 하나라도 성공했으면 '로딩 완료'로 본다.
      const categoryAttempts = likelyOuter.length;
      const categoryFailures = classified.filter((item) => item?.failed).length;
      const candidates = classified.map((item) => item?.candidate).filter(Boolean);

      // 본인이 남긴 "정사이즈" 리뷰가 있는 후보를 우선, 그 다음은 최신 구매순.
      candidates.sort((a, b) => {
        const aTrue = a.sizeReview === "정사이즈" ? 1 : 0;
        const bTrue = b.sizeReview === "정사이즈" ? 1 : 0;
        if (aTrue !== bTrue) return bTrue - aTrue;
        return String(b.orderDatetime).localeCompare(String(a.orderDatetime));
      });

      const result = {
        status: categoryAttempts >= 1 && categoryFailures === categoryAttempts ? "failed" : "loaded",
        items: candidates.slice(0, MAX_HISTORY_CANDIDATES),
      };
      return cacheableIdentity ? cacheSet(historyKey, result, CACHE_TTL.history) : result;
    } catch (err) {
      console.warn("[사이즈위젯] 구매 이력 조회 실패:", err);
      return { status: "failed", items: [] };
    }
  }

  // 주문 내역 API의 goodsOption(예: "BK·100", "화이트 멜란지·2 (L)")에서 실제 구매한
  // 사이즈 표기만 뽑아낸다(마지막 "·" 조각을 사이즈로 취급).
  function extractSizeFromGoodsOption(goodsOption) {
    const text = String(goodsOption || "").trim();
    if (!text) return null;
    const parts = text.split("·").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || null;
  }

  // ---------------------------------------------------------
  // 브랜드/상품명/카테고리: 실시간 프록시 대신, 이미 하이드레이션된 실제 페이지에서 직접 읽는다.
  // ---------------------------------------------------------
  // 문자열 안의 \uXXXX 형태 유니코드 이스케이프를 실제 문자로 바꾼다(페이지 HTML에서 뽑은 브랜드명용).
  function decodeUnicodeEscapes(s) {
    return String(s).replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
  }

  // _serve.js의 getCategory()와 동일한 규칙 (순수 문자열 로직, 그대로 포팅)
  // [getCategory] 상품명 키워드로 아우터 세부 분류(패딩/코트/블루종…)를 정한다. 해당 없으면 "기타".
  //   위에서부터 먼저 맞는 규칙이 이긴다(예: '다운 코트'는 패딩).
  function getCategory(name) {
    if (/패딩|다운|덕다운|PUFFER|DOWN JACKET/i.test(name)) return "패딩";
    if (/무스탕|퍼 점퍼|SHEARLING|MOUTON/i.test(name)) return "무스탕/퍼";
    if (/코트|로브|발마칸|COAT|TRENCH/i.test(name)) return "코트";
    if (/집업|후디드|후드|ZIP.?UP|HOOD(IE|ED)?/i.test(name)) return "집업/후드";
    if (/가디건|CARDIGAN/i.test(name)) return "가디건";
    if (/파카|PARKA/i.test(name)) return "파카";
    if (/레더|가죽|LEATHER/i.test(name)) return "레더자켓";
    if (/데님|청자켓|DENIM/i.test(name)) return "데님자켓";
    if (/블루종|바이커|BLOUSON|BIKER|MA-1/i.test(name)) return "블루종";
    if (/플리스|후리스|FLEECE/i.test(name)) return "플리스";
    if (/윈드브레이커|바람막이|WINDBREAKER|WIND ?JACKET/i.test(name)) return "윈드브레이커";
    if (/트랙탑|점퍼|JUMPER|TRACK ?TOP|TRACK ?JACKET/i.test(name)) return "트랙탑/점퍼";
    if (/야상|헤링턴|HARRINGTON|FIELD JACKET/i.test(name)) return "자켓(일반)";
    if (/베스트|VEST|조끼/i.test(name)) return "베스트";
    if (/자켓|재킷|블레이저|JACKET|BLAZER|JKT/i.test(name)) return "자켓(일반)";
    return "기타";
  }

  // ---------------------------------------------------------
  // 카테고리 게이트: 위젯은 "아우터"(categoryDepth1Code === "002") 상품에서만 노출한다.
  // 실제 신호는 Next.js SSR이 심어주는 <script id="__NEXT_DATA__"> 안의 react-query
  // dehydratedState 어딘가에 있는 "이 상품(goodsNo 일치)" 객체의 category.categoryDepth1Code다.
  // (실제 상품 페이지 라이브 조사로 확인함: 코트 상품 → categoryDepth1Code "002"/"아우터",
  //  데님팬츠 상품 → "003"/"바지", 신발 상품 → 최상단 카테고리가 "아우터"가 아님.)
  // getCategory()의 정규식 기반 서브타입 분류(패딩/코트/블루종 등)는 "이미 아우터인 게 확실한
  // 경우"의 표시용 세부분류로만 계속 쓰고, 아우터 여부 자체의 판정에는 쓰지 않는다.
  // ---------------------------------------------------------
  // [findGoodsCategoryInNextData] 현재 페이지 __NEXT_DATA__에서 이 상품(goodsNo)의 category 객체를 찾는다. 없으면 null.
  function findGoodsCategoryInNextData(goodsNo) {
    const script = document.getElementById("__NEXT_DATA__");
    if (!script || !script.textContent) return null;
    let json;
    try {
      json = JSON.parse(script.textContent);
    } catch (err) {
      console.warn("[사이즈위젯] __NEXT_DATA__ 파싱 실패:", err);
      return null;
    }
    const targetNo = String(goodsNo);
    let found = null;
    const seen = new Set();
    function search(obj, depth) {
      if (found || depth > 10 || !obj || typeof obj !== "object" || seen.has(obj)) return;
      seen.add(obj);
      if (
        obj.category &&
        typeof obj.category === "object" &&
        obj.goodsNo !== undefined &&
        String(obj.goodsNo) === targetNo
      ) {
        found = obj.category;
        return;
      }
      for (const key in obj) {
        if (found) return;
        search(obj[key], depth + 1);
      }
    }
    search(json, 0);
    return found;
  }

  // ---------------------------------------------------------
  // 현재 상품 페이지에서 실제 판매 사이즈 목록을 읽는다 — 드롭다운을 실제로
  // 펼쳐야 DOM에 나타나는 옵션 목록을 흉내 내기 위해 사용자 모르게 클릭하지 않고,
  // 같은 __NEXT_DATA__ 안에 이미 들어있는 옵션 데이터(basic 배열의 "사이즈" 그룹,
  // optionValues[].name)를 그대로 읽는다. 실측(cm) 폴백을 "라벨 파싱 실패"뿐 아니라
  // "라벨은 정상인데 기준 상품과 겹치는 사이즈가 아예 없는 경우"까지 넓히기 위해 쓴다.
  // ---------------------------------------------------------
  // 반환: 판매 사이즈 표기 배열(예: ["S","M","L"]) 또는 읽지 못하면 null.
  function getPageAvailableSizeTexts() {
    try {
      const script = document.getElementById("__NEXT_DATA__");
      if (!script || !script.textContent) return null;
      const json = JSON.parse(script.textContent);
      let found = null;
      const seen = new Set();
      (function search(obj, depth) {
        if (found || depth > 12 || !obj || typeof obj !== "object" || seen.has(obj)) return;
        seen.add(obj);
        // 옵션 그룹 배열(basic)을 가진 객체를 찾으면 탐색 종료
        if (Array.isArray(obj.basic) && obj.basic.some((g) => g && Array.isArray(g.optionValues))) {
          found = obj.basic;
          return;
        }
        for (const key in obj) {
          if (found) return;
          search(obj[key], depth + 1);
        }
      })(json, 0);
      if (!found) return null;
      // 무신사 옵션 API는 그룹명을 한글 "사이즈" 대신 약어 "S"로 주기도 한다
      // (예: 4438290). "S" 그룹도 사이즈로 인식하되, 옵션별 품절 여부는 여기서
      // 제외하지 않아 전체 품절 상품도 판매 사이즈 기준으로 추천할 수 있게 한다.
      const sizeGroup = found.find((g) => g && /사이즈|size/i.test(g.name || "")) ||
        found.find((g) => g && /^S$/i.test(String(g.name || "").trim()));
      if (!sizeGroup || !Array.isArray(sizeGroup.optionValues)) return null;
      return sizeGroup.optionValues
        .filter((v) => v && !v.isDeleted && v.name)
        .map((v) => String(v.name));
    } catch (err) {
      console.warn("[사이즈위젯] 판매 사이즈 목록 읽기 실패:", err);
      return null;
    }
  }

  // sizeText가 availableSizeTexts 중 하나와 cm 환산으로 같은 사이즈를 가리키는지 확인한다.
  // 목록을 못 읽었으면(null) 판단을 보류해 기존 동작(점수 기반 비교)을 그대로 둔다 — 신호가
  // 없다고 폴백을 강제로 켜서 정상 케이스까지 실측 비교로 몰아가지 않기 위함.
  function hasComparableSize(sizeText, availableSizeTexts, targetNumberedSizeMap = null, availableNumberedSizeMap = null) {
    if (!Array.isArray(availableSizeTexts) || availableSizeTexts.length === 0) return true;
    const target = parseSizeLetter(sizeText, targetNumberedSizeMap);
    if (!target) return false;
    return availableSizeTexts.some((s) => {
      const p = parseSizeLetter(s, availableNumberedSizeMap);
      return p && p.letter === target.letter;
    });
  }

  // 계산된 라벨과 동일한 판매 옵션을 반환한다. 번호형 옵션은 상품 실측 매핑으로
  // 가장 가까운 실제 번호를 찾고, 그 외 판매 옵션은 계산 사이즈와 정확히 대응해야 한다.
  //   반환: 실제 판매 옵션 표기 또는 null(대응하는 판매 사이즈 없음 → 미판매 경고 대상).
  function findAvailableSizeLabel(sourceText, availableSizeTexts, numberedSizeMap = null) {
    if (!Array.isArray(availableSizeTexts) || availableSizeTexts.length === 0) return null;
    const normalized = normalizeSizeLabel(sourceText);
    const exact = availableSizeTexts.find((size) => normalizeSizeLabel(size) === normalized);
    if (exact) return exact;

    // 우선 표준 사이즈가 같은 번호 옵션을 찾고, 없으면 아래에서 번호 옵션만 근접 매핑한다.
    const parsed = parseSizeLetter(sourceText, numberedSizeMap);
    if (!parsed) return null;
    const sameStandardSize = availableSizeTexts.find((size) => {
      const available = parseSizeLetter(size, numberedSizeMap);
      return available && available.letter === parsed.letter;
    });
    if (sameStandardSize) return sameStandardSize;

    // 계산 표준 사이즈가 번호 판매 옵션과 정확히 일치하지 않으면, 상품 실측으로
    // 해석된 번호 옵션 중 가장 가까운 번호를 고른다. 단, 실측표가 정의한 번호 매핑
    // 범위 밖은 판매 옵션으로 대체하지 않는다. 문자/숫자 호수 등 일반 옵션도 근접값으로
    // 대체하지 않아 미판매 경고 규칙을 유지한다.
    const numberedOptions = availableSizeTexts
      .filter((size) => /^\s*[0-6]\s*$/.test(String(size)))
      .map((size) => ({ size, parsed: parseSizeLetter(size, numberedSizeMap) }))
      .filter((option) => option.parsed);
    if (numberedOptions.length === 0) return null;
    const rangeMin = Math.min(...numberedOptions.map((option) => option.parsed.cm));
    const rangeMax = Math.max(...numberedOptions.map((option) => option.parsed.cm));
    if (parsed.cm < rangeMin || parsed.cm > rangeMax) return null;
    return numberedOptions.reduce((nearest, option) =>
      Math.abs(option.parsed.cm - parsed.cm) < Math.abs(nearest.parsed.cm - parsed.cm) ? option : nearest
    ).size;
  }

  // 사이즈 표기가 0~6 한 자리 번호형인지 확인한다.
  function isNumberedSizeLabel(sizeText) {
    return /^\s*[0-6]\s*$/.test(String(sizeText || ""));
  }

  // 백업 신호: 상단 breadcrumb의 최상위 카테고리 링크(href가 정확히 /category/002)이자
  // 텍스트가 "아우터"인 앵커. __NEXT_DATA__를 못 읽을 때만 쓰는 폴백이다.
  function findBreadcrumbTopCategory() {
    const links = Array.from(document.querySelectorAll('a[href*="/category/"]'));
    for (const a of links) {
      const m = a.href.match(/\/category\/(\d{3})(?:[/?]|$)/);
      if (!m) continue;
      const text = (a.textContent || "").trim();
      if (text) return { code: m[1], name: text };
    }
    return null;
  }

  // 상품이 "아우터"(categoryDepth1Code === "002")인지 실시간 페이지 신호로 판정한다.
  // 판정 불가(신호를 전혀 못 찾음)면 안전하게 false를 반환해 위젯을 띄우지 않는다.
  function isOuterProductPage(goodsNo) {
    const nextDataCategory = findGoodsCategoryInNextData(goodsNo);
    if (nextDataCategory && nextDataCategory.categoryDepth1Code) {
      return nextDataCategory.categoryDepth1Code === "002";
    }
    const breadcrumb = findBreadcrumbTopCategory();
    if (breadcrumb) {
      return breadcrumb.code === "002" && breadcrumb.name === "아우터";
    }
    console.warn("[사이즈위젯] 실제 카테고리 신호를 찾지 못해 위젯을 표시하지 않습니다.");
    return false;
  }

  // __NEXT_DATA__는 SSR로 내려오므로 보통 즉시 존재하지만, 혹시 늦게 붙는 경우를 대비해
  // 짧게 재시도한다(구매하기 버튼처럼 별도의 하이드레이션 대기 없이 처음부터 있는 게 정상).
  function waitForCategoryDecision(goodsNo, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tryOnce = () => {
        const script = document.getElementById("__NEXT_DATA__");
        const breadcrumb = findBreadcrumbTopCategory();
        if (script || breadcrumb || Date.now() - start > timeoutMs) {
          resolve(isOuterProductPage(goodsNo));
          return;
        }
        setTimeout(tryOnce, 100);
      };
      tryOnce();
    });
  }

  // [getLiveBrandInfo] LOOKUP에 없는 상품일 때 페이지에서 직접 브랜드·상품명·세부 카테고리를 읽는다.
  //   브랜드: 페이지 HTML의 "brandName" 값, 상품명: og:title(또는 문서 제목)에서 '- 사이즈 & 후기' 꼬리 제거.
  function getLiveBrandInfo() {
    try {
      const html = document.documentElement.innerHTML;
      const brandMatch = html.match(/"brandName":"([^"]+)"/);
      if (!brandMatch) return null;
      const brand = decodeUnicodeEscapes(brandMatch[1]);

      const ogTitleEl = document.querySelector('meta[property="og:title"]');
      const rawTitle = (ogTitleEl && ogTitleEl.content) || document.title || "";
      const name = rawTitle.replace(/\s*-\s*사이즈\s*&?\s*후기.*$/, "").trim() || "(상품 정보를 찾을 수 없어요)";
      const category = getCategory(name);
      return { brand, name, category };
    } catch (err) {
      console.warn("[사이즈위젯] 실시간 브랜드 정보 읽기 실패:", err);
      return null;
    }
  }

  // ---------------------------------------------------------
  // 실측 사이즈표: _serve.js의 extractSizeChartInPage()를 그대로 포팅.
  // 이제 puppeteer로 별도 렌더링할 필요 없이, 이미 실행 중인 이 페이지의 DOM을 바로 읽는다.
  // 다만 이 페이지도 클라이언트 사이드 하이드레이션이라, content script 주입 시점엔 아직
  // 테이블이 없을 수 있어 호출 측(waitForSizeChart)에서 재시도한다.
  // ---------------------------------------------------------
  // doc은 document(현재 페이지) 또는 DOMParser로 파싱한 다른 상품의 HTML 문서일 수 있다
  // (구매 이력 기준 상품의 실측표를 백그라운드 fetch로 읽어올 때 재사용).
  //   반환: { headers: 측정 항목명[], rows: [{ size, values[] }], diagramImage: 도식 이미지 URL, legend }
  //   실측표 영역(ActualSizeTable__Wrap)이 없으면 null.
  function extractSizeChartFromDoc(doc) {
    const wrap = doc.querySelector('[class*="ActualSizeTable__Wrap"]');
    if (!wrap) return null;
    const headerLis = Array.from(wrap.querySelectorAll('[class*="ActualSizeHeaderLi"]')).map((li) =>
      li.textContent.trim()
    );
    const sizeLabels = headerLis.slice(2);
    const table = wrap.querySelector("table");
    if (!table || sizeLabels.length === 0) return null;
    const headCells = Array.from(table.querySelectorAll("thead th, thead tr:first-child th"));
    const headerTexts = headCells.map((th) => th.textContent.trim());
    const headers = headerTexts.map((t) => t.replace(/^\d+/, ""));
    const legend = headerTexts.map((t, i) => {
      const m = t.match(/^(\d+)/);
      return { number: m ? Number(m[1]) : i + 1, label: headers[i] };
    });
    const dataRows = Array.from(table.querySelectorAll("tbody tr")).filter((tr) => tr.children.length > 1);
    const rows = dataRows.map((tr, i) => ({
      size: sizeLabels[i] || null,
      values: Array.from(tr.children).map((td) => td.textContent.trim()),
    }));
    if (rows.length === 0) return null;
    const diagramImg = wrap.querySelector("img");
    const diagramImage = diagramImg && diagramImg.src ? diagramImg.src : null;
    return { headers, rows, diagramImage, legend: diagramImage ? legend : null };
  }

  // 현재 페이지 문서에서 실측표를 추출한다.
  function extractSizeChartInPage() {
    return extractSizeChartFromDoc(document);
  }

  // ---------------------------------------------------------
  // 실측(cm) 기반 폴백: "평소 입는 사이즈"/"가장 잘 맞았던 상품(구매 이력)" 기준으로
  // 비교할 때, 두 상품의 사이즈 표기가 SIZE_LADDER로 매칭되지 않으면(예: 라벨을 아예
  // 파싱 못하는 경우) 점수(-2~+2) 비교 대신 두 상품의 실제 실측표(cm)를 직접 비교한다.
  //
  // 기준 상품의 실측표는 상품 상세 API에서 직접 받는다. API의 sizes[]를 현재 페이지 DOM
  // 파서와 같은 headers/rows 구조로 바꿔 기존 헤더 별칭·사이즈 행 비교 로직을 그대로 쓴다.
  // 성공 결과만 메모리와 storage에 24시간 보관한다. 실패(null)는 다음 비교에서 다시
  // 조회할 수 있도록 캐시에 남기지 않는다. 이 기본 경로는 상품 탭을 열지 않는다.
  // 상품 번호 → 실측표 Promise 메모리 캐시(같은 페이지 안에서 중복 요청 방지)
  const refChartCache = new Map();
  const REF_CHART_CACHE_PREFIX = "sizeWidget:refChart:";
  const REF_CHART_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const REF_CHART_REQUEST_TIMEOUT_MS = 5000;

  // [convertActualSizeApiToChart] 무신사 actual-size API 응답(data.sizes[].items[])을
  //   extractSizeChartFromDoc과 같은 { headers, rows, diagramImage, legend } 구조로 변환한다.
  function convertActualSizeApiToChart(apiResponse) {
    const sizes = apiResponse?.data?.sizes;
    if (!Array.isArray(sizes) || sizes.length === 0) return null;

    const headers = [];
    sizes.forEach((size) => {
      (Array.isArray(size?.items) ? size.items : []).forEach((item) => {
        const name = String(item?.name || "").trim();
        if (name && !headers.includes(name)) headers.push(name);
      });
    });
    if (headers.length === 0) return null;

    const rows = sizes.map((size) => {
      const valuesByHeader = new Map();
      (Array.isArray(size?.items) ? size.items : []).forEach((item) => {
        const name = String(item?.name || "").trim();
        if (name && item?.value !== undefined && item?.value !== null) {
          valuesByHeader.set(name, String(item.value));
        }
      });
      return {
        size: String(size?.name || "").trim() || null,
        values: headers.map((header) => valuesByHeader.get(header) || ""),
      };
    }).filter((row) => row.size);
    if (rows.length === 0) return null;

    const rawImage = String(apiResponse?.data?.webImage || "");
    const diagramImage = rawImage.startsWith("//") ? `https:${rawImage}` : rawImage || null;
    const legend = headers.map((label, index) => ({ number: index + 1, label }));
    return { headers, rows, diagramImage, legend: diagramImage ? legend : null };
  }

  // [getStoredRefChart] storage의 기준 상품 실측표 캐시를 읽는다. 유효한 표면 반환, 없거나 만료/실패 기록이면 undefined.
  async function getStoredRefChart(key) {
    try {
      const entry = (await chrome.storage.local.get(key))[key];
      if (!entry || typeof entry !== "object" || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now()) {
        return undefined;
      }
      if (entry.chart && typeof entry.chart === "object") return entry.chart;

      // 이전 버전은 실패(null)를 24시간 저장했다. 삭제해 캐시 미스로 처리한다.
      try {
        await chrome.storage.local.remove(key);
      } catch (err) {
        console.warn("[사이즈위젯] 실패한 기준 상품 실측표 캐시 삭제 실패:", err);
      }
      return undefined;
    } catch (err) {
      console.warn("[사이즈위젯] 기준 상품 실측표 캐시 읽기 실패:", err);
      return undefined;
    }
  }

  // [storeRefChart] 유효한 실측표만 24시간 만료로 storage에 저장한다(null은 저장하지 않음).
  async function storeRefChart(key, chart) {
    if (!chart || typeof chart !== "object") return;
    try {
      await chrome.storage.local.set({
        [key]: { expiresAt: Date.now() + REF_CHART_CACHE_TTL_MS, chart },
      });
    } catch (err) {
      console.warn("[사이즈위젯] 기준 상품 실측표 캐시 저장 실패:", err);
    }
  }

  // [requestRefSizeChartOnce] background(FETCH_REF_SIZE_CHART)로 기준 상품 실측표를 한 번 요청한다.
  //   5초 안에 응답이 없거나 오류면 null로 끝낸다(예외를 던지지 않음). 성공 시 번호형 매핑도 계산해 붙인다.
  function requestRefSizeChartOnce(goodsNo) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (chart) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(chart);
      };
      timer = setTimeout(() => {
        console.warn(`[사이즈위젯] 기준 상품(${goodsNo}) 실측표 API 요청 시간 초과`);
        finish(null);
      }, REF_CHART_REQUEST_TIMEOUT_MS);

      try {
        chrome.runtime.sendMessage({ type: "FETCH_REF_SIZE_CHART", goodsNo }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn("[사이즈위젯] 기준 상품 실측표 API 조회 실패:", chrome.runtime.lastError.message);
            finish(null);
            return;
          }
          const chart = response?.ok ? convertActualSizeApiToChart(response.body) : null;
          if (chart) chart.numberedSizeMap = deriveNumberedSizeMapFromChart(chart);
          finish(chart);
        });
      } catch (err) {
        console.warn("[사이즈위젯] 기준 상품 실측표 API 조회 중 오류:", err);
        finish(null);
      }
    });
  }

  // [fetchActualSizeChartForGoodsNo] 기준 상품 실측표를 메모리 캐시 → storage 캐시 → API 순으로 가져온다.
  //   실패(null)나 오류는 메모리 캐시에서 지워 다음에 다시 시도할 수 있게 한다.
  async function fetchActualSizeChartForGoodsNo(goodsNo) {
    const goodsNoKey = String(goodsNo);
    if (refChartCache.has(goodsNoKey)) return refChartCache.get(goodsNoKey);

    const storageKey = `${REF_CHART_CACHE_PREFIX}${goodsNoKey}`;
    const promise = (async () => {
      const storedChart = await getStoredRefChart(storageKey);
      if (storedChart !== undefined) {
        if (storedChart) storedChart.numberedSizeMap = deriveNumberedSizeMapFromChart(storedChart);
        return storedChart;
      }

      const chart = await requestRefSizeChartOnce(goodsNoKey);
      await storeRefChart(storageKey, chart);
      return chart;
    })();

    refChartCache.set(goodsNoKey, promise);
    promise.then((chart) => {
      if (!chart && refChartCache.get(goodsNoKey) === promise) {
        refChartCache.delete(goodsNoKey);
      }
    }, () => {
      if (refChartCache.get(goodsNoKey) === promise) refChartCache.delete(goodsNoKey);
    });
    return promise;
  }

  // 실측표 헤더 이름을 비교 가능하게 정규화(숫자·괄호·공백 제거) — "①총장", "총장(cm)"처럼
  // 표기가 조금 달라도 "총장"으로 같이 취급하기 위함.
  function normalizeMeasurementHeader(h) {
    return String(h || "").replace(/[\s0-9()①-⑳]/g, "");
  }

  // 두 상품의 실측표에서 "같은 사이즈 행" + "이름이 같은 측정 항목"을 찾아 cm 차이를 낸다.
  // 공통 항목이 여러 개면 총장/가슴단면처럼 사이즈 체감에 가장 직접적인 항목을 우선한다.
  const MEASUREMENT_PRIORITY = ["가슴단면", "가슴둘레", "어깨너비", "총장", "소매길이"];

  // 번호형 사이즈 상품의 번호↔표준사이즈 대응표를 실제 실측표에서 구한다. SIZE_CM_MAP은
  // 신체 호수이고 상품 가슴단면은 여유분이 포함된 옷 치수이므로, 가슴단면은 호수 절반에
  // 상품 여유분 9cm를 더한 값과 비교한다. 여러 번호 행 중 가장 잘 맞는 연속 구간을 택하되
  // 표준 범위에서 크게 벗어나면 임의로 끝 사이즈에 끼워 넣지 않는다.
  function getNumberedMeasurementCalibration(header) {
    const normalized = normalizeMeasurementHeader(header).toLowerCase();
    if (/가슴단면|가슴너비|가슴폭|chestwidth|chestbreadth|pitto?pit/.test(normalized)) {
      return SIZE_LADDER.map((letter) => SIZE_CM_MAP[letter] / 2 + 9);
    }
    if (/가슴둘레|chestcircumference/.test(normalized)) {
      return SIZE_LADDER.map((letter) => SIZE_CM_MAP[letter]);
    }
    return null;
  }

  // 번호형 매핑에 쓸 측정 열(가슴단면 등)의 인덱스를 찾는다. 없으면 −1.
  function findNumberedMeasurementColumn(headers) {
    for (const pref of MEASUREMENT_PRIORITY) {
      const index = headers.findIndex((header) => {
        const normalized = normalizeMeasurementHeader(header);
        return normalized === pref || normalized.startsWith(pref);
      });
      if (index !== -1) return index;
    }
    // 가슴너비/가슴폭/영문 chest width처럼 보정 가능한 동의어도 열 후보로 인정한다.
    return headers.findIndex((header) => !!getNumberedMeasurementCalibration(header));
  }

  // [deriveNumberedSizeMapFromChart] 번호형(0~6) 사이즈 행이 있는 실측표에서 번호→표준 사이즈 대응표를 만든다.
  //   반환: { "1": "S", "2": "M", …, __status: "mapped", __measurementHeader } /
  //         { __status: "out-of-range" }(표준 범위와 오차가 큼) / null(판별 불가 → 고정 매핑 폴백)
  function deriveNumberedSizeMapFromChart(sizeChart) {
    if (!sizeChart || !Array.isArray(sizeChart.rows) || sizeChart.rows.length === 0) return null;
    if (!Array.isArray(sizeChart.headers)) return null;

    const numberedRows = sizeChart.rows
      .filter((row) => /^\s*[0-6]\s*$/.test(String(row.size || "")))
      .sort((a, b) => Number(a.size) - Number(b.size));
    if (numberedRows.length < 2 || numberedRows.length > SIZE_LADDER.length) return null;

    const colIndex = findNumberedMeasurementColumn(sizeChart.headers);
    if (colIndex === -1) return null;
    const standardValues = getNumberedMeasurementCalibration(sizeChart.headers[colIndex]);
    if (!standardValues) return null;

    const measuredValues = numberedRows.map((row) => {
      const rawValue = String(row.values?.[colIndex] ?? "").replace(/,/g, "");
      return Number.parseFloat(rawValue);
    });
    if (measuredValues.some((value) => !Number.isFinite(value))) return null;

    // 행 순서와 측정값이 함께 커지지 않으면, 이 표만으로 안전한 표준 사이즈 방향을
    // 정할 수 없으므로 일반 고정 매핑을 유지한다. 0.1cm 미만 차이도 표시 반올림으로
    // 생겼을 가능성이 있어 구분 가능한 값으로 취급하지 않는다.
    for (let i = 1; i < measuredValues.length; i += 1) {
      if (measuredValues[i] - measuredValues[i - 1] < 0.1) return null;
    }

    // 숫자 사이즈의 실제 치수 범위에 가장 잘 맞는 연속 표준 사이즈 구간을 고른다.
    let bestStart = -1;
    let bestError = Infinity;
    for (let start = 0; start <= standardValues.length - measuredValues.length; start += 1) {
      const error = measuredValues.reduce((sum, value, index) => {
        const diff = value - standardValues[start + index];
        return sum + diff * diff;
      }, 0);
      if (error < bestError) {
        bestError = error;
        bestStart = start;
      }
    }
    if (bestStart < 0) return null;
    const rmsError = Math.sqrt(bestError / measuredValues.length);
    if (rmsError > 3.25) return { __status: "out-of-range" };

    const map = {};
    numberedRows.forEach((row, index) => {
      map[String(row.size).trim()] = SIZE_LADDER[bestStart + index];
    });
    map.__status = "mapped";
    map.__measurementHeader = sizeChart.headers[colIndex];
    return map;
  }

  // 번호 사이즈 추천 문구 뒤에 붙일 근거 문구를 만든다(예: "(2 ≈ M · 실측 가슴단면 55cm 기준 근사)"). 근거가 없으면 빈 문자열.
  function getNumberedSizeEvidence(availableLabel, numberedSizeMap, sizeChart) {
    if (!/^[0-6]$/.test(String(availableLabel || "").trim())) return "";
    const mappedLetter = numberedSizeMap?.[String(availableLabel).trim()];
    if (!mappedLetter || !sizeChart || !Array.isArray(sizeChart.rows)) return "";
    const columnIndex = sizeChart.headers?.indexOf(numberedSizeMap.__measurementHeader) ?? -1;
    if (columnIndex < 0) return "";
    const row = sizeChart.rows.find((item) => String(item.size).trim() === String(availableLabel).trim());
    const value = Number.parseFloat(String(row?.values?.[columnIndex] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(value)) return "";
    const measureName = String(numberedSizeMap.__measurementHeader).replace(/^\d+/, "").trim();
    return ` <span class="hint">(${escapeHtml(availableLabel)} ≈ ${escapeHtml(mappedLetter)} · 실측 ${escapeHtml(measureName)} ${value}cm 기준 근사)</span>`;
  }

  // findChartRowForSize()는 "정확히(혹은 cm 환산상 정확히) 같은 사이즈" 행만 찾는다.
  // 그런데 실측 비교 폴백이 필요한 바로 그 상황 — "이 상품은 기준 사이즈를 아예 안 판다" —
  // 에서는 현재 상품 실측표에 그 사이즈 행 자체가 없는 게 당연해서, 정확 일치만 찾으면 항상
  // null이 나와 폴백이 조용히 무력화되는 문제가 있었다(실제로 재현/확인함: 이 상품은
  // XS/S/M만 팔고 기준은 L을 구매 → 정확 일치 검색은 항상 실패). 그래서 정확히 맞는 행이
  // 없으면 cm이 가장 가까운 행으로 대신 비교한다 — "어차피 안 파는 사이즈"를 비교할 때는
  // 이게 유일하게 의미 있는 근사치다.
  function findNearestChartRow(sizeText, sizeChart) {
    const exact = findChartRowForSize(sizeText, sizeChart);
    if (exact) return exact;
    if (!sizeChart || !Array.isArray(sizeChart.rows) || sizeChart.rows.length === 0) return null;
    const target = parseSizeLetter(sizeText, sizeChart.numberedSizeMap || null);
    if (target) {
      let best = null;
      let bestDiff = Infinity;
      sizeChart.rows.forEach((row) => {
        const parsed = parseSizeLetter(row.size, sizeChart.numberedSizeMap || null);
        if (!parsed) return;
        const diff = Math.abs(parsed.cm - target.cm);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = row;
        }
      });
      if (best) return best;
    }
    // 버그 수정(Reality Checker가 발견): 위 로직은 "찾는 사이즈"뿐 아니라 "실측표 행 자체의
    // 라벨"도 parseSizeLetter로 읽혀야만 후보로 인정했다. 그런데 "F"/"FREE"처럼 그 상품이
    // 파는 사이즈가 애초에 라벨 자체를 못 읽는 경우(예: products/1200496 카타르시스 코트_FREE,
    // 실측표에 "F" 행 하나뿐)에는 그 유일한 행조차 후보가 못 돼서 항상 null이 나왔고, 그게
    // 실측 폴백을 영구히 "unavailable"로 만들어 조용히 점수 기반 문구로 되돌아가는 버그였다.
    // 실측표에 행이 정확히 하나뿐이면(=이 상품이 파는 사이즈가 그거 하나뿐이라는 뜻) 라벨을
    // 못 읽더라도 그 행을 그대로 쓴다 — "이 상품에서 비교할 수 있는 사이즈는 이것뿐"이라는
    // 사실 자체가 이미 명확하기 때문이다.
    if (sizeChart.rows.length === 1) return sizeChart.rows[0];
    return null;
  }

  // [compareActualMeasurements] 현재 상품(currentSizeText 행)과 기준 상품(refSizeText 행)의 실측을 비교한다.
  //   두 표에 공통으로 있는 측정 항목 중 우선순위(가슴단면 > 가슴둘레 > 어깨 > 총장 > 소매)가 가장 높은 항목의
  //   cm 차이(diffCm = 현재 − 기준)를 돌려준다. 비교할 행/항목이 없으면 null.
  function compareActualMeasurements(currentChart, currentSizeText, refChart, refSizeText) {
    if (!currentChart || !refChart || !currentSizeText || !refSizeText) return null;
    const currentRow = findNearestChartRow(currentSizeText, currentChart);
    const refRow = findNearestChartRow(refSizeText, refChart);
    if (!currentRow || !refRow) return null;

    const candidates = [];
    currentChart.headers.forEach((h, ci) => {
      const key = normalizeMeasurementHeader(h);
      if (!key) return;
      const ri = refChart.headers.findIndex((rh) => normalizeMeasurementHeader(rh) === key);
      if (ri === -1) return;
      const cVal = parseFloat(currentRow.values[ci]);
      const rVal = parseFloat(refRow.values[ri]);
      if (!Number.isFinite(cVal) || !Number.isFinite(rVal)) return;
      candidates.push({ measurementName: h.trim(), currentValue: cVal, refValue: rVal });
    });
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const pa = MEASUREMENT_PRIORITY.findIndex((p) => a.measurementName.includes(p));
      const pb = MEASUREMENT_PRIORITY.findIndex((p) => b.measurementName.includes(p));
      const ra = pa === -1 ? 999 : pa;
      const rb = pb === -1 ? 999 : pb;
      return ra - rb;
    });

    const best = candidates[0];
    const diffCm = Math.round((best.currentValue - best.refValue) * 10) / 10;
    return { ...best, diffCm, currentSizeLabel: currentRow.size, refSizeLabel: refRow.size };
  }

  // 구매 이력 기준의 추천 계산과 별개로, 사용자가 보기 쉽게 현재 추천 사이즈와 실제
  // 구매 사이즈의 부위별 실측을 나란히 보여준다. 이 함수군은 추천 사이즈를 바꾸지 않고
  // 판단 근거만 만든다.
  // 착용 후기(부위별 '짧았음/딱 맞음/길었음' 등)와 마지막으로 적용한 판단 기준 상품을 저장하는 storage 키 접두사
  const FIT_NOTE_KEY_PREFIX = "sizeWidget:fitNotes:";
  const DECISION_REFERENCE_KEY_PREFIX = "sizeWidget:decisionReference:";
  // 사용자가 구매했던 옷에 남길 수 있는 부위별 착용 후기 항목과 선택지
  const FIT_NOTE_FIELDS = [
    { id: "sleeve", label: "소매", options: [["short", "짧았음"], ["fit", "딱 맞음"], ["long", "길었음"]] },
    { id: "length", label: "기장", options: [["short", "짧았음"], ["fit", "딱 맞음"], ["long", "길었음"]] },
    { id: "chest", label: "가슴", options: [["small", "작았음"], ["fit", "딱 맞음"], ["large", "컸음"]] },
    { id: "shoulder", label: "어깨", options: [["small", "작았음"], ["fit", "딱 맞음"], ["large", "컸음"]] },
  ];
  // 판단 기준 패널에서 cm로 비교할 부위와, 실측표 헤더에서 그 부위로 인정할 별칭들
  const DECISION_MEASUREMENTS = [
    { id: "sleeve", label: "소매", aliases: ["소매길이", "소매장", "팔길이"] },
    { id: "length", label: "총장", aliases: ["총장", "기장"] },
    // 가슴단면과 가슴둘레는 단위가 달라 서로 비교하지 않는다. 단면 계열의 기존 별칭만
    // 같은 부위로 묶어 비교하고, 둘레는 양쪽 헤더가 정확히 같은 경우에만 보조 비교한다.
    { id: "chest", label: "가슴단면", aliases: ["가슴단면", "가슴너비", "가슴폭"] },
    { id: "shoulder", label: "어깨", aliases: ["어깨너비", "어깨넓이", "어깨폭"] },
  ];

  // 비교 기준 목록 중 구매 이력 상품(refGoodsNo가 있는 항목)만 돌려준다.
  function getHistoryBasisOptions(state) {
    return state.data.basisOptions.filter((option) => option.refGoodsNo);
  }

  // 현재 추천 기준으로 선택된 구매 이력 상품(없으면 null — 평소 입는 사이즈 기준일 때).
  function getSelectedRecommendationReference(state) {
    return state.data.basisOptions.find((option) => option.id === state.selectedBasisId && option.refGoodsNo) || null;
  }

  // 판단 기준 패널에서 '적용'까지 마친 구매 이력 상품.
  function getAppliedDecisionReference(state) {
    if (!state.appliedDecisionReferenceId) return null;
    return state.data.basisOptions.find((option) => option.id === state.appliedDecisionReferenceId && option.refGoodsNo) || null;
  }

  // 판단 기준 패널에서 편집 중(아직 적용 전)인 구매 이력 상품.
  function getDraftDecisionReference(state) {
    if (!state.decisionDraftId) return null;
    return state.data.basisOptions.find((option) => option.id === state.decisionDraftId && option.refGoodsNo) || null;
  }

  // 판단 기준으로 실제 표시할 상품: 적용된 상품 → 없으면 첫 번째 구매 이력 후보.
  function getDecisionReference(state) {
    const applied = getAppliedDecisionReference(state);
    if (applied) return applied;
    // 마지막으로 적용한 기준이 아직 없을 때만 기존 최신 구매 이력 폴백을 쓴다. 이 폴백은
    // 구매 이력 추천(selectedBasisId)이나 추천 계산을 바꾸지 않고 판단 기준 표시만 위한 값이다.
    return getHistoryBasisOptions(state)[0] || null;
  }

  // 계정별로 마지막 판단 기준 상품을 저장하는 storage 키.
  function getDecisionReferenceStorageKey() {
    return `${DECISION_REFERENCE_KEY_PREFIX}${String(currentLoginInfo.identity || "anonymous")}`;
  }

  // 실측표 헤더 중 해당 부위(별칭 포함)에 해당하는 열 인덱스를 찾는다. 없으면 −1.
  function getDecisionMeasurementColumn(headers, measurement) {
    return headers.findIndex((header) => {
      const normalized = normalizeMeasurementHeader(header);
      return measurement.aliases.some((alias) => normalized === alias || normalized.startsWith(alias));
    });
  }

  // 실측 값 문자열("55.5", "1,050" 등)을 숫자로 바꾼다. 숫자가 아니면 null.
  function parseMeasurementValue(value) {
    const parsed = Number.parseFloat(String(value ?? "").replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  // [compareDecisionMeasurements] 판단 기준 패널용: 추천 사이즈 행과 기준 옷 구매 사이즈 행을
  //   소매/총장/가슴단면/어깨 부위별로 비교해 cm 차이 목록을 만든다. 같은 사이즈 행이 없으면 null.
  function compareDecisionMeasurements(currentChart, currentSize, refChart, refSize) {
    const currentRow = findChartRowForSize(currentSize, currentChart);
    const refRow = findChartRowForSize(refSize, refChart);
    if (!currentRow || !refRow) return null;

    const comparisons = DECISION_MEASUREMENTS.map((measurement) => {
      const currentIndex = getDecisionMeasurementColumn(currentChart.headers || [], measurement);
      const refIndex = getDecisionMeasurementColumn(refChart.headers || [], measurement);
      if (currentIndex < 0 || refIndex < 0) return null;
      const currentValue = parseMeasurementValue(currentRow.values?.[currentIndex]);
      const refValue = parseMeasurementValue(refRow.values?.[refIndex]);
      if (currentValue === null || refValue === null) return null;
      return {
        ...measurement,
        currentValue,
        refValue,
        diffCm: Math.round((currentValue - refValue) * 10) / 10,
      };
    }).filter(Boolean);

    return comparisons.length
      ? { comparisons, currentSizeLabel: currentRow.size, refSizeLabel: refRow.size }
      : null;
  }

  // 긴 상품명을 16자까지만 남기고 말줄임(…)한다.
  function shortReferenceName(name) {
    const text = String(name || "구매한 옷").trim();
    return Array.from(text).length > 16 ? `${Array.from(text).slice(0, 16).join("")}…` : text;
  }

  // cm 값을 절댓값 기준 소수 첫째 자리까지 표기(정수면 소수점 없이).
  function formatCm(value) {
    const rounded = Math.round(Math.abs(value) * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  // 부위와 차이 부호로 '길어요/짧아요'(소매·총장), '넓어요/좁아요'(가슴·어깨) 같은 방향 표현을 정한다.
  function getDecisionDirection(id, diffCm) {
    const isLength = id === "sleeve" || id === "length";
    const isWidth = id === "chest" || id === "shoulder";
    if (isLength) return diffCm > 0 ? "길어요" : "짧아요";
    if (isWidth) return diffCm > 0 ? "넓어요" : "좁아요";
    return diffCm > 0 ? "커요" : "작아요";
  }

  // 부호를 붙인 cm 표기(예: "+2.5cm", "-1cm").
  function formatSignedCm(value) {
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${sign}${formatCm(value)}cm`;
  }

  // [formatDecisionLine] 부위 하나의 cm 비교 결과를 사용자의 착용 후기와 엮어 한 줄 안내로 만든다.
  //   예) 전에 소매가 길었다고 했는데 이번 상품도 더 길면 '⚠', 반대로 줄어들면 '✓'.
  //   후기가 없으면 1cm 이내는 '비슷해요', 그 외에는 차이와 방향만 표시한다.
  function formatDecisionLine(comparison, fitNotes) {
    const note = fitNotes?.[comparison.id];
    const absolute = Math.abs(comparison.diffCm);
    const similar = absolute <= 1;
    const isLength = comparison.id === "sleeve" || comparison.id === "length";
    const direction = getDecisionDirection(comparison.id, comparison.diffCm);
    const difference = formatSignedCm(comparison.diffCm);
    const tooLarge = isLength ? note === "long" : note === "large";
    const tooSmall = isLength ? note === "short" : note === "small";

    if (tooLarge && comparison.diffCm >= -1) {
      return similar
        ? `⚠ ${comparison.label}: 전에 ${isLength ? "길다고" : "크다고"} 느꼈던 비교 대상과 비슷해요`
        : `⚠ ${comparison.label} ${difference}, 비교 대상보다 ${direction}`;
    }
    if (tooLarge && comparison.diffCm < -1) {
      return `✓ ${comparison.label} ${difference}, 비교 대상보다 ${direction}`;
    }
    if (tooSmall && comparison.diffCm <= 1) {
      return similar
        ? `⚠ ${comparison.label}: 전에 ${isLength ? "짧다고" : "작다고"} 느꼈던 비교 대상과 비슷해요`
        : `⚠ ${comparison.label} ${difference}, 비교 대상보다 ${direction}`;
    }
    if (tooSmall && comparison.diffCm > 1) {
      return `✓ ${comparison.label} ${difference}, 비교 대상보다 ${direction}`;
    }
    if (note === "fit" && absolute > 2) {
      return `⚠ ${comparison.label} ${difference}, 딱 맞았던 비교 대상보다 ${direction}`;
    }
    if (similar) return `${comparison.label}: 비교 대상과 1cm 이내로 비슷해요`;
    return `${comparison.label} ${difference}, 비교 대상보다 ${direction}`;
  }

  // [ensureFitNotes] 기준 옷의 저장된 착용 후기를 storage에서 한 번만 읽어 state에 넣고,
  //   편집용 임시값(fitNoteDrafts)을 준비한 뒤 관련 패널을 다시 그린다.
  async function ensureFitNotes(root, state, reference) {
    if (!reference?.refGoodsNo) return;
    const goodsNo = String(reference.refGoodsNo);
    if (state.fitNotesStatus[goodsNo]) return;
    state.fitNotesStatus[goodsNo] = "loading";
    try {
      const key = `${FIT_NOTE_KEY_PREFIX}${goodsNo}`;
      const stored = (await chrome.storage.local.get(key))[key];
      state.fitNotes[goodsNo] = stored && typeof stored === "object" ? stored : {};
      state.fitNotesStatus[goodsNo] = "loaded";
    } catch (error) {
      console.warn("[사이즈위젯] 착용 후기 읽기 실패:", error);
      state.fitNotes[goodsNo] = {};
      state.fitNotesStatus[goodsNo] = "failed";
    }
    // 선택만 바꾼 뒤에는 저장된 후기를 임시 편집값으로 복사해 보여 준다. 이 시점에는
    // 판단 기준과 추천 결과를 건드리지 않는다.
    if (!Object.prototype.hasOwnProperty.call(state.fitNoteDrafts, goodsNo)) {
      state.fitNoteDrafts[goodsNo] = { ...state.fitNotes[goodsNo] };
    }
    if (getDraftDecisionReference(state)?.refGoodsNo === reference.refGoodsNo) {
      renderFitNotes(root, state);
    }
    if (getDecisionReference(state)?.refGoodsNo === reference.refGoodsNo) {
      renderDecisionBasis(root, state);
    }
  }

  // 편집 중인 착용 후기 임시값을 돌려준다(없으면 저장된 후기를 복사해 만든다. 아직 로딩 전이면 null).
  function getDraftFitNotes(state, goodsNo) {
    if (!Object.prototype.hasOwnProperty.call(state.fitNoteDrafts, goodsNo)) {
      const status = state.fitNotesStatus[goodsNo];
      if (status === "loaded" || status === "failed") {
        state.fitNoteDrafts[goodsNo] = { ...(state.fitNotes[goodsNo] || {}) };
      }
    }
    return state.fitNoteDrafts[goodsNo] || null;
  }

  // 기록된 착용 후기 항목 수를 센다.
  function countFitNotes(notes) {
    return FIT_NOTE_FIELDS.filter((field) => !!notes?.[field.id]).length;
  }

  // [renderFitNotes] '구매한 옷으로 비교' 패널(#fitNotesPanel)을 그린다.
  //   - 구매 이력 기준이 선택되지 않았으면 숨김
  //   - 적용 완료 상태면 한 줄 요약 + [변경] 버튼
  //   - 편집 상태면 구매 이력 선택 + 부위별 착용 후기 버튼 + [적용]/[후기 초기화]/[취소]
  function renderFitNotes(root, state) {
    const panel = root.getElementById("fitNotesPanel");
    if (!panel) return;
    if (!getSelectedRecommendationReference(state)) {
      panel.hidden = true;
      panel.innerHTML = "";
      return;
    }
    panel.hidden = false;
    const historyOptions = getHistoryBasisOptions(state);
    if (historyOptions.length === 0) {
      panel.innerHTML = "";
      return;
    }
    const applied = getAppliedDecisionReference(state);

    // 적용 뒤에는 편집 컨트롤을 접고, 현재 판단 기준과 후기 반영 개수만 한 줄로 남긴다.
    if (applied && !state.decisionEditorOpen) {
      const appliedGoodsNo = String(applied.refGoodsNo);
      if (!state.fitNotesStatus[appliedGoodsNo]) void ensureFitNotes(root, state, applied);
      const appliedNotes = state.fitNotes[appliedGoodsNo] || {};
      panel.innerHTML = `
        <div class="purchase-compare purchase-compare--summary">
          <div class="purchase-compare-title">구매한 옷으로 비교</div>
          <div class="purchase-compare-summary">기준: ${escapeHtml(shortReferenceName(applied.main))} (${escapeHtml(applied.sizeOption || "구매 사이즈 확인 안됨")}) · 후기 ${countFitNotes(appliedNotes)}개 반영</div>
          <button type="button" class="purchase-compare-change" data-decision-change>변경</button>
        </div>
      `;
      panel.querySelector("[data-decision-change]")?.addEventListener("click", () => {
        state.decisionDraftId = applied.id;
        state.decisionEditorOpen = true;
        getDraftFitNotes(state, String(applied.refGoodsNo));
        renderFitNotes(root, state);
      });
      return;
    }

    const reference = getDraftDecisionReference(state) || getDecisionReference(state);
    if (reference && !state.decisionDraftId) state.decisionDraftId = reference.id;
    const selectedId = state.decisionDraftId || "";
    const selectMarkup = `
      <label class="purchase-compare-label" for="purchaseCompareSelect">구매 이력</label>
      <select class="basis-select purchase-compare-select" id="purchaseCompareSelect">
        <option value="" ${selectedId ? "" : "selected"} disabled>과거 구매한 아우터 중 선택하세요</option>
        ${historyOptions.map((option) =>
          `<option value="${escapeHtml(option.id)}" ${option.id === selectedId ? "selected" : ""}>${escapeHtml(option.main)} — 구매 사이즈 ${escapeHtml(option.sizeOption || "확인 안됨")}</option>`
        ).join("")}
      </select>`;

    if (!reference) {
      panel.innerHTML = `<div class="purchase-compare"><div class="purchase-compare-title">구매한 옷으로 비교</div>${selectMarkup}</div>`;
      return;
    }

    const goodsNo = String(reference.refGoodsNo);
    const status = state.fitNotesStatus[goodsNo];
    const draftNotes = getDraftFitNotes(state, goodsNo);
    const notesMarkup = status === "loaded" || status === "failed"
      ? `
        <p class="purchase-compare-help">${escapeHtml(shortReferenceName(reference.main))} (${escapeHtml(reference.sizeOption || "구매 사이즈 확인 안됨")})의 착용 후기를 고르세요.</p>
        ${FIT_NOTE_FIELDS.map((field) => `
          <div class="fit-note-row">
            <span>${field.label}</span>
            <div class="fit-note-options">
              <button type="button" data-fit-note-field="${field.id}" data-fit-note-value=""${!draftNotes?.[field.id] ? ' class="selected"' : ""}>미기록</button>
              ${field.options.map(([value, label]) =>
                `<button type="button" data-fit-note-field="${field.id}" data-fit-note-value="${value}"${draftNotes?.[field.id] === value ? ' class="selected"' : ""}>${label}</button>`
              ).join("")}
            </div>
          </div>
        `).join("")}
        <div class="purchase-compare-actions">
          <button type="button" class="purchase-compare-apply" data-decision-apply>적용</button>
          <button type="button" class="purchase-compare-secondary" data-decision-reset>후기 초기화</button>
          <button type="button" class="purchase-compare-secondary" data-decision-cancel>취소</button>
        </div>
        <p class="purchase-compare-help">적용 전에는 후기와 판단 기준·추천 결과가 바뀌지 않아요.</p>`
      : '<p class="fit-notes-loading">선택한 옷의 착용 후기를 불러오는 중…</p>';
    panel.innerHTML = `
      <div class="purchase-compare">
        <div class="purchase-compare-title">구매한 옷으로 비교</div>
        ${selectMarkup}
        ${notesMarkup}
      </div>
    `;

    panel.querySelector("#purchaseCompareSelect")?.addEventListener("change", () => {
      const nextId = panel.querySelector("#purchaseCompareSelect").value;
      if (!nextId) return;
      // 비교 패널에서 옷을 바꿔도 추천용 select와 서로 다른 옷을 가리키지 않게 한다.
      // 추천 기준 변경과 같은 경로를 써서 판단 기준은 즉시 동기화하고, 편집 화면은 유지한다.
      state.selectedBasisId = nextId;
      syncDecisionReferenceFromRecommendation(root, state, nextId);
      mountBasisList(root, state);
      renderScale(root, state);
      renderVerdict(root, state);
    });
    if (!status) {
      void ensureFitNotes(root, state, reference);
      return;
    }
    panel.querySelectorAll("[data-fit-note-field]").forEach((button) => {
      button.addEventListener("click", () => {
        const field = button.dataset.fitNoteField;
        const value = button.dataset.fitNoteValue;
        const next = { ...(getDraftFitNotes(state, goodsNo) || {}) };
        if (value) next[field] = value;
        else delete next[field];
        state.fitNoteDrafts[goodsNo] = next;
        // 버튼 클릭은 편집 중인 임시값만 바꾼다. 저장·판단 기준 재렌더는 적용에서만 한다.
        renderFitNotes(root, state);
      });
    });
    panel.querySelector("[data-decision-reset]")?.addEventListener("click", () => {
      state.fitNoteDrafts[goodsNo] = {};
      renderFitNotes(root, state);
    });
    panel.querySelector("[data-decision-cancel]")?.addEventListener("click", () => {
      const appliedReference = getAppliedDecisionReference(state);
      state.decisionDraftId = appliedReference?.id || getDecisionReference(state)?.id || null;
      if (appliedReference) state.decisionEditorOpen = false;
      const restoreReference = getDraftDecisionReference(state);
      if (restoreReference) {
        const restoreGoodsNo = String(restoreReference.refGoodsNo);
        state.fitNoteDrafts[restoreGoodsNo] = { ...(state.fitNotes[restoreGoodsNo] || {}) };
      }
      renderFitNotes(root, state);
      renderDecisionBasis(root, state);
    });
    panel.querySelector("[data-decision-apply]")?.addEventListener("click", () => {
      applyDecisionReference(root, state, reference);
    });
  }

  // 판단 기준 상품을 '적용됨'으로 확정하고, 이전 cm 비교 결과는 무효화한다.
  function setAppliedDecisionReference(state, reference, { editorOpen = false } = {}) {
    state.appliedDecisionReferenceId = reference.id;
    state.decisionDraftId = reference.id;
    state.decisionEditorOpen = editorOpen;
    state.decisionComparison = null;
  }

  // 추천 select가 빈 값이면 판단 기준 영역은 보이지 않아야 하므로 마지막 기준 설정만 지운다.
  // 상품별 착용 후기(sizeWidget:fitNotes:<goodsNo>)는 여기서 절대 지우지 않는다.
  function clearDecisionReferenceForEmptyRecommendation(state) {
    const abandonedDraft = getDraftDecisionReference(state);
    if (abandonedDraft?.refGoodsNo) delete state.fitNoteDrafts[String(abandonedDraft.refGoodsNo)];
    state.appliedDecisionReferenceId = null;
    state.decisionDraftId = null;
    state.decisionEditorOpen = true;
    state.decisionComparison = null;
    if (state.decisionReferenceStorageState === "cleared") return;
    state.decisionReferenceStorageState = "cleared";
    void chrome.storage.local
      .remove(getDecisionReferenceStorageKey())
      .catch((error) => console.warn("[사이즈위젯] 빈 추천 기준 판단 기준 삭제 실패:", error));
  }

  // 추천용 구매 이력 select에서 옷을 고르면, 판단 기준도 같은 옷으로 바로 확정한다.
  // 패널에서 고르던 중이었으면 임시 후기값은 버리고, 새 옷에 저장된 후기만 다시 읽은 뒤
  // 저장된 후기 버튼이 선택된 편집 화면을 연다.
  function syncDecisionReferenceFromRecommendation(root, state, referenceId) {
    const reference = state.data.basisOptions.find((option) => option.id === referenceId && option.refGoodsNo);
    if (!reference) return;

    const abandonedDraft = getDraftDecisionReference(state);
    if (state.decisionEditorOpen && abandonedDraft?.refGoodsNo) {
      delete state.fitNoteDrafts[String(abandonedDraft.refGoodsNo)];
    }
    const goodsNo = String(reference.refGoodsNo);
    // 같은 옷을 편집 중이었다 해도 저장 전 임시값이 아니라 저장된 후기를 적용한다.
    delete state.fitNoteDrafts[goodsNo];
    setAppliedDecisionReference(state, reference, { editorOpen: true });
    state.decisionReferenceStorageState = "saved";
    void ensureFitNotes(root, state, reference);
    void chrome.storage.local
      .set({ [getDecisionReferenceStorageKey()]: { goodsNo, savedAt: Date.now() } })
      .catch((error) => console.warn("[사이즈위젯] 추천 기준 판단 기준 저장 실패:", error));
  }

  // [applyDecisionReference] 판단 기준 패널의 [적용]: 편집 중인 착용 후기를 확정·저장하고
  //   판단 기준을 이 상품으로 바꾼다(추천 사이즈 계산 자체는 바꾸지 않음).
  function applyDecisionReference(root, state, reference) {
    const goodsNo = String(reference.refGoodsNo);
    const nextNotes = { ...(getDraftFitNotes(state, goodsNo) || {}) };
    state.fitNotes[goodsNo] = nextNotes;
    setAppliedDecisionReference(state, reference);
    // 판단 기준용 패널의 적용은 추천 기준(selectedBasisId)과 추천 결과를 건드리지 않는다.
    // 구매 이력 기반 추천은 아래의 전용 select를 사용자가 직접 바꿀 때만 전환된다.
    renderFitNotes(root, state);
    renderDecisionBasis(root, state);
    void Promise.all([
      chrome.storage.local.set({ [`${FIT_NOTE_KEY_PREFIX}${goodsNo}`]: nextNotes }),
      chrome.storage.local.set({ [getDecisionReferenceStorageKey()]: { goodsNo, savedAt: Date.now() } }),
    ]).catch((error) => console.warn("[사이즈위젯] 구매 옷 비교 저장 실패:", error));
  }

  // [ensureDecisionComparison] 기준 옷 실측표를 받아 판단 기준용 부위별 비교를 계산하고 다시 그린다.
  //   그 사이 다른 비교가 시작됐으면(key 불일치) 결과를 버린다.
  async function ensureDecisionComparison(root, state, reference, recommendedSize, key) {
    const refChart = await fetchActualSizeChartForGoodsNo(reference.refGoodsNo);
    if (state.decisionComparison?.key !== key) return;
    const result = refChart
      ? compareDecisionMeasurements(state.sizeChart, recommendedSize, refChart, reference.sizeOption)
      : null;
    state.decisionComparison = {
      key,
      status: !refChart ? "fetch-failed" : result ? "ready" : "unavailable",
      result,
    };
    renderDecisionBasis(root, state);
  }

  // [renderDecisionBasis] '판단 기준' 박스(#decisionBasis)를 그린다.
  //   로그인·실측표·기준 옷·추천 사이즈 유무에 따라 안내 문구를 보여주고, 모두 갖춰지면
  //   부위별 cm 비교 결과를 최대 4줄로 표시한다. 비교는 비동기로 계산되며 key로 최신 여부를 확인한다.
  function renderDecisionBasis(root, state) {
    const title = root.getElementById("decisionBasis");
    const lines = root.getElementById("decisionBasisLines");
    if (!title || !lines) return;
    if (!getSelectedRecommendationReference(state)) {
      title.hidden = true;
      lines.textContent = "";
      return;
    }
    title.hidden = false;
    const titleLabel = title.querySelector(".decision-basis-title");
    const reference = getDecisionReference(state);

    if (!currentLoginInfo.loggedIn) {
      titleLabel.textContent = "판단 기준";
      lines.textContent = "로그인하면 구매한 옷과 cm로 비교해 드려요.";
      return;
    }
    if (!state.sizeChart?.rows?.length) {
      titleLabel.textContent = "판단 기준";
      lines.textContent = "이 상품은 실측표가 없어 cm 비교를 할 수 없어요.";
      return;
    }
    if (!reference) {
      titleLabel.textContent = "판단 기준";
      lines.textContent = currentLoginInfo.historyStatus === "loading"
        ? "구매 이력과 실측표를 확인하고 있어요."
        : "비교할 구매 이력이 없어요.";
      return;
    }

    // 다른 옷을 고르는 동안에는 이전 옷의 cm 결과를 계속 보여 주지 않는다. 실제
    // cm 비교 반영은 적용을 누를 때까지 보류하며, 추천 기준은 이 패널과 별개다.
    const applied = getAppliedDecisionReference(state);
    const draft = getDraftDecisionReference(state);
    if (state.decisionEditorOpen && applied && draft && draft.id !== applied.id) {
      titleLabel.textContent = "판단 기준";
      lines.textContent = "선택한 옷과 착용 후기를 적용하면 이 기준으로 cm 비교와 추천 결과를 갱신해요.";
      return;
    }

    const recommendedSize = root.getElementById("verdictText")?.querySelector("em")?.textContent?.trim();
    titleLabel.textContent = "판단 기준";
    if (!recommendedSize) {
      lines.textContent = "계산된 추천 사이즈가 판매되지 않아 cm 비교를 할 수 없어요.";
      return;
    }
    if (!reference.sizeOption) {
      lines.textContent = "기준 옷의 구매 사이즈를 확인하지 못해 cm 비교를 할 수 없어요.";
      return;
    }

    const key = `${reference.refGoodsNo}:${reference.sizeOption}:${recommendedSize}`;
    const comparison = state.decisionComparison;
    if (!comparison || comparison.key !== key) {
      state.decisionComparison = { key, status: "loading", result: null };
      lines.textContent = "구매한 옷의 실측표와 비교하는 중…";
      void ensureDecisionComparison(root, state, reference, recommendedSize, key);
      return;
    }
    if (comparison.status === "loading") {
      lines.textContent = "구매한 옷의 실측표와 비교하는 중…";
      return;
    }
    if (comparison.status === "fetch-failed") {
      lines.textContent = "구매한 옷의 실측표를 불러오지 못해 cm 비교를 할 수 없어요";
      return;
    }
    if (!comparison.result) {
      lines.textContent = "기준 옷 또는 추천 사이즈의 실측 행을 찾지 못해 cm 비교를 할 수 없어요.";
      return;
    }

    const notes = state.fitNotes[String(reference.refGoodsNo)] || {};
    lines.innerHTML = comparison.result.comparisons
      .slice(0, 4)
      .map((item) => `<div>${escapeHtml(formatDecisionLine(item, notes))}</div>`)
      .join("");
  }

  // cm 차이를 사이즈 조정 단계로 환산한다(요청 2의 표: 인접 사이즈 간 5cm 간격이 기준).
  function getMeasurementAdjustment(diffCm) {
    const CM_PER_STEP = 5;
    const steps = Math.min(2, Math.round(Math.abs(diffCm) / CM_PER_STEP));
    const dir = diffCm > 0 ? "down" : diffCm < 0 ? "up" : "none"; // 현재 상품이 기준보다 크면(+) 다운사이즈 권장
    if (steps === 0 || dir === "none") {
      return { steps: 0, dirSign: 0, direction: "none", label: "그대로 구매하는걸 추천드려요", shortLabel: "그대로" };
    }
    const dirSign = dir === "down" ? -1 : 1;
    const stepLabel = steps >= 2 ? "두 사이즈" : "한 사이즈";
    const dirLabel = dir === "up" ? "크게" : "작게";
    return {
      steps,
      dirSign,
      direction: dir,
      shortLabel: `${stepLabel} ${dirLabel}`,
      label: `${stepLabel} ${dirLabel} 구매하는걸 추천드려요`,
    };
  }

  // 실측표 컨테이너는 하이드레이션으로 뒤늦게 나타날 수 있으므로, MutationObserver +
  // 폴백 폴링으로 최대 timeoutMs까지 기다린다. 못 찾으면 null(실측 정보 없음)로 그냥 넘어간다
  // (원본 데모의 waitForSelector 타임아웃과 동일한 취급).
  function waitForSizeChart(timeoutMs) {
    return new Promise((resolve) => {
      const immediate = extractSizeChartInPage();
      if (immediate) {
        resolve(immediate);
        return;
      }
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        try {
          observer.disconnect();
        } catch (e) {}
        clearInterval(poll);
        clearTimeout(timer);
        resolve(val);
      };
      const observer = new MutationObserver(() => {
        const chart = extractSizeChartInPage();
        if (chart) finish(chart);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const poll = setInterval(() => {
        const chart = extractSizeChartInPage();
        if (chart) finish(chart);
      }, 150);
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  // ---------------------------------------------------------
  // 3) goodsNo 기준으로 위젯에 필요한 데이터 구성
  // ---------------------------------------------------------
  // [loadPredictionData] 위젯 렌더링에 필요한 데이터를 한 객체로 모은다.
  //   점수 우선순위: 실시간 리뷰(응답 10건 이상) > LOOKUP의 저장된 실측 점수 > 브랜드+카테고리 모델 예측.
  //   overrides: { usualSize, loggedIn, purchaseHistory, historyStatus, reviewResult, reviewStatus, sizeChart }
  async function loadPredictionData(goodsNo, overrides) {
    await loadModel();

    let product = LOOKUP[goodsNo];
    let live = null;

    if (!product) {
      live = getLiveBrandInfo();
    }

    const brandName = product?.brand ?? live?.brand ?? "(브랜드 미상)";
    const categoryName = product?.category ?? live?.category ?? "기타";
    const productName = product?.name ?? live?.name ?? "(상품 정보를 찾을 수 없어요)";

    const brandMarginal = marginalScore("brand", brandName);
    const categoryMarginal = marginalScore("category", categoryName);

    const hasActualData = product && product.actualScore !== null && product.actualScore !== undefined;
    const basisOptions = buildBasisOptions(overrides);
    const reviewResult = overrides.reviewResult || null;
    const hasEnoughLiveReviews =
      Number(reviewResult?.reviewCount) >= PRODUCT_REVIEW_MIN_RESPONSES &&
      Number.isFinite(reviewResult?.actualScore);
    const reviewStatus = overrides.reviewStatus || (reviewResult ? "insufficient" : "failed");

    return {
      fitDefault: "regular",
      productName,
      mode: hasEnoughLiveReviews || hasActualData ? "actual" : "predicted",
      reviewBased: hasEnoughLiveReviews,
      reviewCount: hasEnoughLiveReviews ? reviewResult.reviewCount : 0,
      reviewResponseCount: Number(reviewResult?.reviewCount) || 0,
      reviewStatus,
      brandSource: live ? "live" : product ? "lookup" : "unknown",
      combinedScore: hasEnoughLiveReviews
        ? reviewResult.actualScore
        : hasActualData
          ? product.actualScore
          : modelPredict(brandName, categoryName),
      brand: { name: brandName, score: brandMarginal.score, n: brandMarginal.n },
      category: { name: categoryName, score: categoryMarginal.score, n: categoryMarginal.n },
      sizeDist: hasEnoughLiveReviews ? reviewResult.sizeDist : hasActualData ? product.sizeDist : null,
      basisOptions,
      recommendedSize: overrides.usualSize || "M",
    };
  }

  // ---------------------------------------------------------
  // 4) 렌더링 (document.getElementById → shadow root 기준으로 변경)
  // ---------------------------------------------------------
  // "history-select" 그룹의 실제 구매 이력 후보는 추천 기준용 드롭다운과 판단 기준 패널의
  // 별도 select에 함께 표시한다. 나머지(평소 입는 사이즈, 로그인 안내, 이력 없음 안내)는
  // 기존처럼 개별 행으로 렌더링한다.
  // 평소 입는 사이즈를 직접 고르는 드롭다운의 고정 옵션 목록. XXS/XXXL/XXXXL 같은 극단
  // 사이즈는 실제로 드물어서 뺐다 — 실용적으로 가장 흔히 쓰는 6단계만 보여준다.
  const USUAL_SIZE_OPTIONS = ["XS", "S", "M", "L", "XL", "XXL"];

  // [renderBasisList] '비교 기준' 목록(#basisList)을 그린다.
  //   그룹 없는 항목은 클릭 가능한 행으로, "usual-select"는 평소 사이즈 드롭다운으로,
  //   "history-select"는 구매 이력 드롭다운 + 그 아래 판단 기준 패널 자리(#fitNotesPanel)로 그린다.
  //   onSelect(id): 기준 선택, onUsualSizeChange(size): 평소 사이즈 변경 콜백.
  function renderBasisList(root, el, options, onSelect, selectedBasisId, onUsualSizeChange) {
    el.innerHTML = "";
    const groups = new Map();

    options.forEach((opt) => {
      if (opt.group) {
        if (!groups.has(opt.group)) groups.set(opt.group, []);
        groups.get(opt.group).push(opt);
        return;
      }
      const row = document.createElement("div");
      row.className =
        "basis-row" + (opt.id === selectedBasisId ? " selected" : "") + (opt.disabled ? " disabled" : "");
      row.dataset.id = opt.id;
      row.innerHTML = `
        <span class="dot"></span>
        <div class="txt">
          <div class="main">${escapeHtml(opt.main)}</div>
          <div class="meta">${escapeHtml(opt.meta)}</div>
        </div>
        <span class="tag">${escapeHtml(opt.tag)}</span>
      `;
      if (!opt.disabled) {
        row.addEventListener("click", () => onSelect(opt.id));
      }
      el.appendChild(row);
    });

    groups.forEach((groupOpts, groupKey) => {
      if (groupKey === "usual-select") {
        // "평소 입는 사이즈"는 더 이상 페이지에서 자동으로 읽지 않고, 사용자가 이 드롭다운에서
        // 직접 고른 값(고정 XS~XXL 목록)을 그대로 쓴다.
        const opt = groupOpts[0];
        const row = document.createElement("div");
        row.className = "basis-row basis-row--dropdown" + (opt.id === selectedBasisId ? " selected" : "");
        row.dataset.id = opt.id;
        const currentLetter = parseSizeLetter(opt.value)?.letter || "M";
        row.innerHTML = `
          <span class="dot"></span>
          <div class="txt">
            <div class="main">평소 입는 사이즈</div>
            <select class="basis-select usual-size-select">
              ${USUAL_SIZE_OPTIONS.map(
                (s) => `<option value="${s}" ${s === currentLetter ? "selected" : ""}>${s}</option>`
              ).join("")}
            </select>
          </div>
          <span class="tag">${escapeHtml(opt.tag)}</span>
        `;
        const select = row.querySelector("select");
        select.addEventListener("change", () => {
          onUsualSizeChange(select.value);
        });
        select.addEventListener("click", (e) => e.stopPropagation());
        row.addEventListener("click", () => onSelect(opt.id));
        el.appendChild(row);
        return;
      }

      // 구매 이력 기반 추천 select와 판단 기준 패널 select는 같은 후보 목록을 보여 주되,
      // 전자는 selectedBasisId(추천)를 바꾸며 같은 옷을 판단 기준에도 적용하고,
      // 후자는 decisionDraftId(판단 기준)만 바꾼다.
      if (groupKey === "history-select") {
        const selectedOpt = groupOpts.find((o) => o.id === selectedBasisId);
        const row = document.createElement("div");
        row.className = "basis-row basis-row--dropdown" + (selectedOpt ? " selected" : "");
        row.dataset.group = groupKey;
        row.innerHTML = `
          <span class="dot"></span>
          <div class="txt">
            <div class="main">구매 이력 기반 추천</div>
            <select class="basis-select purchase-history-recommend-select">
              <option value="" ${selectedOpt ? "" : "selected"}>과거 구매한 아우터 중 선택하세요</option>
              ${groupOpts
                .map(
                  (o) =>
                    `<option value="${escapeHtml(o.id)}" ${o.id === selectedBasisId ? "selected" : ""}>${escapeHtml(
                      o.main
                    )} — ${escapeHtml(o.meta)}</option>`
                )
                .join("")}
            </select>
          </div>
          <span class="tag">${escapeHtml(selectedOpt ? selectedOpt.tag : "구매 이력")}</span>
        `;
        const select = row.querySelector("select");
        select.addEventListener("change", () => {
          // 빈 값은 평소 사이즈 추천으로 돌아가며 판단 기준 설정과 비교 UI를 함께 비운다.
          if (select.value) onSelect(select.value, { syncDecisionReference: true });
          else onSelect("usual");
        });
        select.addEventListener("click", (e) => e.stopPropagation());
        el.appendChild(row);

        const panel = document.createElement("div");
        panel.id = "fitNotesPanel";
        el.appendChild(panel);
        return;
      }

      const selectedOpt = groupOpts.find((o) => o.id === selectedBasisId);
      const row = document.createElement("div");
      row.className = "basis-row basis-row--dropdown" + (selectedOpt ? " selected" : "");
      row.dataset.group = groupKey;
      row.innerHTML = `
        <span class="dot"></span>
        <div class="txt">
          <div class="main">구매 이력 기반 추천</div>
          <select class="basis-select">
            <option value="" ${selectedOpt ? "" : "selected"} disabled>과거 구매한 아우터 중 선택하세요</option>
            ${groupOpts
              .map(
                (o) =>
                  `<option value="${escapeHtml(o.id)}" ${o.id === selectedBasisId ? "selected" : ""}>${escapeHtml(
                    o.main
                  )} — ${escapeHtml(o.meta)}</option>`
              )
              .join("")}
          </select>
        </div>
        <span class="tag">${escapeHtml(selectedOpt ? selectedOpt.tag : "구매 이력")}</span>
      `;
      const select = row.querySelector("select");
      select.addEventListener("change", () => {
        if (select.value) onSelect(select.value);
      });
      // select 클릭이 상위 basis-row 클릭으로 버블링되어 선택이 꼬이지 않도록 막는다.
      select.addEventListener("click", (e) => e.stopPropagation());
      el.appendChild(row);
    });
  }

  // 사이즈 응답 5구간의 가중치(점수 계산식 표시용)
  const SIZE_DIST_TERMS = [
    { weight: -2, key: "veryTight", label: "매우 작아요" },
    { weight: -1, key: "tight", label: "조금 작아요" },
    { weight: 0, key: "true", label: "정사이즈" },
    { weight: 1, key: "big", label: "조금 커요" },
    { weight: 2, key: "veryBig", label: "많이 커요" },
  ];
  // 실제 후기 기반 모드일 때 '점수 산정 기준' 계산식(가중치×비율 합)을 표시한다.
  function renderScoreBasis(root, sizeDist, combinedScore) {
    const el = root.getElementById("scoreBasisFormula");
    if (!sizeDist) {
      el.textContent = "이 상품의 응답 분포 데이터를 찾지 못했어요.";
      return;
    }
    const expr = SIZE_DIST_TERMS.map((t) => {
      const pct = sizeDist[t.key] || 0;
      return `(${t.weight >= 0 ? "+" : ""}${t.weight}×${pct}%)`;
    }).join(" + ");
    el.innerHTML =
      `점수 = ${escapeHtml(expr)} = ` +
      `<b>${combinedScore >= 0 ? "+" : ""}${combinedScore.toFixed(2)}</b>`;
  }

  // [getDiffContext] 구매 이력 상품이 기준으로 선택돼 있으면 현재 상품 점수와의 차이와 조정 안내를 돌려준다.
  //   평소 입는 사이즈 기준이면(refScore 없음) null.
  function getDiffContext(state) {
    const basis = state.data.basisOptions.find((o) => o.id === state.selectedBasisId);
    // id는 후보마다 "reference-<goodsNo>"처럼 달라질 수 있으므로, refScore 보유 여부로 판정한다.
    const hasRefScore = typeof basis.refScore === "number";
    if (!hasRefScore) return null;

    const diff = Math.round((state.data.combinedScore - basis.refScore) * 1000) / 1000;
    return { basis, diff, adj: getSizeAdjustment(diff, state.fit) };
  }

  // 판매 사이즈가 하나뿐이고 그 표기를 해석할 수 없는(F/FREE 등) 단일 사이즈 상품인지 확인한다.
  function isSingleUnparseableSalesSize(sizeTexts, numberedSizeMap = null) {
    return (
      Array.isArray(sizeTexts) &&
      sizeTexts.length === 1 &&
      !parseSizeLetter(sizeTexts[0], numberedSizeMap)
    );
  }

  // 이 기준 상품에 대해 계산이 끝난 실측(cm) 비교 결과가 있으면 돌려준다(로딩 중/실패면 null).
  function getReadyMeasurementFallback(state, basis) {
    const cached = basis?.id ? state.measurementFallback[basis.id] : null;
    return cached && cached !== "loading" && cached !== "unavailable" ? cached : null;
  }

  // [renderScale] 예측 점수 게이지(핀 위치·라벨)와 '자세히 보기'의 점수 설명·계산식을 그린다.
  //   구매 이력 기준이면 기준 상품 핀도 함께 표시하고, 단일 사이즈 상품/실측 비교 결과가 있으면 그에 맞는 설명으로 바꾼다.
  function renderScale(root, state) {
    const { brand, category, combinedScore, mode } = state.data;
    // 점수(−2~+2)를 게이지 위치(0~100%)로 변환
    const toPercent = (score) => ((score + 2) / 4) * 100;
    const scaleWrap = root.querySelector(".scale-wrap");
    // 핀을 점수 위치에 놓고, 라벨이 게이지 밖으로 나가지 않게 글자 크기·가장자리 정렬을 조정한다(위젯이 아직 안 보이면 다음 프레임에 재시도).
    const positionPin = (pin, score, retryWhenVisible = true) => {
      const percent = Math.max(0, Math.min(100, toPercent(score)));
      pin.style.left = percent + "%";
      pin.dataset.score = String(score);

      const flag = pin.querySelector(".flag");
      const track = scaleWrap?.querySelector(".scale-track");
      if (!scaleWrap || !track || !flag) return;
      if (scaleWrap.clientWidth === 0 || track.clientWidth === 0) {
        pin.classList.remove("edge-left", "edge-right");
        if (retryWhenVisible) {
          requestAnimationFrame(() => {
            if (!pin.isConnected || pin.style.display === "none") return;
            positionPin(pin, Number(pin.dataset.score), false);
          });
        }
        return;
      }

      // 긴 라벨도 게이지 양 끝에서 위젯 밖으로 나가지 않도록 실제 폭에 맞춰
      // 글자 크기를 줄이고, 가장자리에서는 말풍선만 안쪽으로 정렬한다.
      flag.style.fontSize = "11px";
      const maxFlagWidth = Math.max(1, scaleWrap.clientWidth - 16);
      const naturalWidth = flag.getBoundingClientRect().width;
      if (naturalWidth > maxFlagWidth) {
        flag.style.fontSize = `${Math.max(8, 11 * maxFlagWidth / naturalWidth)}px`;
      }

      const wrapRect = scaleWrap.getBoundingClientRect();
      const trackRect = track.getBoundingClientRect();
      const markerX = wrapRect.left + scaleWrap.clientWidth * percent / 100;
      const halfFlagWidth = flag.getBoundingClientRect().width / 2 + 4;
      pin.classList.toggle("edge-left", markerX - trackRect.left < halfFlagWidth);
      pin.classList.toggle("edge-right", trackRect.right - markerX < halfFlagWidth);
    };

    const combinedPin = root.getElementById("scalePin");
    root.getElementById("scaleFlag").textContent =
      `현재 상품 ${(combinedScore >= 0 ? "+" : "") + combinedScore.toFixed(2)}`;
    positionPin(combinedPin, combinedScore);

    root.getElementById("brandScoreLabel").textContent =
      `${brand.score >= 0 ? "+" : ""}${brand.score.toFixed(2)} (${brand.name} · ${brand.n}건 학습)`;
    root.getElementById("categoryScoreLabel").textContent =
      `${category.score >= 0 ? "+" : ""}${category.score.toFixed(2)} (${category.name} · ${category.n}건 학습)`;

    const titleEl = root.getElementById("scaleTitleText");
    const legendEl = root.getElementById("scaleLegend");
    const basisEl = root.getElementById("scoreBasis");
    if (mode === "actual") {
      titleEl.textContent = "이 상품의 실제 사이즈 후기 점수";
      legendEl.style.display = "none";
      basisEl.style.display = "";
      renderScoreBasis(root, state.data.sizeDist, combinedScore);
    } else {
      titleEl.textContent = "브랜드+카테고리 결합 예측 점수";
      legendEl.style.display = "";
      basisEl.style.display = "none";
    }

    const sourceNote =
      state.data.brandSource === "live"
        ? " (브랜드는 상품 페이지에서 직접 확인함)"
        : state.data.brandSource === "unknown"
        ? " (브랜드를 확인하지 못해 전체 평균만 사용함)"
        : "";

    const diffCtx = getDiffContext(state);
    const refPin = root.getElementById("scaleRefPin");
    // 단일 F/FREE 판매 상품은 기준(평소 사이즈/구매 이력)과 무관하게 단일 사이즈 안내를 쓴다.
    const availableSizes = getPageAvailableSizeTexts();
    const isSingleSize = isSingleUnparseableSalesSize(
      availableSizes,
      state.sizeChart?.numberedSizeMap || null
    );

    if (diffCtx) {
      scaleWrap?.classList.add("has-reference");
      refPin.style.display = "";
      root.getElementById("scaleRefFlag").textContent =
        `내가 구매했던 상품 ${diffCtx.basis.refScore >= 0 ? "+" : ""}${diffCtx.basis.refScore}`;
      positionPin(refPin, diffCtx.basis.refScore);

      const measurement = getReadyMeasurementFallback(state, diffCtx.basis);
      if (isSingleSize || measurement) {
        root.getElementById("scaleSub").innerHTML = isSingleSize
          ? `이 상품은 단일 판매 사이즈 <b>${escapeHtml(availableSizes[0])}</b>예요. 단계 조정 없이 실제 판매 사이즈를 안내합니다.`
          : `점수 차이와 별도로 실측 비교 결과(<b>${measurement.diffCm >= 0 ? "+" : ""}${measurement.diffCm}cm</b>)를 아래 추천에 반영했어요.`;
        root.getElementById("formulaText").textContent = isSingleSize
          ? "단일 판매 사이즈 상품: 점수에 따른 단계 조정은 적용하지 않습니다."
          : `실측 차이 = 이 상품 ${measurement.currentValue}cm - 기준 상품 ${measurement.refValue}cm = ${measurement.diffCm >= 0 ? "+" : ""}${measurement.diffCm}cm`;
        return;
      }

      root.getElementById("scaleSub").innerHTML =
        `기준 상품 대비 <b>${diffCtx.diff >= 0 ? "+" : ""}${diffCtx.diff.toFixed(2)}</b> 차이 — ${diffCtx.adj.label}.`;

      root.getElementById("formulaText").textContent =
        `점수 차이 = 이 상품(${mode === "actual" ? "실측" : "예측"} ${combinedScore >= 0 ? "+" : ""}${combinedScore.toFixed(2)}) − ` +
        `기준 상품(실측 ${diffCtx.basis.refScore >= 0 ? "+" : ""}${diffCtx.basis.refScore}) = ` +
        `${diffCtx.diff >= 0 ? "+" : ""}${diffCtx.diff.toFixed(2)}${sourceNote}`;
      return;
    }

    scaleWrap?.classList.remove("has-reference");
    refPin.style.display = "none";

    if (isSingleSize) {
      root.getElementById("scaleSub").innerHTML =
        `이 상품은 단일 판매 사이즈 <b>${escapeHtml(availableSizes[0])}</b>예요. 단계 조정 없이 실제 판매 사이즈를 안내합니다.`;
      root.getElementById("formulaText").textContent =
        "단일 판매 사이즈 상품: 점수에 따른 단계 조정은 적용하지 않습니다.";
      return;
    }

    root.getElementById("scaleSub").innerHTML =
      `0보다 ${combinedScore >= 0 ? "살짝 크게" : "살짝 작게"} 나온 <b>${combinedScore >= 0 ? "+" : ""}${combinedScore.toFixed(2)}</b> — ${getBandLabel(combinedScore)}에 가까워요.`;

    root.getElementById("formulaText").textContent =
      mode === "actual"
        ? "실제 사이즈 후기 점수를 반영했어요."
        : `예측 점수 ${combinedScore >= 0 ? "+" : ""}${combinedScore.toFixed(2)} · 전체 평균 + 브랜드·카테고리 경향${sourceNote}`;
  }

  // 기준(구매 이력) 상품의 실측표를 API로 조회해, 현재 상품과 cm 단위로
  // 비교한 결과를 state에 캐시해두고, 아직도 이 기준이 선택돼 있으면 다시 그린다.
  async function ensureMeasurementFallback(root, state, basis) {
    const refChart = await fetchActualSizeChartForGoodsNo(basis.refGoodsNo);
    // 점수 기반 경로와 동일한 기준(버그 수정): 구매 이력 기준 상품이 선택돼 있으면
    // 그 상품의 실제 구매 사이즈를 앵커로 쓴다 — "평소 입는 사이즈"가 아니다.
    const shiftBaseText = basis.sizeOption || state.data.recommendedSize;
    const result = compareActualMeasurements(state.sizeChart, shiftBaseText, refChart, basis.sizeOption);
    if (!result) {
      // Reality Checker 지적사항 2: 실측 폴백이 필요했는데 실패한 경우와 애초에 필요 없던
      // 경우가 구분이 안 돼서(둘 다 조용히 점수 기반 문구로 넘어감) 문제 감지가 늦어졌다.
      // 최소한 콘솔에는 남겨서 "폴백이 시도됐지만 실패했다"를 확인할 수 있게 한다.
      console.warn(
        "[사이즈위젯] 실측(cm) 폴백 실패 — 점수 기반 문구로 대체합니다.",
        "basis=",
        basis.id,
        "shiftBaseText=",
        shiftBaseText,
        "refSizeOption=",
        basis.sizeOption,
        "hasCurrentChart=",
        !!state.sizeChart,
        "hasRefChart=",
        !!refChart
      );
    }
    state.measurementFallback[basis.id] = result || "unavailable";
    if (state.selectedBasisId === basis.id) {
      renderScale(root, state);
      renderVerdict(root, state);
    }
  }

  // [renderVerdictContent] 최종 추천 문구(#verdictText)와 설명(#verdictSub), 실측표 대조(#chartCheckNote),
  //   미판매 경고(#availabilityAlert)를 그린다. 분기 순서:
  //     ① 단일 F/FREE 상품 → 그 판매 사이즈를 그대로 안내
  //     ② 구매 이력 기준 → 기준 옷 구매 사이즈에서 점수 차이만큼 이동(필요하면 실측 cm 비교로 대체)
  //     ③ 평소 입는 사이즈 기준 → 상품 점수와 핏으로 이동
  //   어느 경우든 계산된 사이즈가 판매 목록에 없으면 다른 사이즈로 바꾸지 않고 경고를 띄운다.
  function renderVerdictContent(root, state) {
    const { combinedScore, mode, brand, category } = state.data;
    const fitLabelMap = { slim: "슬림핏", regular: "정핏", over: "오버핏" };
    const fitLabel = fitLabelMap[state.fit];

    root.getElementById("resultPill").textContent = state.data.reviewBased
      ? `실시간 리뷰 ${state.data.reviewCount}건 기준`
      : mode === "actual"
        ? "저장된 상품 후기 기반"
        : "리뷰 부족 · 브랜드+카테고리 예측";
    root.getElementById("widgetBadge").textContent =
      state.data.reviewBased ? `실시간 리뷰 ${state.data.reviewCount}건` : mode === "actual" ? "저장된 후기 데이터" : "브랜드 기반 예측";
    const productReviewNote = root.getElementById("productReviewNote");
    if (productReviewNote) {
      const noteText = state.data.reviewStatus === "failed"
        ? "최신 리뷰를 불러오지 못해 기존 데이터로 예측했어요"
        : state.data.reviewStatus === "insufficient"
          ? `사이즈 응답 ${state.data.reviewResponseCount}건으로는 부족해 기존 데이터로 예측했어요`
          : "";
      productReviewNote.textContent = noteText;
      productReviewNote.style.display = noteText ? "" : "none";
    }

    const basis = state.data.basisOptions.find((o) => o.id === state.selectedBasisId);
    const diffCtx = getDiffContext(state);

    // 실제 판매 목록에서 계산된 사이즈와 같은 옵션이 있는지 확인한다.
    const availableSizesForDisplay = getPageAvailableSizeTexts();
    const currentNumberedSizeMap = state.sizeChart?.numberedSizeMap || null;
    const hasNumberedSaleOptions = Array.isArray(availableSizesForDisplay) &&
      availableSizesForDisplay.some((size) => /^\s*[0-6]\s*$/.test(String(size)));
    const numberedMapStatus = currentNumberedSizeMap?.__status ||
      (hasNumberedSaleOptions
        ? (state.sizeChart?.rows?.some((row) => /^\s*[0-6]\s*$/.test(String(row.size || ""))) ? "unavailable" : "missing-chart")
        : "not-numbered");
    const verdictEl = root.getElementById("verdictText");
    const availabilityAlert = root.getElementById("availabilityAlert");
    availabilityAlert.style.display = "none";
    availabilityAlert.innerHTML = "";
    verdictEl.classList.remove("unavailable");
    // 판매 목록을 읽었고 비어 있지 않을 때, 계산된 사이즈가 그 목록에 없으면 경고 박스를 띄우고 true를 반환(호출부는 바로 종료).
    // 판매 목록에 있거나, 목록을 읽지 못했거나 비어 있으면 경고 없이 false.
    const showUnavailableSize = (calculatedSize) => {
      if (!Array.isArray(availableSizesForDisplay) || availableSizesForDisplay.length === 0) return false;
      const matchingSize = findAvailableSizeLabel(calculatedSize, availableSizesForDisplay, currentNumberedSizeMap);
      if (matchingSize) return false;
      const numberedMapUnavailable = hasNumberedSaleOptions && numberedMapStatus !== "mapped";
      const guidance = numberedMapStatus === "out-of-range"
        ? "실측 치수가 표준 사이즈 범위를 벗어나 번호 사이즈로 환산할 수 없어요."
        : numberedMapUnavailable
          ? "실측표가 없거나 읽지 못해 번호 사이즈를 환산할 수 없어요."
          : "평소 사이즈로는 맞는 옵션이 없어 추천하지 않아요.";
      availabilityAlert.innerHTML =
        `<strong class="availability-warning">⚠ 이 상품에는 ${escapeHtml(calculatedSize)} 사이즈가 없어요</strong>` +
        `<span class="availability-guidance">${guidance}</span>` +
        `<span class="availability-list">판매 사이즈: ${availableSizesForDisplay.map(escapeHtml).join(" · ")}</span>`;
      availabilityAlert.style.display = "grid";
      verdictEl.textContent = "계산된 사이즈가 판매 옵션에 없어 위 안내를 확인해 주세요.";
      root.getElementById("verdictSub").textContent = "";
      const chartNote = root.getElementById("chartCheckNote");
      if (chartNote) {
        chartNote.style.display = "none";
        chartNote.classList.remove("ok", "warn");
        chartNote.textContent = "";
      }
      return true;
    };
    // A single F/FREE option is not a ladder: show the actual sellable label
    // and avoid any "one size bigger/smaller" explanation.
    if (
      Array.isArray(availableSizesForDisplay) &&
      availableSizesForDisplay.length === 1 &&
      !parseSizeLetter(availableSizesForDisplay[0], currentNumberedSizeMap)
    ) {
      const onlySize = availableSizesForDisplay[0];
      root.getElementById("verdictText").innerHTML =
        `${fitLabel} 기준 <em>${escapeHtml(onlySize)}</em> 사이즈로 사는 걸 추천드려요`;
      root.getElementById("verdictSub").textContent =
        "이 상품은 단일 판매 사이즈라 단계 비교 없이 실제 판매 사이즈를 안내합니다.";
      renderChartCheck(root, onlySize, state.sizeChart, { style: "usualSize" });
      return;
    }
    // 번호형 사이즈 매핑 상태에 따라 추천 문구 뒤에 붙일 '근사값' 안내 문구
    const approxNote = numberedMapStatus === "out-of-range"
      ? ` <span class="hint">(실측 치수가 표준 범위를 벗어나 번호 사이즈를 환산할 수 없어요)</span>`
        : numberedMapStatus === "unavailable"
          ? ` <span class="hint">(실측표를 읽지 못해 번호 사이즈를 환산할 수 없어요 · 기존 번호 평균으로 안내해요)</span>`
        : numberedMapStatus === "missing-chart"
          ? ` <span class="hint">(실측표가 없어 번호 사이즈를 환산할 수 없어요 · 기존 번호 평균으로 안내해요)</span>`
          : ` <span class="hint">(번호 사이즈라 평균으로 환산한 값이에요 — 정확한 대응이 아닐 수 있어요)</span>`;

    if (diffCtx) {
      const { diff, adj } = diffCtx;
      // 버그 수정: 구매 이력(reference) 기준이 선택돼 있을 때는 "이 상품을 뭘로 사야
      // 하는지"를 그 기준 상품의 실제 구매 사이즈(basis.sizeOption, 예: "L")에서부터
      // 점수 차이만큼 이동시켜 계산해야 한다 — 지금 상품 페이지에서 고른(혹은 기본값)
      // "평소 입는 사이즈"를 기준으로 이동시키면 안 된다(실제로 그렇게 돼 있던 버그였음:
      // 구매 이력을 골라도 항상 "평소 입는 사이즈"에서만 이동해서, 예를 들어 L을 산
      // 상품을 기준으로 골라도 추천 문구에는 그 기준과 무관한 다른 사이즈(예: M)가 나왔다).
      // "평소 입는 사이즈" 기준이 선택돼 있을 때는 그대로 recommendedSize를 쓴다.
      const shiftBaseText = basis.refGoodsNo ? basis.sizeOption || state.data.recommendedSize : state.data.recommendedSize;
      const sizeShift = shiftSizeBySteps(shiftBaseText, adj.steps, adj.dirSign);
      let measurementFallbackFailed = false;
      let measurementFallbackLoading = false;

      // 요청 1(+추가 요청으로 조건 확장): 점수(-2~+2) 비교 대신 실측(cm) 비교로 폴백하는 경우를
      // 두 가지로 넓힌다 —
      //  (a) 기준으로 삼을 사이즈 표기가 SIZE_LADDER로 아예 파싱이 안 되는 경우(예: "FREE"/"F"), 또는
      //  (b) 라벨 자체는 정상(문자든 숫자든)이어도, 이 상품이 실제로 파는 사이즈 목록에
      //      기준 상품의 구매 사이즈와 cm 환산상 같은 사이즈가 하나도 없는 경우
      //      (예: 이 상품은 XS/S/M만 팔고 기준은 L을 구매한 경우 — letter/숫자 라벨은
      //      둘 다 멀쩡히 파싱되지만 "비교 가능한 사이즈"가 아예 없는 케이스).
      if (basis.refGoodsNo) {
        const baseParsed = parseSizeLetter(shiftBaseText || "");
        const needsMeasurementFallback = !baseParsed || !hasComparableSize(shiftBaseText, availableSizesForDisplay, null, currentNumberedSizeMap);

        if (needsMeasurementFallback) {
          const cached = state.measurementFallback[basis.id];
          if (cached === undefined) {
            state.measurementFallback[basis.id] = "loading";
            ensureMeasurementFallback(root, state, basis);
          } else if (cached && cached !== "loading" && cached !== "unavailable") {
            const mAdj = getMeasurementAdjustment(cached.diffCm);
            const approxHint = (baseParsed && baseParsed.approximate) ? approxNote : "";
            const fallbackReason = !baseParsed
              ? "기준 사이즈 표기를 해석할 수 없어 실측으로 비교했어요."
              : `이 상품엔 구매하신 사이즈(${escapeHtml(basis.sizeOption || shiftBaseText)})와 같은 사이즈가 없어 실측으로 비교했어요.`;
            let boundaryWarning = null;
            if (mAdj.steps === 0) {
              const calculatedSize = cached.currentSizeLabel || shiftBaseText;
              if (showUnavailableSize(calculatedSize)) return;
              root.getElementById("verdictText").innerHTML =
                `${fitLabel} 기준 <em>${escapeHtml(findAvailableSizeLabel(calculatedSize, availableSizesForDisplay, currentNumberedSizeMap) || calculatedSize)}</em> 사이즈로 사는 걸 추천드려요 ` +
                `${getNumberedSizeEvidence(findAvailableSizeLabel(calculatedSize, availableSizesForDisplay, currentNumberedSizeMap), currentNumberedSizeMap, state.sizeChart) || (parseSizeLetter(calculatedSize, currentNumberedSizeMap)?.approximate ? approxNote : "")}`;
            } else {
              const measShift = shiftSizeBySteps(cached.currentSizeLabel || shiftBaseText, mAdj.steps, mAdj.dirSign);
              if (measShift.original) {
                const calculatedSize = measShift.text;
                if (showUnavailableSize(calculatedSize)) return;
                const availableLabel = findAvailableSizeLabel(calculatedSize, availableSizesForDisplay, currentNumberedSizeMap) || calculatedSize;
                const isBoundary = normalizeSizeLabel(availableLabel) === normalizeSizeLabel(cached.currentSizeLabel);
                if (isBoundary) {
                  const wantsLarger = mAdj.direction === "up";
                  const edgeLabel = wantsLarger ? "가장 큰" : "가장 작은";
                  const unavailableLabel = wantsLarger ? "더 큰" : "더 작은";
                  const comparison = cached.diffCm < 0 ? "작아" : "커";
                  boundaryWarning =
                    `이 상품의 ${edgeLabel} 사이즈예요 — 기준 옷보다 약 ${Math.abs(cached.diffCm)}cm ${comparison}요. ${unavailableLabel} 사이즈는 판매하지 않아요.`;
                  root.getElementById("verdictText").innerHTML =
                    `${fitLabel} 기준 <em>${escapeHtml(availableLabel)}</em> 사이즈가 이 상품에서 선택 가능한 한계예요 ` +
                    `<span class="hint">(실측 기준 · 아래 안내 참고)</span>${getNumberedSizeEvidence(availableLabel, currentNumberedSizeMap, state.sizeChart) || (parseSizeLetter(calculatedSize, currentNumberedSizeMap)?.approximate ? approxNote : "")}`;
                }
                if (!isBoundary) root.getElementById("verdictText").innerHTML =
                  `${fitLabel} 기준 <em>${escapeHtml(availableLabel)}</em> 사이즈로 사는 걸 추천드려요 ` +
                  `<span class="hint">(${mAdj.shortLabel} · 실측 기준)</span>${getNumberedSizeEvidence(availableLabel, currentNumberedSizeMap, state.sizeChart) || (parseSizeLetter(calculatedSize, currentNumberedSizeMap)?.approximate ? approxNote : "")}`;
              } else {
                root.getElementById("verdictText").innerHTML =
                  `${fitLabel} 기준 <em>${mAdj.label}</em> ` +
                  `<span class="hint">(${escapeHtml(shiftBaseText)}보다 ${mAdj.shortLabel} · 실측 기준)</span>${approxHint}`;
              }
            }
            renderChartCheck(root, cached.currentSizeLabel || null, state.sizeChart, {
              style: "purchaseHistory",
              label: basis.main,
            });
            root.getElementById("verdictSub").innerHTML =
              `${fallbackReason} 실측 차이 ${cached.diffCm >= 0 ? "+" : ""}${cached.diffCm}cm예요.`;
            if (boundaryWarning) {
              const chartNote = root.getElementById("chartCheckNote");
              if (chartNote) {
                chartNote.style.display = "";
                chartNote.classList.remove("ok");
                chartNote.classList.add("warn");
                chartNote.textContent = `⚠ ${boundaryWarning}`;
              }
            }
            return;
          }
          measurementFallbackFailed = cached === "unavailable";
          measurementFallbackLoading = cached === undefined || cached === "loading";
          // cached === "loading" 또는 "unavailable"이면 아래의 기존 점수 기반 문구로 그대로 진행한다.
        }
      }

      const baseApprox = !!parseSizeLetter(shiftBaseText || "")?.approximate;

      if (sizeShift.original) {
        if (showUnavailableSize(sizeShift.text)) return;
        const availableLabel = findAvailableSizeLabel(sizeShift.text, availableSizesForDisplay, currentNumberedSizeMap) || sizeShift.text;
        root.getElementById("verdictText").innerHTML =
          `${fitLabel} 기준 <em>${escapeHtml(availableLabel)}</em> 사이즈로 사는 걸 추천드려요 ` +
          `<span class="hint">(${adj.shortLabel}${adj.note ? " · " + adj.note : ""})</span>` +
          (getNumberedSizeEvidence(availableLabel, currentNumberedSizeMap, state.sizeChart) || (parseSizeLetter(sizeShift.text, currentNumberedSizeMap)?.approximate || baseApprox ? approxNote : ""));
      } else {
        root.getElementById("verdictText").innerHTML =
          `${fitLabel} 기준 <em>${adj.label}</em>` +
          (adj.note ? ` <span class="hint">(${adj.note})</span>` : "") +
          (baseApprox ? approxNote : "");
      }

      root.getElementById("verdictSub").innerHTML =
        `"${escapeHtml(basis.main)}" 기준 점수 차이 <b>${diff >= 0 ? "+" : ""}${diff.toFixed(2)}</b>를 반영했어요.`;
      if (measurementFallbackFailed) {
        root.getElementById("verdictSub").insertAdjacentHTML(
          "beforeend",
          ` <b class="measurement-fallback-warning">실측 비교 실패, 추정치 사용</b>`
        );
      } else if (measurementFallbackLoading) {
        root.getElementById("verdictSub").insertAdjacentHTML(
          "beforeend",
          ` <b class="measurement-fallback-loading">실측 비교 중… 잠시 후 결과가 갱신돼요 (현재는 점수 기반 임시 추천)</b>`
        );
      }
      // 실측 폴백이 아직 로딩 중일 때는 점수 기반 임시 계산으로 만든 ⚠/✓ 줄(예: "이 상품
      // 실측 사이즈표에는 L 사이즈가 없어요")을 보여주면 안 된다 — 로딩이 끝나면 그 판정
      // 자체가 바뀌거나 무의미해질 수 있는 임시값이라 사용자에게 혼란을 준다. verdictSub의
      // "실측 비교 중…" 안내만 남기고, 이 줄은 숨겨둔다. 로딩이 끝나면 renderVerdict가
      // 다시 호출되어(ensureMeasurementFallback) 정상적으로 다시 그려진다.
      if (measurementFallbackLoading) {
        renderChartCheck(root, null, state.sizeChart);
      } else {
        renderChartCheck(root, sizeShift.original ? sizeShift.text : null, state.sizeChart, {
          style: "purchaseHistory",
          label: basis.main,
        });
      }
      return;
    }

    // ③ 평소 입는 사이즈 기준 추천
    const sizeShift = shiftSize(state.data.recommendedSize, combinedScore, state.fit);
    const usualApprox = !!parseSizeLetter(state.data.recommendedSize || "")?.approximate;

    if (sizeShift.original && sizeShift.shifted) {
      const stepLabel = sizeShift.steps >= 2 ? "두 단계" : "한 단계";
      if (showUnavailableSize(sizeShift.text)) return;
      const availableLabel = findAvailableSizeLabel(sizeShift.text, availableSizesForDisplay, currentNumberedSizeMap) || sizeShift.text;
      root.getElementById("verdictText").innerHTML =
        `${fitLabel} 기준 <em>${escapeHtml(availableLabel)}</em> 사이즈로 사는 걸 추천드려요 ` +
        `<span class="hint">(평소 ${sizeShift.original}보다 ${stepLabel} ${sizeShift.direction === "down" ? "작게" : "크게"})</span>` +
        (getNumberedSizeEvidence(availableLabel, currentNumberedSizeMap, state.sizeChart) || (parseSizeLetter(sizeShift.text, currentNumberedSizeMap)?.approximate || usualApprox ? approxNote : ""));
    } else if (sizeShift.original) {
      if (showUnavailableSize(sizeShift.text)) return;
      const availableLabel = findAvailableSizeLabel(sizeShift.text, availableSizesForDisplay, currentNumberedSizeMap) || sizeShift.text;
      const originalParsed = parseSizeLetter(sizeShift.original);
      const availableParsed = parseSizeLetter(availableLabel, currentNumberedSizeMap);
      const sameUsualSize = !!originalParsed && !!availableParsed && originalParsed.letter === availableParsed.letter;
      root.getElementById("verdictText").innerHTML =
        `${fitLabel} 기준 <em>${escapeHtml(availableLabel)}</em> 사이즈로 사는 걸 추천드려요` +
        (sameUsualSize && !isNumberedSizeLabel(availableLabel) ? ` <span class="hint">(평소 사이즈 그대로)</span>` : "") +
        (getNumberedSizeEvidence(availableLabel, currentNumberedSizeMap, state.sizeChart) || (parseSizeLetter(sizeShift.text, currentNumberedSizeMap)?.approximate || usualApprox ? approxNote : ""));
    } else {
      if (showUnavailableSize(state.data.recommendedSize)) return;
      let sizeHint = "";
      if (combinedScore > 1) sizeHint = "많이 크게 나올 수 있어요";
      else if (combinedScore > 0.2) sizeHint = "다소 넉넉하게 나올 수 있어요";
      else if (combinedScore < -1) sizeHint = "많이 작게 나올 수 있어요";
      else if (combinedScore < -0.2) sizeHint = "다소 타이트할 수 있어요";

      root.getElementById("verdictText").innerHTML =
        `${fitLabel} 기준 <em>${escapeHtml(state.data.recommendedSize)}</em> 사이즈로 사는 걸 추천드려요` +
        (sizeHint ? ` <span class="hint">(${sizeHint})</span>` : "");
    }

    root.getElementById("verdictSub").textContent =
      mode === "actual"
        ? `실제 사이즈 후기를 "${basis.main}" 기준에 반영했어요.`
        : `리뷰가 적어 ${brand.name} · ${category.name}의 경향으로 예측했어요.`;
    renderChartCheck(root, sizeShift.original ? sizeShift.text : null, state.sizeChart, {
      style: "usualSize",
    });
  }

  // 기존 추천 문구를 모두 만든 다음에만 cm 판단 근거를 덧붙인다. 따라서 이 영역은
  // 추천 산정·미판매 경고·번호 사이즈 폴백의 결과를 수정하지 않는다.
  function renderVerdict(root, state) {
    renderVerdictContent(root, state);
    renderDecisionBasis(root, state);
  }

  // 상품이 실측 도식 이미지를 제공하지 않을 때 쓰는 기본 도식(확장 내부 SVG)
  const GENERIC_SIZE_DIAGRAM = chrome.runtime.getURL("assets/size-guide-generic.svg");

  // 1~20은 원 숫자(①~⑳)로, 그 밖은 "n."으로 표기한다(도식 범례용).
  function circledNumber(n) {
    if (Number.isInteger(n) && n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + (n - 1));
    return `${n}.`;
  }

  // [renderSizeChart] '자세히 보기'의 실측 사이즈표·도식·범례를 그린다.
  //   실측표가 없으면 '실측 정보 없음' 문구만 보인다.
  function renderSizeChart(root, sizeChart) {
    const box = root.getElementById("sizeChartBox");
    const table = root.getElementById("sizeChartTable");
    const emptyNote = root.getElementById("sizeChartEmpty");
    const headRow = root.getElementById("sizeChartHeadRow");
    const body = root.getElementById("sizeChartBody");
    const diagramWrap = root.getElementById("sizeChartDiagram");
    const diagramImg = root.getElementById("sizeChartDiagramImg");
    const legendEl = root.getElementById("sizeChartLegend");

    box.style.display = "";

    if (!sizeChart || !Array.isArray(sizeChart.rows) || sizeChart.rows.length === 0) {
      table.style.display = "none";
      headRow.innerHTML = "";
      body.innerHTML = "";
      emptyNote.textContent = "실측 정보 없음 (이 상품 페이지에는 브랜드가 제공한 실측표가 없어요)";
      emptyNote.style.display = "";
      diagramWrap.style.display = "none";
      diagramImg.src = "";
      legendEl.style.display = "none";
      legendEl.textContent = "";
      return;
    }

    emptyNote.style.display = "none";
    table.style.display = "";
    headRow.innerHTML =
      `<th>사이즈</th>` + sizeChart.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
    body.innerHTML = sizeChart.rows
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.size ?? "-")}</td>` +
          row.values.map((v) => `<td>${escapeHtml(v)}</td>`).join("") +
          `</tr>`
      )
      .join("");

    diagramWrap.style.display = "";
    diagramImg.src = sizeChart.diagramImage || GENERIC_SIZE_DIAGRAM;

    if (sizeChart.diagramImage && Array.isArray(sizeChart.legend) && sizeChart.legend.length > 0) {
      legendEl.textContent = sizeChart.legend
        .map((item) => `${circledNumber(item.number)} ${item.label}`)
        .join("  ");
      legendEl.style.display = "";
    } else {
      legendEl.style.display = "none";
      legendEl.textContent = "";
    }
  }

  // 사이즈 표기 비교용 정규화: 대문자화, 공백 제거, XXL/XXXL → 2XL/3XL 통일.
  function normalizeSizeLabel(s) {
    return String(s || "")
      .toUpperCase()
      .replace(/\s+/g, "")
      // XXL/XXXL/XXXXL → 2XL/3XL/4XL. 고정 문자열 치환은 "XXXXL"을 "X3XL"로 만들었다.
      .replace(/X{2,}L/g, (m) => `${m.length - 1}XL`);
  }

  // [findChartRowForSize] 실측표에서 sizeText와 같은 사이즈 행을 찾는다.
  //   표기가 정확히 같거나, 표준 사이즈(cm 환산)가 같은 행을 인정한다. 없으면 null.
  function findChartRowForSize(sizeText, sizeChart) {
    if (!sizeChart || !Array.isArray(sizeChart.rows)) return null;
    const target = normalizeSizeLabel(sizeText);
    const exact = sizeChart.rows.find((row) => normalizeSizeLabel(row.size) === target);
    if (exact) return exact;
    // 문자열이 정확히 같지 않아도(예: "M" vs "95") 같은 cm 호수를 가리키면 같은 사이즈로
    // 인정한다 — 표기 형식이 다른 두 상품을 cm 환산으로 비교하기 위함.
    const targetParsed = parseSizeLetter(sizeText, sizeChart.numberedSizeMap || null);
    if (!targetParsed) return null;
    return (
      sizeChart.rows.find((row) => {
        const rowParsed = parseSizeLetter(row.size, sizeChart.numberedSizeMap || null);
        return rowParsed && rowParsed.letter === targetParsed.letter;
      }) || null
    );
  }

  // [renderChartCheck] 추천 사이즈가 실측표에 있는지 확인한 결과를 초록(ok)/주황(warn) 안내로 표시한다.
  //   sizeText가 없으면 숨긴다. options.style: "purchaseHistory"(구매 이력 문구) | "usualSize"(평소 사이즈 문구)
  function renderChartCheck(root, sizeText, sizeChart, options = {}) {
    const el = root.getElementById("chartCheckNote");
    if (!el) return;

    if (!sizeText) {
      el.style.display = "none";
      return;
    }

    el.style.display = "";
    el.classList.remove("ok", "warn");

    if (!sizeChart || !Array.isArray(sizeChart.rows) || sizeChart.rows.length === 0) {
      el.classList.add("warn");
      el.textContent = `이 상품은 실측 사이즈표가 없어서 ${sizeText} 사이즈의 실제 치수는 확인할 수 없어요.`;
      return;
    }

    const row = findChartRowForSize(sizeText, sizeChart);
    if (!row) {
      el.classList.add("warn");
      el.textContent = `⚠ 이 상품 실측 사이즈표에는 ${sizeText} 사이즈가 없어요. 구매 전 다른 사이즈로 다시 확인해보세요.`;
      return;
    }

    el.classList.add("ok");
    if (options.style === "purchaseHistory") {
      const rawLabel = String(options.label || "").trim();
      const shortLabel = rawLabel && Array.from(rawLabel).length > 18 ? `${Array.from(rawLabel).slice(0, 18).join("")}...` : rawLabel;
      el.textContent = shortLabel
        ? `✓ "${shortLabel}"에서 구매했던 사이즈와 가장 유사해요`
        : "✓ 기존에 구매했던 사이즈와 가장 유사해요";
      return;
    }
    if (options.style === "usualSize") {
      el.textContent = `✓ 가장 ${row.size}사이즈 평균에 가까워요!`;
      return;
    }
    el.textContent = "✓ 기존에 구매했던 사이즈와 가장 유사해요";
  }

  // ---------------------------------------------------------
  // 5) 위젯 마운트
  // ---------------------------------------------------------
  // 최근 본 상품 storage 키(popup.js와 공유)와 최대 보관 개수
  const RECENT_PRODUCTS_KEY = "sizeWidget:recentProducts";
  const MAX_RECENT_PRODUCTS = 20;

  // 현재 페이지의 메타 태그에서 최근 본 상품으로 저장할 정보(번호·이름·이미지·URL·조회 시각)를 만든다.
  function readRecentProductMetadata(goodsNo, fallbackName) {
    const cleanName = (value) => String(value || "").replace(/\s*[-|｜]\s*(무신사|사이즈\s*&?\s*후기).*$/i, "").trim();
    const title =
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('h1')?.textContent ||
      document.title ||
      "";
    const name = cleanName(title) || cleanName(fallbackName) || "";
    const imageUrl =
      document.querySelector('meta[property="og:image"]')?.content?.trim() ||
      document.querySelector('meta[name="twitter:image"]')?.content?.trim() ||
      "";
    return {
      goodsNo: String(goodsNo),
      name,
      imageUrl,
      url: location.href,
      viewedAt: new Date().toISOString(),
    };
  }

  // 최근 본 상품 목록 맨 앞에 추가(같은 상품은 중복 제거)하고 최대 20개까지만 저장한다.
  async function saveRecentProduct(product) {
    try {
      const stored = await chrome.storage.local.get(RECENT_PRODUCTS_KEY);
      const previous = Array.isArray(stored[RECENT_PRODUCTS_KEY]) ? stored[RECENT_PRODUCTS_KEY] : [];
      const updated = [product, ...previous.filter((item) => String(item?.goodsNo) !== product.goodsNo)].slice(
        0,
        MAX_RECENT_PRODUCTS
      );
      await chrome.storage.local.set({ [RECENT_PRODUCTS_KEY]: updated });
    } catch (err) {
      console.warn("[사이즈위젯] 최근 본 상품 저장 실패:", err);
    }
  }

  // 위젯 하단 '최근 본 상품' 아코디언 목록을 storage 내용으로 그린다(현재 상품에는 표시를 붙임).
  async function renderRecentProducts(root, currentGoodsNo) {
    const list = root.getElementById("recentProductsList");
    const summary = root.getElementById("recentProductsSummary");
    if (!list || !summary) return;
    try {
      const stored = await chrome.storage.local.get(RECENT_PRODUCTS_KEY);
      const items = Array.isArray(stored[RECENT_PRODUCTS_KEY]) ? stored[RECENT_PRODUCTS_KEY] : [];
      summary.textContent = `최근 본 상품 (${items.length}) ▼`;
      list.replaceChildren();
      items.forEach((item) => {
        const row = document.createElement("a");
        row.className = "recent-product-item";
        row.href = item.url || `https://www.musinsa.com/products/${encodeURIComponent(item.goodsNo || "")}`;
        const image = document.createElement("img");
        image.className = "recent-product-image";
        image.alt = "";
        image.loading = "lazy";
        if (item.imageUrl) image.src = item.imageUrl;
        image.addEventListener("error", () => {
          image.removeAttribute("src");
          image.classList.add("placeholder");
        }, { once: true });
        const text = document.createElement("span");
        text.className = "recent-product-name";
        text.textContent = item.name || `상품 ${item.goodsNo || ""}`;
        if (String(item.goodsNo) === String(currentGoodsNo)) {
          const current = document.createElement("small");
          current.className = "recent-product-current";
          current.textContent = "현재 보고 있는 상품";
          text.appendChild(current);
        }
        row.append(image, text);
        list.appendChild(row);
      });
    } catch (err) {
      console.warn("[사이즈위젯] 최근 본 상품 표시 실패:", err);
      summary.textContent = "최근 본 상품 (0) ▼";
    }
  }

  // [createWidgetHost] 위젯을 담을 host <div>와 Shadow DOM을 만든다.
  //   Shadow DOM 덕분에 무신사 페이지 CSS와 위젯 CSS(style.css)가 서로 섞이지 않는다.
  //   WIDGET_HTML 마크업에 '최근 본 상품' 아코디언을 덧붙여 반환한다.
  const RECOMMENDATION_LAUNCHER_HOST_ID = "musinsa-brand-size-recommendation-launcher-host";

  function createWidgetHost({ separateLauncher = false } = {}) {
    const host = document.createElement("div");
    host.id = "musinsa-brand-size-widget-outfit-host";
    host.style.margin = "12px 0";
    const shadow = host.attachShadow({ mode: "open" });
    const styleEl = document.createElement("style");
    shadow.appendChild(styleEl);

    // 모달은 페이지 본문의 stacking context 영향을 받지 않도록 별도 최상위 host에 둔다.
    // host는 모달을 열 때 documentElement에 연결하고, 닫거나 위젯이 제거되면 분리한다.
    const modalHost = document.createElement("div");
    modalHost.id = "musinsa-brand-size-recommendation-modal-host";
    modalHost.style.position = "fixed";
    modalHost.style.inset = "0";
    modalHost.style.zIndex = "2147483647";
    modalHost.style.display = "block";
    modalHost.style.margin = "0";
    modalHost.style.padding = "0";
    modalHost.style.border = "0";
    const modalShadow = modalHost.attachShadow({ mode: "open" });
    const modalStyleEl = document.createElement("style");
    modalShadow.appendChild(modalStyleEl);
    fetch(chrome.runtime.getURL("style.css"))
      .then((r) => r.text())
      .then((css) => {
        styleEl.textContent = css;
        modalStyleEl.textContent = css;
        if (launcherStyleEl) launcherStyleEl.textContent = css;
      })
      .catch((err) => console.warn("[사이즈위젯] style.css 로드 실패:", err));

    const wrap = document.createElement("div");
    wrap.innerHTML = WIDGET_HTML;
    const widgetEl = wrap.querySelector("#sizeWidget");
    const recommendationLauncher = wrap.querySelector("#recommendationLauncher");
    const recommendationModal = wrap.querySelector("#recommendationModal");
    let launcherHost = null;
    let launcherShadow = shadow;
    let launcherStyleEl = null;
    const recent = document.createElement("details");
    recent.className = "recent-products-accordion acc";
    recent.innerHTML =
      '<summary id="recentProductsSummary">최근 본 상품 (0) ▼</summary>' +
      '<div class="recent-products-list" id="recentProductsList"></div>';
    widgetEl.appendChild(recent);
    shadow.appendChild(widgetEl);
    if (separateLauncher && recommendationLauncher) {
      // 중복 호출/재렌더 시 고정 ID의 이전 호스트를 재사용하지 않고 정리해 ID 중복을 막는다.
      const existingLauncherHost = document.getElementById(RECOMMENDATION_LAUNCHER_HOST_ID);
      if (existingLauncherHost) existingLauncherHost.remove();
      launcherHost = document.createElement("div");
      launcherHost.id = RECOMMENDATION_LAUNCHER_HOST_ID;
      launcherHost.hidden = true;
      launcherHost.style.display = "none";
      launcherHost.style.width = "100%";
      launcherHost.style.maxWidth = "100%";
      launcherHost.style.boxSizing = "border-box";
      launcherHost.style.alignSelf = "stretch";
      launcherHost.style.margin = "8px 0 4px";
      launcherShadow = launcherHost.attachShadow({ mode: "open" });
      launcherStyleEl = document.createElement("style");
      launcherShadow.appendChild(launcherStyleEl);
      recommendationLauncher.classList.add("recommendation-launcher--external");
      launcherShadow.appendChild(recommendationLauncher);
    }
    if (recommendationModal) modalShadow.appendChild(recommendationModal);
    return { host, shadow, modalShadow, launcherHost, launcherShadow };
  }

  // 데이터 준비 중 로딩 화면(스피너·안내 문구)으로 전환한다. 품절 상품이면 품절 안내 띠도 보인다.
  function setWidgetLoading(root, isSoldOut) {
    const widget = root.getElementById("sizeWidget");
    widget?.classList.add("is-loading");
    const soldOutNotice = root.getElementById("soldOutNotice");
    if (soldOutNotice) soldOutNotice.style.display = isSoldOut ? "block" : "none";
    root.getElementById("widgetBadge").textContent = "분석 중";
    root.getElementById("resultPill").textContent = "로딩 중";
    root.getElementById("verdictText").innerHTML =
      '<span class="review-loading-spinner" aria-hidden="true"></span>최신 리뷰를 분석하는 중…';
    root.getElementById("verdictSub").textContent =
      "사이즈표와 상품 정보를 확인한 뒤 추천 결과를 보여드릴게요.";
  }

  // 로딩 화면을 해제해 결과 섹션들을 보이게 한다.
  function revealWidgetResult(root) {
    root.getElementById("sizeWidget")?.classList.remove("is-loading");
  }

  // basisOptions/selectedBasisId를 다시 그린다. 최초 마운트뿐 아니라, 페이지의 사이즈
  // 선택이 바뀌어 recommendedSize가 갱신됐을 때도 재사용한다.
  function mountBasisList(root, state) {
    if (!getSelectedRecommendationReference(state)) {
      clearDecisionReferenceForEmptyRecommendation(state);
    }
    // 기준 선택 시: 선택 상태 저장 → (구매 이력 드롭다운이면) 판단 기준도 같은 옷으로 동기화 → 전체 재렌더
    const onSelect = (id, { syncDecisionReference = false } = {}) => {
      state.selectedBasisId = id;
      if (syncDecisionReference) syncDecisionReferenceFromRecommendation(root, state, id);
      // 드롭다운(구매 이력) 쪽에서 선택했을 수도, 일반 행 쪽에서 선택했을 수도 있으니
      // 매번 통째로 다시 그려서 두 UI의 선택 상태를 항상 일치시킨다.
      mountBasisList(root, state);
      renderScale(root, state);
      renderVerdict(root, state);
    };
    // "평소 입는 사이즈" 드롭다운에서 사용자가 직접 값을 바꿨을 때 — 더 이상 페이지에서
    // 읽어오지 않으므로, 여기서 recommendedSize와 basisOptions를 직접 갱신한다.
    const onUsualSizeChange = (newSizeText) => {
      state.data.recommendedSize = newSizeText;
      state.data.basisOptions = buildBasisOptions({
        usualSize: newSizeText,
        loggedIn: currentLoginInfo.loggedIn,
        purchaseHistory: currentLoginInfo.purchaseHistory,
        historyStatus: currentLoginInfo.historyStatus,
      });
      // 버그 수정(Reality Checker가 발견): 구매 이력 기준이 선택돼 있는 동안 "평소 입는
      // 사이즈" 드롭다운을 바꿔도, 그 시점엔 selectedBasisId("reference-...")가 여전히
      // basisOptions 안에 남아있어서(항상 다시 만들어지니까) 위쪽 "없어졌을 때만 usual로
      // 되돌리기" 조건이 절대 발동하지 않았다 — 그래서 드롭다운을 바꿔도 아무 반응이 없는
      // "죽은 컨트롤"처럼 보였다. 사용자가 이 드롭다운을 직접 조작했다는 것 자체가 "이제
      // 평소 입는 사이즈를 기준으로 쓰겠다"는 명시적 선택이므로, 무조건 usual로 전환한다
      // (다른 기준 행을 클릭했을 때와 동일한 동작).
      state.selectedBasisId = "usual";
      mountBasisList(root, state);
      renderScale(root, state);
      renderVerdict(root, state);
    };
    renderBasisList(
      root,
      root.getElementById("basisList"),
      state.data.basisOptions,
      onSelect,
      state.selectedBasisId,
      onUsualSizeChange
    );
    root.getElementById("basisValLabel").textContent =
      state.data.basisOptions.find((o) => o.id === state.selectedBasisId)?.main ?? "";
    renderFitNotes(root, state);
  }

  // [mountWidgetInto] 데이터를 불러와 위젯 상태(state)를 만들고 모든 영역을 처음 렌더링한다.
  //   핏 버튼 클릭 이벤트도 여기서 연결한다. 데이터 로드 실패 시 오류 문구를 표시하고 null 반환.
  async function mountWidgetInto(shadow, goodsNo, overrides) {
    const root = shadow; // ShadowRoot supports getElementById
    let data;
    try {
      data = await loadPredictionData(goodsNo, overrides);
    } catch (err) {
      revealWidgetResult(root);
      root.getElementById("verdictText").textContent = "데이터를 불러오지 못했어요";
      root.getElementById("verdictSub").textContent = "위젯 데이터를 불러오는 중 오류가 발생했습니다.";
      root.getElementById("resultPill").textContent = "오류";
      console.error("[사이즈위젯] loadPredictionData 실패:", err);
      return null;
    }

    // 위젯 전체 상태: 데이터, 선택한 핏, 선택한 기준, 실측표, 실측 비교 캐시, 착용 후기/판단 기준 편집 상태 등
    const state = {
      data,
      fit: data.fitDefault,
      selectedBasisId: data.basisOptions.find((o) => o.selected)?.id ?? data.basisOptions[0].id,
      sizeChart: overrides.sizeChart || null,
      measurementFallback: {},
      fitNotes: {},
      fitNotesStatus: {},
      fitNoteDrafts: {},
      decisionComparison: null,
      appliedDecisionReferenceId: null,
      decisionDraftId: null,
      decisionEditorOpen: true,
      decisionReferenceStorageState: "unknown",
    };

    if (state.sizeChart) state.sizeChart.numberedSizeMap = deriveNumberedSizeMapFromChart(state.sizeChart);

    root
      .querySelectorAll("#fitRow .fit-box")
      .forEach((b) => b.classList.toggle("selected", b.dataset.fit === state.fit));

    mountBasisList(root, state);

    root.getElementById("fitRow").addEventListener("click", (e) => {
      const btn = e.target.closest(".fit-box");
      if (!btn) return;
      state.fit = btn.dataset.fit;
      root
        .querySelectorAll("#fitRow .fit-box")
        .forEach((b) => b.classList.toggle("selected", b === btn));
      renderScale(root, state);
      renderVerdict(root, state);
    });

    renderThresholdTable(root);
    renderSizeChart(root, state.sizeChart);
    renderScale(root, state);
    renderVerdict(root, state);
    // 모든 동기 렌더링이 끝난 뒤에만 로딩 전용 화면을 해제해 중간 결과가 보이지 않게 한다.
    revealWidgetResult(root);

    return state;
  }

  // ---------------------------------------------------------
  // 6) 실제 페이지에서 "구매하기" 버튼을 찾아 그 바로 아래에 위젯을 삽입
  // ---------------------------------------------------------
  // [findBuyButton] 위젯을 붙일 기준이 되는 '구매하기' 버튼을 찾는다. 없으면 특가 CTA를 구매 영역 안에서만 찾는다.
  function findBuyButton() {
    const btns = Array.from(document.querySelectorAll("button"));

    // 일반 상품의 기존 경로는 정확히 유지한다. 같은 문구가 있으면 이전과 동일한 버튼을
    // 선택해, 기존 위젯 위치가 바뀌지 않게 한다.
    const exactBuyButton = btns.find((b) => b.textContent && b.textContent.trim() === "구매하기");
    if (exactBuyButton) return exactBuyButton;

    // 아워/타임특가에서는 메인 CTA가 "아워특가 종료까지 N일"처럼 바뀐다. 텍스트만으로
    // 찾으면 후기·실측 등 다른 영역의 버튼을 고를 수 있으므로, 기존 삽입 기준인 상품
    // 구매 영역(Purchase__Container) 안에 있는 버튼으로만 폴백을 한정한다.
    return (
      btns.find((button) => {
        const text = (button.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || !button.closest('[class*="Purchase__Container"]')) return false;
        if (/장바구니|좋아요|찜|후기|리뷰|구매내역|실측|선택하기/.test(text)) return false;
        return text.includes("특가") || text.includes("구매");
      }) || null
    );
  }

  // 품절 상품의 '품절' 또는 '재입고 알림 신청' 버튼을 찾는다(구매 영역 안의 버튼 우선).
  function findSoldOutButton() {
    const soldOutText = /^(품절|재입고 알림 신청)$/;
    const buttons = Array.from(document.querySelectorAll("button")).filter((button) =>
      soldOutText.test((button.textContent || "").replace(/\s+/g, " ").trim())
    );
    // 같은 문구가 다른 상품 카드에 있을 수 있으므로, 상품 구매 영역을 먼저 사용한다.
    return buttons.find((button) => button.closest('[class*="Purchase__Container"]')) || buttons[0] || null;
  }

  // 구매하기 버튼을 우선 찾고, 없으면 품절 버튼을 찾는다. 반환: { button, isSoldOut } 또는 null.
  function findPurchaseAction() {
    const buyButton = findBuyButton();
    if (buyButton) return { button: buyButton, isSoldOut: false };
    const soldOutButton = findSoldOutButton();
    return soldOutButton ? { button: soldOutButton, isSoldOut: true } : null;
  }

  function findInsertionAnchor(buyBtn) {
    // 무신사 상품 상세의 구매 영역 컨테이너. 클래스명 뒤 해시(sc-xxxxxxxx)는 배포마다 바뀔 수
    // 있어 contains 매칭만 사용한다 (_serve.js의 ActualSizeTable__Wrap 선택자와 동일한 전략).
    return (
      buyBtn.closest('[class*="Purchase__Container"]') ||
      buyBtn.parentElement?.parentElement ||
      buyBtn.parentElement
    );
  }

  // 해시가 붙는 클래스는 접두 선택자로 찾고, 실제 구매 동작 버튼의 문구도 확인한다.
  // 기준을 확정할 수 없는 경우 별도 진입 호스트를 만들지 않아 기존 위젯 내부 위치를 쓴다.
  function findVerifiedPurchaseContainer(purchaseAction) {
    const button = purchaseAction?.button;
    const container = button?.closest?.('[class*="Purchase__Container"]');
    if (!container || !container.contains?.(button)) return null;
    const buttonText = (button.textContent || "").replace(/\s+/g, " ").trim();
    const isExpectedAction = purchaseAction.isSoldOut
      ? /품절|재입고 알림 신청/.test(buttonText)
      : buttonText.includes("구매") || buttonText.includes("특가");
    return isExpectedAction ? container : null;
  }

  // 구매/품절 버튼이 나타날 때까지 MutationObserver + 150ms 폴링으로 최대 timeoutMs 기다린다. 못 찾으면 null.
  function waitForPurchaseAction(timeoutMs) {
    return new Promise((resolve) => {
      const existing = findPurchaseAction();
      if (existing) {
        resolve(existing);
        return;
      }
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        try {
          observer.disconnect();
        } catch (e) {}
        clearInterval(poll);
        clearTimeout(timer);
        resolve(val);
      };
      const observer = new MutationObserver(() => {
        const action = findPurchaseAction();
        if (action) finish(action);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const poll = setInterval(() => {
        const action = findPurchaseAction();
        if (action) finish(action);
      }, 150);
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  // 현재 페이지에 떠 있는 위젯의 상태들(상품 번호, host 요소, 상태 객체, shadow root)과
  // 마지막으로 확인한 로그인/구매 이력 정보.
  let currentGoodsNo = null;
  let currentHost = null;
  let currentLauncherHost = null;
  let currentState = null;
  let currentShadow = null;

  function removeCurrentWidgetHosts() {
    currentLauncherHost?.remove();
    currentHost?.remove();
    currentLauncherHost = null;
    currentHost = null;
    currentState = null;
    currentShadow = null;
  }
  let currentLoginInfo = {
    loggedIn: false,
    identity: "anonymous",
    source: "initial",
    historyStatus: "loaded",
    purchaseHistory: [],
  };
  // loginRefreshInFlight: 계정 재확인이 동시에 여러 번 돌지 않게 하는 플래그
  // injectionGeneration: inject 호출마다 1씩 증가. 비동기 작업 도중 더 새로운 inject가 시작되면
  //                      이전 작업은 isCurrentGeneration() 검사로 중단된다(상품 이동 중 꼬임 방지).
  let loginRefreshInFlight = false;
  let injectionGeneration = 0;

  // [applyPurchaseHistoryToState] 늦게 도착한 구매 이력 조회 결과로 비교 기준 목록을 다시 만들고,
  //   더 이상 존재하지 않는 선택값들(추천 기준/판단 기준)을 정리한 뒤 다시 그린다.
  function applyPurchaseHistoryToState(root, state, loginState, historyResult) {
    const usualSize = state.data.basisOptions.find((option) => option.id === "usual")?.value || "M";
    state.data.basisOptions = buildBasisOptions({
      usualSize,
      loggedIn: loginState.loggedIn,
      purchaseHistory: historyResult.items,
      historyStatus: historyResult.status,
    });
    if (!state.data.basisOptions.some((option) => option.id === state.selectedBasisId)) {
      state.selectedBasisId = "usual";
    }
    const historyOptions = getHistoryBasisOptions(state);
    if (!historyOptions.some((option) => option.id === state.appliedDecisionReferenceId)) {
      state.appliedDecisionReferenceId = null;
      state.decisionEditorOpen = true;
    }
    if (!historyOptions.some((option) => option.id === state.decisionDraftId)) {
      state.decisionDraftId = historyOptions[0]?.id || null;
    }
    mountBasisList(root, state);
    renderScale(root, state);
    renderVerdict(root, state);
  }

  // ---------------------------------------------------------
  // 확장이 새로고침/업데이트되면, 이미 열려 있던 무신사 탭에는 이전 content script
  // 인스턴스가 그대로 남는다("orphan"). 이 인스턴스의 chrome.runtime.id는 사라지지만
  // window.addEventListener("focus", ...), visibilitychange, setInterval 들은 계속
  // 살아서 매번 "Extension context invalidated" 경고를 반복하고, reverifyAccount가
  // DOM 신호로 폴백하다 계정이 바뀐 것으로 오판해 위젯을 지우고 재삽입할 수도 있다.
  // → 컨텍스트가 죽으면 이 인스턴스가 소유한 인터벌/리스너만 정리하고 완전히 멈춘다.
  // 새 인스턴스가 다음 로드(또는 자신의 scheduleInject)에서 위젯을 관리하므로, 여기서는
  // 절대 DOM(위젯 host)을 건드리지 않는다.
  // ---------------------------------------------------------
  let orphaned = false;
  let loginIntervalId = null;
  let hrefPollIntervalId = null;

  // 확장 컨텍스트(chrome.runtime.id)가 살아 있는지 확인한다. 확장을 새로고침하면 false가 된다.
  function isExtensionContextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // 탭이 다시 보이면 계정이 바뀌었는지 재확인한다.
  function handleVisibilityChange() {
    if (document.visibilityState === "visible") reverifyAccount();
  }

  // [teardownOrphan] orphan 인스턴스의 이벤트 리스너와 인터벌을 한 번만 정리한다(위젯 DOM은 건드리지 않음).
  function teardownOrphan() {
    if (orphaned) return;
    orphaned = true;
    window.removeEventListener("focus", reverifyAccount);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    if (loginIntervalId != null) clearInterval(loginIntervalId);
    if (hrefPollIntervalId != null) clearInterval(hrefPollIntervalId);
    console.info("[사이즈위젯] 확장이 새로고침되어 이전 content script 인스턴스를 정리합니다.");
  }

  // [inject] 위젯 삽입의 메인 진입점. 상품 페이지 로드/이동 때마다 호출된다.
  //   아우터 확인 → 데이터 병렬 준비 → 버튼 아래 로딩 위젯 삽입 → 리뷰(최대 5초)·실측표 대기
  //   → 최종 렌더링 → 최근 본 상품 저장 → (나중에) 구매 이력 반영.
  //   같은 상품의 위젯이 이미 붙어 있으면 아무것도 하지 않는다.
  async function inject() {
    if (!isExtensionContextValid()) {
      teardownOrphan();
      return;
    }
    const generation = ++injectionGeneration;
    const isCurrentGeneration = () => generation === injectionGeneration;
    const goodsNo = extractGoodsNo(location.href);
    if (!goodsNo) return;
    // SPA 상품 이동을 감지하면 새 카테고리/구매 버튼 탐색을 기다리지 않고 이전 상품 위젯을 지운다.
    // 새 상품에 이전 코디·사이즈가 남거나 새 페이지에서 CTA를 못 찾아 영구 잔존하는 일을 막는다.
    if (goodsNo !== currentGoodsNo) {
      removeCurrentWidgetHosts();
      currentGoodsNo = null;
    }
    if (goodsNo === currentGoodsNo && currentHost && currentHost.isConnected) return;
    const timing = createTimingLogger(goodsNo);
    timing("inject-start");

    // 카테고리 게이트: 아우터가 아니면 위젯 삽입은 물론, 모델/조회 테이블 로드 등
    // 어떤 데이터 로딩 로직도 실행하지 않고 바로 종료한다.
    const isOuter = await timePromise(timing, "category-gate", waitForCategoryDecision(goodsNo, 6000));
    if (!isCurrentGeneration()) return;
    if (!isOuter) {
      if (currentHost) {
        removeCurrentWidgetHosts();
      }
      currentGoodsNo = goodsNo;
      return;
    }

    // CTA 탐색과 모델·리뷰·실측표 준비는 서로 의존하지 않는다. 단, 위젯 host는 CTA를
    // 찾는 즉시 먼저 삽입해, 이후 데이터 준비 시간에는 빈 자리가 아니라 로딩 화면을 보인다.
    // 모델 로드 시작(실패는 나중에 mountWidgetInto에서 처리하므로 여기서는 unhandled 경고만 막음)
    const modelPromise = timePromise(timing, "model-load", loadModel());
    void modelPromise.catch(() => {});
    // 리뷰: 캐시가 있으면 바로 사용, 없으면 리뷰 요약 API 요청을 시작해 둔다.
    const reviewPreparationPromise = timePromise(timing, "review-cache-read", getProductReviewCache(goodsNo)).then(
      (cachedProductReview) => {
        timing("review-cache", { hit: !!cachedProductReview });
        return {
          cachedProductReview,
          productReviewPromise: cachedProductReview
            ? Promise.resolve({ value: cachedProductReview })
            : timePromise(timing, "review-summary", getProductReviewResult(goodsNo)).then(
                (value) => ({ value }),
                (error) => ({ error })
              ),
        };
      },
      (error) => {
        console.warn("[사이즈위젯] 리뷰 캐시 읽기 실패:", error);
        return { cachedProductReview: null, productReviewPromise: Promise.resolve({ error }) };
      }
    );
    // 로그인 상태는 캐시 없이 새로 확인하고, 로그인 상태면 구매 이력 조회를 이어서 시작한다.
    const loginStatePromise = timePromise(timing, "login-state", getLoginState(true));
    const historyPromise = loginStatePromise.then((loginState) => {
      if (!loginState.loggedIn) return { status: loginState.failed ? "failed" : "loaded", items: [] };
      return timePromise(timing, "purchase-history", fetchPurchaseHistory(loginState.identity));
    });
    // 페이지 실측표가 나타날 때까지 최대 9초 기다린다.
    const sizeChartPromise = timePromise(timing, "size-chart", waitForSizeChart(9000));

    // 구매하기/품절 버튼이 나타날 때까지 최대 20초 기다린다.
    const purchaseAction = await timePromise(timing, "purchase-action", waitForPurchaseAction(20000));
    if (!isCurrentGeneration()) return;
    if (!purchaseAction) {
      console.warn("[사이즈위젯] 구매하기·품절·재입고 알림 버튼을 찾지 못해 위젯을 삽입하지 못했습니다.");
      return;
    }

    // 상품이 바뀐 경우(클라이언트 라우팅) 이전 위젯 제거
    if (currentHost) {
      removeCurrentWidgetHosts();
    }

    const purchaseContainer = findVerifiedPurchaseContainer(purchaseAction);
    const anchor = purchaseContainer || findInsertionAnchor(purchaseAction.button);
    if (!anchor || !anchor.parentElement) {
      console.warn("[사이즈위젯] 삽입 위치를 찾지 못했습니다.");
      return;
    }
    if (!isCurrentGeneration()) return;

    // 확장이 새로고침된 직후에는, 정리되지 않은 orphan 인스턴스가 남긴 위젯 host가
    // 이 페이지에 이미 있을 수 있다(같은 id). 같은 id를 가진 host를 중복 삽입하지
    // 않도록, 이 인스턴스가 모르는 잔여 host는 먼저 제거한다.
    const staleHost = document.getElementById("musinsa-brand-size-widget-outfit-host");
    if (staleHost && staleHost !== currentHost) staleHost.remove();
    const staleLauncherHost = document.getElementById(RECOMMENDATION_LAUNCHER_HOST_ID);
    if (staleLauncherHost && staleLauncherHost !== currentLauncherHost) staleLauncherHost.remove();
    const staleModalHost = document.getElementById("musinsa-brand-size-recommendation-modal-host");
    if (staleModalHost) staleModalHost.remove();

    const { host, shadow, modalShadow, launcherHost, launcherShadow } = createWidgetHost({
      separateLauncher: Boolean(purchaseContainer),
    });
    setWidgetLoading(shadow, purchaseAction.isSoldOut);
    anchor.insertAdjacentElement("afterend", host);
    // 위젯을 먼저 넣은 뒤 같은 기준 요소 바로 다음에 진입 호스트를 넣어 순서를 고정한다.
    if (launcherHost) anchor.insertAdjacentElement("afterend", launcherHost);
    currentHost = host;
    currentLauncherHost = launcherHost;
    currentGoodsNo = goodsNo;

    // host 삽입은 데이터 완료와 분리해 계측한다. 이 시각부터 사용자는 로딩 화면을 본다.
    timing("host-inserted", { isSoldOut: purchaseAction.isSoldOut });
    const { cachedProductReview, productReviewPromise } = await reviewPreparationPromise;
    if (!isCurrentGeneration()) return;

    // "평소 입는 사이즈"는 더 이상 무신사 페이지의 사이즈 선택 컨트롤에서 자동으로 읽지
    // 않는다(사용자 요청으로 자동 읽기/실시간 동기화 제거) — 위젯 안의 드롭다운으로 직접
    // 고르게 하며, 초기값은 고정 기본값 "M"이다.
    // 새 문서에서는 계정 전환 직후의 확장 저장소 캐시를 신뢰하지 않고 반드시 세션을 재확인한다.
    const loginState = await loginStatePromise;
    if (!isCurrentGeneration()) return;
    const loggedIn = loginState.loggedIn;
    const initialHistory = {
      status: loggedIn ? "loading" : loginState.failed ? "failed" : "loaded",
      items: [],
    };
    currentLoginInfo = { ...loginState, historyStatus: initialHistory.status, purchaseHistory: [] };

    let productReviewResult = cachedProductReview;
    let productReviewStatus = cachedProductReview ? "cached" : "loaded";
    // 캐시가 없으면 리뷰 응답을 최대 5초만 기다리고, 늦으면 기존 데이터로 예측한다.
    if (!cachedProductReview) {
      let reviewTimeoutId;
      const reviewTimeout = new Promise((resolve) => {
        reviewTimeoutId = setTimeout(() => resolve(null), PRODUCT_REVIEW_TIMEOUT_MS);
      });
      try {
        const reviewOutcome = await Promise.race([productReviewPromise, reviewTimeout]);
        productReviewResult = reviewOutcome?.value || null;
        if (!productReviewResult || reviewOutcome?.error) productReviewStatus = "failed";
        if (reviewOutcome?.error) console.warn("[사이즈위젯] 최신 상품 리뷰 조회 실패:", reviewOutcome.error);
      } catch (err) {
        productReviewResult = null;
        productReviewStatus = "failed";
        console.warn("[사이즈위젯] 최신 상품 리뷰 조회 실패:", err);
      } finally {
        clearTimeout(reviewTimeoutId);
      }
    }
    if (!isCurrentGeneration()) return;
    // 응답 수가 기준(10건) 미만이면 '부족' 상태로 표시한다.
    if (productReviewResult && productReviewStatus !== "failed" && productReviewResult.reviewCount < PRODUCT_REVIEW_MIN_RESPONSES) {
      productReviewStatus = "insufficient";
    }

    // 실측표도 로딩 중 병렬로 준비한다. 최종 화면은 이 결과까지 반영한 한 번의 렌더링으로
    // 교체해, 실측표가 늦게 붙으면서 추천이 중간에 바뀌지 않게 한다.
    const sizeChart = await sizeChartPromise;
    if (!isCurrentGeneration()) return;

    const state = await mountWidgetInto(shadow, goodsNo, {
      usualSize: "M",
      loggedIn,
      purchaseHistory: initialHistory.items,
      historyStatus: initialHistory.status,
      reviewResult: productReviewResult,
      reviewStatus: productReviewStatus,
      sizeChart,
    });
    if (!isCurrentGeneration()) return;
    if (state && window.MusinsaOutfitRecommendations?.render) {
      void window.MusinsaOutfitRecommendations.render(shadow, goodsNo, state.data, modalShadow, launcherShadow).catch((err) => {
        console.warn("[사이즈·코디위젯] 코디/비슷한 상품 추천 표시 실패:", err);
      });
    }
    // 최근 본 상품에 현재 상품을 저장하고 위젯 하단 목록을 갱신한다.
    await saveRecentProduct(readRecentProductMetadata(goodsNo, state?.data?.productName));
    if (!isCurrentGeneration()) return;
    void renderRecentProducts(shadow, goodsNo);
    if (!state) return;
    currentState = state;
    currentShadow = shadow;
    timing("final-result-rendered", {
      reviewStatus: productReviewStatus,
      historyPending: loggedIn,
    });

    // 구매 이력은 추천 점수를 바꾸지 않는 선택 기준이다. 느린 상품 카테고리 확인 때문에
    // 첫 최종 추천을 지연시키지 않고, 완료되면 기준 선택지만 갱신한다.
    void historyPromise.then((historyResult) => {
      if (!isCurrentGeneration() || currentState !== state || currentShadow !== shadow) return;
      currentLoginInfo = {
        ...loginState,
        historyStatus: historyResult.status,
        purchaseHistory: historyResult.items,
      };
      applyPurchaseHistoryToState(shadow, state, loginState, historyResult);
      timing("purchase-history-applied", {
        status: historyResult.status,
        count: historyResult.items.length,
      });
    });

  }

  // inject를 실행하고 오류는 콘솔에만 남긴다(확장 컨텍스트가 죽었으면 정리만).
  function scheduleInject() {
    if (!isExtensionContextValid()) {
      teardownOrphan();
      return;
    }
    inject().catch((err) => console.error("[사이즈위젯] 삽입 실패:", err));
  }

  // 스크립트 로드 직후 첫 삽입 시도
  scheduleInject();

  // [reverifyAccount] 로그인 상태를 다시 확인해 로그인/로그아웃/계정 전환이 감지되면
  //   위젯을 지우고 새 계정 기준으로 다시 삽입한다(계정 식별이 불확실하면 해당 이력 캐시도 삭제).
  async function reverifyAccount() {
    if (!isExtensionContextValid()) {
      teardownOrphan();
      return;
    }
    if (loginRefreshInFlight || !currentHost?.isConnected) return;
    loginRefreshInFlight = true;
    try {
      const next = await getLoginState(true);
      const identityUnknown =
        next.loggedIn && (next.identity === "member:unknown" || next.identity === "dom:unknown");
      const accountChanged =
        next.loggedIn !== currentLoginInfo.loggedIn ||
        next.identity !== currentLoginInfo.identity ||
        next.source !== currentLoginInfo.source ||
        identityUnknown;
      if (accountChanged) {
        if (identityUnknown) {
          const suffix = encodeURIComponent(next.identity);
          await chrome.storage.local.remove([
            `sizeWidget:history:${suffix}`,
            `sizeWidget:orders:${suffix}`,
            `sizeWidget:reviews:${suffix}`,
          ]);
        }
        removeCurrentWidgetHosts();
        currentGoodsNo = null;
        currentLoginInfo = { ...next, historyStatus: "loaded", purchaseHistory: [] };
        scheduleInject();
      }
    } finally {
      loginRefreshInFlight = false;
    }
  }

  // 창 포커스·탭 표시·2분 주기마다 계정 상태를 재확인한다.
  window.addEventListener("focus", reverifyAccount);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  loginIntervalId = setInterval(reverifyAccount, CACHE_TTL.login);

  // SPA 내에서 goodsNo가 바뀌는 클라이언트 라우팅(관련 상품 클릭 등)만 폴링한다.
  // "평소 입는 사이즈"는 더 이상 페이지 선택을 따라 실시간 동기화하지 않는다(사용자가
  // 위젯 안의 드롭다운으로 직접 고른 값을 그대로 유지한다).
  let lastHref = location.href;
  hrefPollIntervalId = setInterval(() => {
    if (!isExtensionContextValid()) {
      teardownOrphan();
      return;
    }
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (/\/products\/\d+/.test(location.href)) {
        scheduleInject();
      } else {
        // 상품 페이지가 아닌 곳으로 이동하면 진행 중인 삽입을 무효화하고 위젯을 제거한다.
        injectionGeneration += 1;
        removeCurrentWidgetHosts();
        currentGoodsNo = null;
      }
    }
  }, 800);
})();
