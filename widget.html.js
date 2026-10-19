// =============================================================================
// widget.html.js — 사이즈 추천 위젯의 HTML 마크업(템플릿 문자열)
// -----------------------------------------------------------------------------
// manifest.json에서 content.js보다 먼저 주입되며, 전역 상수 WIDGET_HTML을 제공한다.
// content.js는 이 문자열로 위젯 DOM을 만들어 무신사 구매하기 버튼 아래에 삽입하고,
// 아래 id들을 찾아 텍스트·표·게이지 값을 채운다. (마크업 자체는 동작에 영향이 없도록
// 템플릿 안에는 주석을 넣지 않고, 구성은 여기서 설명한다.)
//
// 원본: brand_size_widget/index.html 의 <div class="size-widget" id="sizeWidget"> 블록
// ("내가 원하는 핏에 맞는 사이즈 찾기" 이하)을 그대로 옮긴 것. 데모 전용
// 이미지/입력 패널 마크업은 포함하지 않는다.
//
// 구성(위에서 아래 순서)
//   #soldOutNotice       품절 상품일 때만 보이는 안내 문구
//   .widget-head         위젯 제목 + 예측 방식 배지(#widgetBadge)
//   #fitRow              원하는 핏 선택 버튼(data-fit)
//   #basisAccordion      "비교 기준" 아코디언 — 평소 입는 사이즈·구매 이력 등 기준 목록(#basisList)
//                        과 계산된 사이즈가 판매 목록에 없을 때의 경고(#availabilityAlert)
//   #resultBox           예측 결과: 데이터 출처 배지(#resultPill), 추천 문구(#verdictText),
//                        상품 리뷰 안내(#productReviewNote), 추정값 고지(#predictionDisclaimer)
//   #decisionBasis       판단 기준 요약 문장(#decisionBasisLines)
//   .eval                예측 점수 게이지(−2 작아요 ~ +2 커요). #scalePin=최종 점수,
//                        #scaleRefPin=기준 상품 점수 위치
//   #detailsAccordion    "자세히 보기" 아코디언
//     - #verdictSub / #chartCheckNote   상세 설명, 실측표 대조 결과
//     - 점수 상세: 브랜드/카테고리 평균(#brandScoreLabel, #categoryScoreLabel),
//                  산정식(#scoreBasisFormula, #formulaText)
//     - #thresholdTable  핏별 사이즈업/다운 기준값 표
//     - #sizeChartBox    브랜드 제공 실측 사이즈표(#sizeChartTable), 측정 위치 도식,
//                        실측표가 없을 때의 문구(#sizeChartEmpty)
// =============================================================================
const WIDGET_HTML = `
<div class="size-widget" id="sizeWidget">

  <div class="sold-out-notice" id="soldOutNotice" role="status" style="display:none;">
    품절된 상품이에요. 재입고되면 구매할 수 있도록 사이즈를 미리 추천해 드려요.
  </div>

  <div class="widget-head">
    <span class="dot"></span>
    <h3>내가 원하는 핏에 맞는 사이즈 찾기</h3>
    <span id="widgetBadge">브랜드 기반 예측</span>
  </div>

  <div class="fit-row" id="fitRow">
    <button class="fit-box" data-fit="slim">
      <span class="sq"></span>슬림핏
    </button>
    <button class="fit-box selected" data-fit="regular">
      <span class="sq"></span>정핏
    </button>
    <button class="fit-box" data-fit="over">
      <span class="sq"></span>오버핏
    </button>
  </div>

  <details class="acc" open id="basisAccordion">
    <summary>
      비교 기준 <span class="val" id="basisValLabel">평소 입는 사이즈</span>
      <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
    </summary>
    <div class="acc-panel">
      <div class="basis-list" id="basisList"></div>
      <div class="availability-alert" id="availabilityAlert" role="alert" style="display:none;"></div>
    </div>
  </details>

  <div class="result" id="resultBox">
    <div class="row1">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2 3 14h7l-1 8 11-14h-7l1-6z"/></svg>
      예측 결과
      <span class="pill" id="resultPill">리뷰 부족 · 브랜드+카테고리 예측</span>
    </div>
    <p class="verdict" id="verdictText">사이즈 계산 중...</p>
    <p class="product-review-note" id="productReviewNote" style="display:none;"></p>
    <p class="prediction-disclaimer" id="predictionDisclaimer" role="note">⚠ 구매 리뷰를 바탕으로 추정한 값이라 실제와 다를 수 있어요.</p>
  </div>

  <section class="recommendation-launcher" id="recommendationLauncher" hidden aria-label="코디와 비슷한 상품">
    <button class="recommendation-open-button" id="recommendationOpenButton" type="button" aria-haspopup="dialog" aria-expanded="false">
      <span class="recommendation-launcher-copy">
        <span class="recommendation-launcher-title">코디 · 비슷한 상품 크게 보기</span>
        <span class="recommendation-summary" id="recommendationSummary" aria-live="polite">불러오는 중…</span>
      </span>
      <span class="recommendation-preview" id="recommendationPreview" aria-hidden="true" hidden></span>
    </button>
  </section>

  <section class="decision-basis" id="decisionBasis" aria-live="polite">
    <div class="decision-basis-title">판단 기준</div>
    <div class="decision-basis-lines" id="decisionBasisLines">구매 이력과 실측표를 확인하고 있어요.</div>
  </section>

  <div class="eval">
    <div class="gauge-title">예측 점수</div>
    <div class="scale-wrap">
      <div class="scale-pin reference" id="scaleRefPin" style="left:50%; display:none;">
        <span class="flag" id="scaleRefFlag">-</span>
        <span class="stem"></span><span class="head"></span>
      </div>
      <div class="scale-pin combined" id="scalePin" style="left:50%">
        <span class="flag" id="scaleFlag">+0.00</span>
        <span class="stem"></span><span class="head"></span>
      </div>
      <div class="scale-track"></div>
      <div class="scale-ticks">
        <span>−2</span><span>−1</span><span>0</span><span>+1</span><span>+2</span>
      </div>
    </div>
  </div>

  <details class="acc details-accordion" id="detailsAccordion">
    <summary>
      자세히 보기
      <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
    </summary>
    <div class="acc-panel">
      <p class="sub detail-copy" id="verdictSub"></p>
      <p class="chart-check" id="chartCheckNote" style="display:none;"></p>
      <p class="disclaimer">
        <strong>⚠ 참고용 결과예요.</strong> 착용감은 체형과 취향에 따라 달라질 수 있어요.
      </p>

      <div class="detail-section">
        <div class="scale-title">
          <span id="scaleTitleText">브랜드+카테고리 결합 예측 점수</span>
          <span>−2(작아요) ~ +2(커요)</span>
        </div>
        <p class="scale-sub" id="scaleSub"></p>
        <div class="scale-legend" id="scaleLegend">
          <span class="sw brand"><i></i>브랜드 평균 <b id="brandScoreLabel">-</b></span>
          <span class="sw category"><i></i>카테고리 평균 <b id="categoryScoreLabel">-</b></span>
        </div>
        <div class="score-basis" id="scoreBasis" style="display:none;">
          <div class="score-basis-title">점수 산정 기준</div>
          <p class="score-basis-formula" id="scoreBasisFormula"></p>
        </div>
        <p class="scale-formula" id="formulaText"></p>
        <div class="widget-foot">
          ※ 리뷰가 부족하면 같은 브랜드·카테고리 응답으로 예측하고, 실제 후기가 충분하면 해당 상품 데이터를 우선해요.
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title">핏별 사이즈 조정 기준</div>
        <table class="threshold-table" id="thresholdTable">
          <thead>
            <tr><th>핏</th><th>사이즈다운 기준 (+, 한 단계 / 두 단계)</th><th>사이즈업 기준 (−, 한 단계 / 두 단계)</th></tr>
          </thead>
          <tbody id="thresholdTableBody"></tbody>
        </table>
      </div>

      <div class="detail-section" id="sizeChartBox" style="display:none;">
        <div class="size-chart-head">실측 사이즈표 <span class="size-chart-note">(브랜드 제공, cm 기준)</span></div>
        <table class="threshold-table" id="sizeChartTable" style="display:none;">
          <thead><tr id="sizeChartHeadRow"></tr></thead>
          <tbody id="sizeChartBody"></tbody>
        </table>
        <div class="size-chart-diagram" id="sizeChartDiagram" style="display:none;">
          <img id="sizeChartDiagramImg" alt="실측 위치 안내 도식">
          <p class="size-chart-legend" id="sizeChartLegend" style="display:none;"></p>
        </div>
        <p class="size-chart-empty" id="sizeChartEmpty" style="display:none;">실측 정보 없음 (이 상품 페이지에는 브랜드가 제공한 실측표가 없어요)</p>
      </div>
    </div>
  </details>
</div>

<div class="recommendation-modal" id="recommendationModal" hidden>
  <div class="recommendation-modal-backdrop" id="recommendationModalBackdrop"></div>
  <section class="recommendation-dialog" id="recommendationDialog" role="dialog" aria-modal="true" aria-labelledby="recommendationDialogTitle" tabindex="-1">
    <header class="recommendation-dialog-header">
      <div>
        <h2 id="recommendationDialogTitle">코디 · 비슷한 상품</h2>
        <p>추천 코디와 비슷한 상품을 크게 볼 수 있어요.</p>
      </div>
      <button class="recommendation-close-button" id="recommendationCloseButton" type="button" aria-label="팝업 닫기">×</button>
    </header>
    <div class="recommendation-tabs" role="tablist" aria-label="추천 종류">
      <button class="recommendation-tab" id="outfitRecommendationTab" type="button" role="tab" aria-selected="true" aria-controls="outfitRecommendationSection" tabindex="0">코디</button>
      <button class="recommendation-tab" id="similarRecommendationTab" type="button" role="tab" aria-selected="false" aria-controls="similarRecommendationSection" tabindex="-1">비슷한 상품</button>
    </div>
    <section class="recommendation-modal-panel" id="outfitRecommendationSection" role="tabpanel" aria-labelledby="outfitRecommendationTab" tabindex="0">
      <p class="recommendation-modal-status" id="outfitRecommendationStatus" role="status">불러오는 중…</p>
      <div id="outfitRecommendationContent">
        <p class="recommendation-empty">함께 스타일링된 상품을 찾고 있어요.</p>
      </div>
    </section>
    <section class="recommendation-modal-panel" id="similarRecommendationSection" role="tabpanel" aria-labelledby="similarRecommendationTab" tabindex="0" hidden>
      <p class="recommendation-modal-status" id="similarRecommendationStatus" role="status">불러오는 중…</p>
      <div id="similarRecommendationContent">
        <p class="recommendation-empty">비슷한 상품을 찾고 있어요.</p>
      </div>
    </section>
  </section>
</div>
`;
