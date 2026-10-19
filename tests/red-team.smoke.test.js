"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectDir = path.resolve(__dirname, "..");
const recommendations = require(path.join(projectDir, "outfit-recommendations.js"));
const smokeCases = [];

function test(name, run) {
  smokeCases.push({ name, run });
}

function product(goodsNo, name, extra = {}) {
  return { goodsNo: String(goodsNo), goodsName: name, ...extra };
}

function makeElement(root, initial = {}) {
  const attributes = {};
  const listeners = {};
  return Object.assign({
    hidden: false,
    innerHTML: "",
    textContent: "",
    style: {},
    isConnected: true,
    addEventListener(type, listener) { listeners[type] = listener; },
    dispatch(type, event = {}) { listeners[type]?.({ target: this, preventDefault() {}, ...event }); },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },
    removeAttribute(name) { delete attributes[name]; },
    replaceChildren() { this.innerHTML = ""; },
    querySelectorAll() { return this.focusableElements || []; },
    closest() { return null; },
    contains(element) { return this.focusableElements?.includes(element) || false; },
    focus() { root.activeElement = this; },
  }, initial);
}

function makeRoot(goodsNo = "1000001") {
  const root = { activeElement: null, host: { isConnected: true } };
  const modalHost = {
    isConnected: false,
    style: { position: "fixed", inset: "0", zIndex: "2147483647" },
    parentNode: null,
    remove() {
      if (this.parentNode?.removeChild) this.parentNode.removeChild(this);
      else { this.parentNode = null; this.isConnected = false; }
    },
  };
  const modalRoot = { activeElement: null, host: modalHost };
  const elements = {
    recommendationLauncher: makeElement(root, { hidden: true }),
    recommendationOpenButton: makeElement(root),
    recommendationSummary: makeElement(root),
    recommendationPreview: makeElement(root, { hidden: true }),
    recommendationModal: makeElement(modalRoot, { hidden: true }),
    recommendationDialog: makeElement(modalRoot),
    recommendationCloseButton: makeElement(modalRoot),
    recommendationModalBackdrop: makeElement(modalRoot),
    outfitRecommendationTab: makeElement(modalRoot),
    similarRecommendationTab: makeElement(modalRoot),
    outfitRecommendationSection: makeElement(modalRoot),
    outfitRecommendationContent: makeElement(root, { innerHTML: "기존 코디" }),
    outfitRecommendationStatus: makeElement(root, { textContent: "불러오는 중" }),
    similarRecommendationSection: makeElement(modalRoot),
    similarRecommendationContent: makeElement(root, { innerHTML: "기존 유사 상품" }),
    similarRecommendationStatus: makeElement(root, { textContent: "불러오는 중" }),
  };
  elements.recommendationDialog.focusableElements = [elements.recommendationCloseButton, elements.outfitRecommendationTab, elements.similarRecommendationTab];
  root.getElementById = (id) => elements[id];
  modalRoot.getElementById = (id) => elements[id];
  return { elements, root, modalRoot, modalHost, goodsNo };
}

function makeSnap(goods) {
  return { list: [{ id: "snap-1", goods }] };
}

test("이미지와 상품 링크는 goodsNo가 맞는 대표 상품으로 제한한다", () => {
  const correct = "https://image.msscdn.net/images/goods_img/20261001/3801654/3801654_1.jpg";
  const wearingCut = "https://image.msscdn.net/images/snap/20261001/9999999_1.jpg";
  const hat = product(3801654, "아치 고딕 로고 볼캡", {
    imageUrl: wearingCut,
    goodsImageUrl: correct,
    linkUrl: "https://www.musinsa.com/products/9999999?goodsNo=9999999",
  });
  const normalized = recommendations.normalizeProduct(hat, 0, "snap");
  assert.equal(normalized.image, correct);
  assert.equal(recommendations.isCatalogImageForProduct(correct, "3801654"), true);
  assert.equal(normalized.url, "https://www.musinsa.com/products/3801654");

  const ambiguousSnapMedia = recommendations.normalizeProduct(product(3801654, "아치 고딕 로고 볼캡", { thumbnailUrl: wearingCut }), 0, "snap");
  assert.equal(ambiguousSnapMedia.image, "", "상품 번호를 확인할 수 없는 스냅 미디어는 착용컷 오매핑을 피하도록 비운다");
  assert.equal(recommendations.imageUrlMatchesProduct(wearingCut, "3801654"), false);
  assert.equal(recommendations.getProductUrl(product(3801654, "모자", { linkUrl: "https://example.com/products/1234567" })),
    "https://www.musinsa.com/products/3801654", "허용되지 않은 도메인 링크도 정식 상품 링크로 바꾼다");
});

test("판매 중지와 품절 후보는 제외하고 현재 상품은 유사 목록에서 제외한다", () => {
  const current = { goodsNo: "1000001", name: "남성 24FW 코트", gender: "men", season: "cold" };
  const candidates = [
    { ...recommendations.normalizeProduct(product(1000001, "현재 상품")), rank: 0 },
    { ...recommendations.normalizeProduct(product(1000002, "남성 코트", { goodsStatus: "SOLD_OUT" })), rank: 1 },
    { ...recommendations.normalizeProduct(product(1000003, "남성 코트", { saleStatus: "판매중지" })), rank: 2 },
    { ...recommendations.normalizeProduct(product(1000004, "남성 코트", { isAvailable: false })), rank: 3 },
    { ...recommendations.normalizeProduct(product(1000005, "남성 코트", { soldOut: false })), rank: 4 },
  ];
  assert.equal(recommendations.isExplicitlyUnavailable({ soldOut: false }), false);
  assert.deepEqual(recommendations.scoreSimilarProducts(current, candidates).map((item) => item.goodsNo), ["1000005"]);
  const collected = recommendations.collectSimilarCandidates({ data: { recommendedGoodsList: [
    product(1000006, "남성 코트"), product(1000006, "남성 코트 중복"),
  ] } });
  assert.deepEqual(collected.map((item) => item.goodsNo), ["1000006"]);
});

test("코디는 아우터와 성별·시즌 충돌을 제외하고 타입 중복을 만들지 않는다", () => {
  const current = { goodsNo: "1000001", name: "남성 24FW 패딩", gender: "men", season: "cold" };
  const mixed = makeSnap([
    product(2000001, "남성 반팔 티셔츠", { genderName: "남성", seasonName: "24SS" }),
    product(2000002, "남성 데님 팬츠", { genderName: "남성", seasonName: "24SS" }),
    product(2000003, "남성 스니커즈", { genderName: "남성", seasonName: "24SS" }),
  ]);
  assert.equal(recommendations.makeOutfitSets(mixed, current).length, 0, "겨울 상품과 명시적 SS 상품의 조합은 거른다");

  const menCurrent = { goodsNo: "1000001", name: "남성 재킷", gender: "men" };
  const genderMismatch = makeSnap([
    product(2100001, "여성 블라우스", { genderName: "여성" }),
    product(2100002, "남성 데님 팬츠", { genderName: "남성" }),
    product(2100003, "남성 로퍼", { genderName: "남성" }),
  ]);
  const sets = recommendations.makeOutfitSets(genderMismatch, menCurrent);
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].items.map((item) => item.type), ["bottom", "shoes"]);

  const outerAndDuplicateTop = makeSnap([
    product(2200001, "남성 니트 상의"),
    product(2200002, "남성 긴팔 셔츠"),
    product(2200003, "남성 바지"),
    product(2200004, "남성 스니커즈"),
    product(2200005, "남성 패딩 아우터"),
  ]);
  const clean = recommendations.makeOutfitSets(outerAndDuplicateTop, menCurrent);
  assert.equal(clean.length, 1);
  assert.deepEqual(clean[0].items.map((item) => item.type), ["top", "bottom", "shoes"]);
  assert.equal(recommendations.classifyOutfitType(product(2200005, "남성 패딩 아우터")), "");
});

test("신발이 있는 코디를 우선하고 세트 간 핵심 상품 중복을 막는다", () => {
  const top = { goodsNo: "1", type: "top" };
  const bottom = { goodsNo: "2", type: "bottom" };
  const shoes = { goodsNo: "3", type: "shoes" };
  const accessoryA = { goodsNo: "4", type: "accessory" };
  const accessoryB = { goodsNo: "5", type: "accessory" };
  const selected = recommendations.selectDiverseOutfitSets([
    { score: 5, items: [top, bottom, accessoryA] },
    { score: 7, items: [top, bottom, shoes] },
    { score: 6, items: [top, bottom, accessoryB] },
  ]);
  assert.equal(selected[0].items.some((item) => item.type === "shoes"), true);
  assert.equal(selected.length, 1, "액세서리만 바뀐 코디를 두 번째 세트로 반복하지 않는다");
});

test("빈 추천과 요청 실패 상태를 모달 패널 안에서 구분한다", () => {
  const outfit = makeRoot();
  recommendations.renderOutfits(outfit.elements.outfitRecommendationSection, outfit.elements.outfitRecommendationContent,
    outfit.elements.outfitRecommendationStatus, { kind: "empty", sets: [] });
  assert.equal(outfit.elements.outfitRecommendationSection.hidden, false);
  assert.equal(outfit.elements.outfitRecommendationStatus.textContent, "결과 없음");

  const similar = makeRoot();
  recommendations.renderSimilar(similar.elements.similarRecommendationSection, similar.elements.similarRecommendationContent,
    similar.elements.similarRecommendationStatus, {}, []);
  assert.equal(similar.elements.similarRecommendationSection.hidden, false);
  assert.equal(similar.elements.similarRecommendationStatus.textContent, "결과 없음");

  const failed = makeRoot();
  recommendations.renderOutfits(failed.elements.outfitRecommendationSection, failed.elements.outfitRecommendationContent,
    failed.elements.outfitRecommendationStatus, { kind: "error", sets: [] });
  assert.equal(failed.elements.outfitRecommendationSection.hidden, false);
  assert.match(failed.elements.outfitRecommendationContent.innerHTML, /불러오지 못했어요/);

  const modal = makeRoot();
  const controller = recommendations.createRecommendationModalController(modal.root);
  controller.update({
    outfit: { kind: "snap", sets: [{ items: [product(101, "상의", { image: "https://image.msscdn.net/101.jpg" })] }] },
    similar: { kind: "items", items: [product(102, "비슷한 상품", { image: "https://image.msscdn.net/102.jpg" })] },
  });
  assert.equal(modal.elements.recommendationSummary.textContent, "코디 1세트 · 비슷한 상품 1개");
  assert.match(modal.elements.recommendationPreview.innerHTML, /recommendation-preview-image/);
  controller.update({ outfit: { kind: "loading", sets: [] }, similar: { kind: "loading", items: [] } });
  assert.equal(modal.elements.recommendationSummary.textContent, "불러오는 중…");
  controller.update({ outfit: { kind: "empty", sets: [] }, similar: { kind: "items", items: [{ goodsNo: "102", name: "비슷한 상품", image: "" }] } });
  assert.match(modal.elements.recommendationSummary.textContent, /코디 결과 없음/);
  assert.equal(modal.elements.recommendationPreview.hidden, false, "이미지가 없는 상품도 위젯 미리보기에 표시한다");
  assert.match(modal.elements.recommendationPreview.innerHTML, /recommendation-preview-image recommendation-image--empty/);
  controller.update({ outfit: { kind: "empty", sets: [] }, similar: { kind: "empty", items: [] } });
  assert.equal(modal.elements.recommendationLauncher.hidden, true, "양쪽 모두 결과가 없으면 버튼 영역을 숨긴다");
  controller.update({ outfit: { kind: "error", sets: [] }, similar: { kind: "empty", items: [] } });
  assert.equal(modal.elements.recommendationLauncher.hidden, false, "오류 상태가 있으면 결과 없음과 구분해 표시한다");
  assert.match(modal.elements.recommendationSummary.textContent, /코디 불러오지 못했어요/);

  const style = fs.readFileSync(path.join(projectDir, "style.css"), "utf8");
  const widgetHtml = fs.readFileSync(path.join(projectDir, "widget.html.js"), "utf8");
  const launcherMarkup = widgetHtml.match(/<section class="recommendation-launcher"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(launcherMarkup, /<button class="recommendation-open-button"[^>]*>[\s\S]*?id="recommendationSummary"[\s\S]*?id="recommendationPreview"[\s\S]*?<\/button>/,
    "제목·요약·썸네일을 포함한 카드 전체가 키보드 접근 가능한 버튼이다");
  assert.match(style, /\.recommendation-open-button\s*\{[^}]*flex-direction:\s*column[^}]*width:\s*100%/s);
  assert.match(style, /\.recommendation-launcher-title\s*\{[^}]*font-size:\s*15\.5px/);
  assert.match(style, /\.recommendation-summary\s*\{[^}]*font-size:\s*13px/);
  assert.match(style, /\.recommendation-preview-cell\s*\{[^}]*width:\s*48px[^}]*height:\s*48px[^}]*border-radius:\s*8px/s);
  assert.match(style, /\.recommendation-open-button:focus-visible[^{}]*\{[^}]*outline:/s);
  assert.match(style, /\.recommendation-product-copy\s*\{[^}]*min-width:\s*0/s);
  assert.match(style, /\.recommendation-product-copy\s+b\s*\{[^}]*-webkit-line-clamp:\s*2/s);

  const noImage = makeRoot();
  recommendations.renderOutfits(noImage.elements.outfitRecommendationSection, noImage.elements.outfitRecommendationContent,
    noImage.elements.outfitRecommendationStatus, { kind: "snap", sets: [{ items: [product(103, "이미지 없는 상품")], reasons: [] }] });
  assert.match(noImage.elements.outfitRecommendationContent.innerHTML, /recommendation-image recommendation-image--empty/);
});

test("모달은 탭·Esc·배경 닫기, 포커스 복귀와 배경 스크롤 잠금을 지원한다", () => {
  const oldDocument = global.document;
  const oldMutationObserver = global.MutationObserver;
  let onMutation = null;
  let observerDisconnected = false;
  global.MutationObserver = class {
    constructor(callback) { onMutation = callback; }
    observe() {}
    disconnect() { observerDisconnected = true; }
  };
  const productGalleryImage = { id: "product-gallery-image", zIndex: 2147483000 };
  let fake = null;
  const doc = {
    body: { style: { overflow: "scroll" } },
    documentElement: {
      style: { overflow: "auto" },
      children: [],
      appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        child.isConnected = true;
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter((item) => item !== child);
        child.parentNode = null;
        child.isConnected = false;
        return child;
      },
    },
    elementFromPoint() {
      const overlayIsAboveGallery = fake?.modalHost.isConnected
        && fake.modalHost.style.position === "fixed"
        && Number(fake.modalHost.style.zIndex) > productGalleryImage.zIndex;
      return overlayIsAboveGallery ? fake.modalHost : productGalleryImage;
    },
  };
  global.document = doc;
  try {
    fake = makeRoot();
    const controller = recommendations.createRecommendationModalController(fake.root, fake.modalRoot);
    controller.update({ outfit: { kind: "snap", sets: [] }, similar: { kind: "items", items: [] } });
    assert.equal(fake.modalHost.isConnected, false, "모달을 열기 전에는 최상위 host를 연결하지 않는다");
    fake.elements.recommendationOpenButton.dispatch("click");
    assert.equal(fake.elements.recommendationModal.hidden, false);
    assert.equal(fake.elements.recommendationOpenButton.getAttribute("aria-expanded"), "true");
    assert.equal(fake.modalRoot.activeElement, fake.elements.recommendationCloseButton);
    assert.equal(fake.modalHost.parentNode, doc.documentElement, "모달 host를 documentElement 최상위에 연결한다");
    assert.equal(fake.modalHost.style.zIndex, "2147483647");
    assert.equal(doc.elementFromPoint(60, 60), fake.modalHost, "elementFromPoint 기준으로 모달 host가 상품 대표 이미지 위에 있다");
    assert.equal(doc.body.style.overflow, "hidden");
    assert.equal(doc.documentElement.style.overflow, "hidden");

    fake.elements.similarRecommendationTab.dispatch("click");
    assert.equal(fake.elements.similarRecommendationTab.getAttribute("aria-selected"), "true");
    assert.equal(fake.elements.outfitRecommendationSection.hidden, true);
    fake.elements.recommendationDialog.dispatch("keydown", { key: "Tab", shiftKey: true });
    assert.equal(fake.modalRoot.activeElement, fake.elements.similarRecommendationTab, "Shift+Tab은 모달 안에서 순환한다");
    fake.elements.recommendationDialog.dispatch("keydown", { key: "Escape" });
    assert.equal(fake.elements.recommendationModal.hidden, true);
    assert.equal(fake.modalHost.isConnected, false, "닫을 때 최상위 host를 분리한다");
    assert.equal(doc.elementFromPoint(60, 60), productGalleryImage, "모달을 닫으면 상품 이미지가 다시 최상위다");
    assert.equal(fake.elements.recommendationOpenButton.getAttribute("aria-expanded"), "false");
    assert.equal(fake.root.activeElement, fake.elements.recommendationOpenButton, "닫은 뒤 실행 버튼으로 포커스를 복귀한다");
    assert.equal(doc.body.style.overflow, "scroll");
    assert.equal(doc.documentElement.style.overflow, "auto");

    fake.elements.recommendationOpenButton.dispatch("click");
    fake.elements.recommendationCloseButton.dispatch("click");
    assert.equal(fake.elements.recommendationModal.hidden, true, "X 버튼으로 닫는다");

    fake.elements.recommendationOpenButton.dispatch("click");
    fake.elements.recommendationModalBackdrop.dispatch("click");
    assert.equal(fake.elements.recommendationModal.hidden, true, "배경 클릭으로 닫는다");

    fake.elements.recommendationOpenButton.dispatch("click");
    fake.root.host.isConnected = false;
    onMutation();
    assert.equal(fake.elements.recommendationModal.hidden, true, "SPA에서 host가 제거되면 열린 모달을 닫는다");
    assert.equal(doc.body.style.overflow, "scroll", "SPA 이동으로 닫혀도 스크롤 잠금을 해제한다");
    assert.equal(observerDisconnected, true);
  } finally {
    global.document = oldDocument;
    global.MutationObserver = oldMutationObserver;
  }
});

test("분리된 코디 진입 영역도 추천 상태를 갱신하고 결과 없음이면 호스트를 숨긴다", () => {
  const fake = makeRoot();
  const launcherHost = { hidden: true, style: { display: "none" }, isConnected: true };
  const launcherRoot = {
    host: launcherHost,
    getElementById: (id) => fake.root.getElementById(id),
  };
  const controller = recommendations.createRecommendationModalController(launcherRoot, fake.modalRoot, fake.root);

  controller.update({ outfit: { kind: "loading", sets: [] }, similar: { kind: "loading", items: [] } });
  assert.equal(launcherHost.hidden, false, "분리 호스트는 기존 로딩 상태와 함께 표시된다");
  assert.equal(launcherHost.style.display, "block");
  assert.equal(fake.elements.recommendationSummary.textContent, "불러오는 중…");

  controller.update({ outfit: { kind: "empty", sets: [] }, similar: { kind: "empty", items: [] } });
  assert.equal(fake.elements.recommendationLauncher.hidden, true);
  assert.equal(launcherHost.hidden, true, "양쪽 결과가 없으면 외부 호스트도 숨긴다");
  assert.equal(launcherHost.style.display, "none");
});

test("위젯 마크업은 인라인 아코디언을 쓰지 않고 Shadow DOM 모달 접근성 역할을 갖는다", () => {
  const markup = fs.readFileSync(path.join(projectDir, "widget.html.js"), "utf8");
  const style = fs.readFileSync(path.join(projectDir, "style.css"), "utf8");
  const content = fs.readFileSync(path.join(projectDir, "content.js"), "utf8");
  const recommendationsSource = fs.readFileSync(path.join(projectDir, "outfit-recommendations.js"), "utf8");
  assert.doesNotMatch(markup, /details class="acc recommendation-accordion"/);
  assert.match(markup, /코디 · 비슷한 상품 크게 보기/);
  assert.match(markup, /role="dialog" aria-modal="true"/);
  assert.match(markup, /role="tablist"/);
  assert.match(markup, /role="tab"/);
  assert.match(content, /modalShadow\.appendChild\(recommendationModal\)/);
  assert.match(content, /modalHost\.style\.position = "fixed"/);
  assert.match(content, /modalHost\.style\.zIndex = "2147483647"/);
  assert.match(content, /modalShadow\.appendChild\(modalStyleEl\)/);
  assert.match(content, /modalStyleEl\.textContent = css/);
  assert.match(recommendationsSource, /documentRef\?\.documentElement \|\| documentRef\?\.body/);
  assert.match(recommendationsSource, /const outfitSection = modalRoot\?\.getElementById\("outfitRecommendationSection"\)/);
  assert.doesNotMatch(content, /shadow\.appendChild\(recommendationModal\)/);
  assert.match(recommendationsSource, /target="_blank" rel="noopener noreferrer"/);
  assert.match(style, /\.recommendation-modal\s*\{[^}]*position:\s*fixed/s);
  assert.match(style, /\.recommendation-image--empty\s*\{[^}]*background:/s);
  assert.match(style, /\.recommendation-image--empty::after\s*\{[^}]*이미지 없음/s);
});

test("진입 영역은 확인된 구매 컨테이너 다음에 한 번만 삽입되고, 기준 미확인 시 위젯 내부로 폴백한다", () => {
  const content = fs.readFileSync(path.join(projectDir, "content.js"), "utf8");
  const style = fs.readFileSync(path.join(projectDir, "style.css"), "utf8");
  const verifiedContainer = content.match(/function findVerifiedPurchaseContainer\(purchaseAction\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(verifiedContainer, /closest\?\.\('\[class\*="Purchase__Container"\]'\)/, "해시가 바뀌는 클래스는 접두 매칭으로 찾는다");
  assert.match(verifiedContainer, /buttonText\.includes\("구매"\)/, "선택된 CTA의 구매 문구를 함께 확인한다");
  assert.match(content, /const purchaseContainer = findVerifiedPurchaseContainer\(purchaseAction\);\s*const anchor = purchaseContainer \|\| findInsertionAnchor\(purchaseAction\.button\);/);
  assert.match(content, /separateLauncher: Boolean\(purchaseContainer\)/, "기준 컨테이너가 없으면 진입 요소는 원래 위젯 Shadow DOM에 남는다");
  assert.match(content, /const RECOMMENDATION_LAUNCHER_HOST_ID = "musinsa-brand-size-recommendation-launcher-host"/);
  assert.match(content, /document\.getElementById\(RECOMMENDATION_LAUNCHER_HOST_ID\)/, "고정 ID 존재 여부를 확인해 중복을 정리한다");
  assert.match(content, /function removeCurrentWidgetHosts\(\) \{[\s\S]*?currentLauncherHost\?\.remove\(\);[\s\S]*?currentHost\?\.remove\(\);/);
  const widgetInsert = content.indexOf('anchor.insertAdjacentElement("afterend", host)');
  const launcherInsert = content.indexOf('if (launcherHost) anchor.insertAdjacentElement("afterend", launcherHost)');
  assert.ok(widgetInsert >= 0 && launcherInsert > widgetInsert, "위젯 삽입 뒤 기준 요소 바로 다음에 진입 호스트를 넣어 순서를 맞춘다");
  assert.match(content, /render\(shadow, goodsNo, state\.data, modalShadow, launcherShadow\)/, "기존 추천 렌더러가 별도 진입 Shadow DOM을 갱신한다");
  assert.match(style, /\.recommendation-launcher--external\s*\{[^}]*width:\s*100%[^}]*margin:\s*0/s);
});

test("요청은 동시 4개 상한과 7초 제한을 지키고 캐시를 재사용·정리한다", async () => {
  const oldChrome = global.chrome;
  const calls = [];
  let active = 0;
  let maxActive = 0;
  global.chrome = { runtime: { id: "smoke", sendMessage: async (message) => {
    calls.push(message);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { ok: true, body: { data: { list: [] } } };
  } } };
  try {
    recommendations.clearResourceCache();
    const current = { goodsNo: "3000000", name: "남성 아우터", gender: "men" };
    const candidates = Array.from({ length: 9 }, (_, index) => ({ goodsNo: String(3000100 + index), name: `남성 상품 ${index}`, rank: index, soldOut: false }));
    await recommendations.fetchSimilarSnapSets(current, candidates);
    assert.equal(calls.length, 4);
    assert.equal(maxActive, 4);
    assert.ok(calls.every((message) => message.timeoutMs === 7000));

    let loads = 0;
    const first = recommendations.fetchCachedResource("same", async () => { loads += 1; return "ok"; });
    const second = recommendations.fetchCachedResource("same", async () => { loads += 1; return "wrong"; });
    assert.equal(first, second);
    assert.equal(await first, "ok");
    assert.equal(loads, 1);

    recommendations.clearResourceCache();
    const pending = [];
    for (let i = 0; i < 81; i += 1) pending.push(recommendations.fetchCachedResource(`product:${i}`, async () => i));
    assert.equal(recommendations.resourceCacheSize(), 80);
    await Promise.all(pending);

    const originalNow = Date.now;
    let now = 1000;
    try {
      Date.now = () => now;
      recommendations.clearResourceCache();
      await recommendations.fetchCachedResource("old", async () => "expired later");
      now += 5 * 60 * 1000 + 1;
      await recommendations.fetchCachedResource("new", async () => "fresh");
      assert.equal(recommendations.resourceCacheSize(), 1, "새 요청 시 만료 캐시를 회수한다");
    } finally {
      Date.now = originalNow;
    }
  } finally {
    recommendations.clearResourceCache();
    global.chrome = oldChrome;
  }
});

test("SPA에서 상품이 바뀐 뒤 늦은 추천 응답은 이전 위젯 DOM을 덮어쓰지 않는다", async () => {
  const oldChrome = global.chrome;
  const oldDocument = global.document;
  const oldLocation = global.location;
  const pendingResponses = [];
  global.chrome = { runtime: { id: "smoke", sendMessage: (message) => new Promise((resolve) => pendingResponses.push({ message, resolve })) } };
  global.document = { title: "", querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  global.location = { href: "https://www.musinsa.com/products/4000001" };
  try {
    recommendations.clearResourceCache();
    const fake = makeRoot("4000001");
    const renderPromise = recommendations.render(fake.root, "4000001", { productName: "남성 코트" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    global.location.href = "https://www.musinsa.com/products/4000002";
    pendingResponses.forEach(({ resolve }) => resolve({ ok: true, body: { data: { list: [] } } }));
    await renderPromise;
    assert.equal(fake.elements.outfitRecommendationContent.innerHTML, "기존 코디");
    assert.equal(fake.elements.similarRecommendationContent.innerHTML, "기존 유사 상품");
  } finally {
    recommendations.clearResourceCache();
    global.chrome = oldChrome;
    global.document = oldDocument;
    global.location = oldLocation;
  }
});

test("이미지 없는 상품은 상세 API 썸네일로 보강하고 코디·비슷한 상품·진입 미리보기를 갱신한다", async () => {
  const oldChrome = global.chrome;
  const messages = [];
  global.chrome = {
    runtime: {
      id: "smoke",
      sendMessage: async (message) => {
        messages.push(message);
        return {
          ok: true,
          status: 200,
          body: { data: { thumbnailImageUrl: "/images/prd_img/20250827/5371284/detail_5371284_17768305654727_500.jpg" } },
        };
      },
    },
  };
  try {
    recommendations.clearProductImageCache();
    const outfitItem = { goodsNo: "5371284", name: "커브드 와이드 데님 - 중청", type: "bottom", image: "" };
    const similarItem = recommendations.normalizeProduct(product(5371284, "커브드 와이드 데님 - 중청"));
    const fake = makeRoot("3801654");
    const outfitResult = recommendations.renderOutfits(
      fake.elements.outfitRecommendationSection,
      fake.elements.outfitRecommendationContent,
      fake.elements.outfitRecommendationStatus,
      { kind: "snap", sets: [{ reasons: [], items: [outfitItem] }] }
    );
    const current = { goodsNo: "3801654", name: "남성 코트", gender: "men" };
    const similarResult = recommendations.renderSimilar(
      fake.elements.similarRecommendationSection,
      fake.elements.similarRecommendationContent,
      fake.elements.similarRecommendationStatus,
      current,
      [similarItem]
    );
    const controller = recommendations.createRecommendationModalController(fake.root, fake.modalRoot, fake.root);
    const state = { outfit: outfitResult, similar: similarResult };
    controller.update(state);
    assert.match(fake.elements.outfitRecommendationContent.innerHTML, /recommendation-image--empty/);
    assert.match(fake.elements.similarRecommendationContent.innerHTML, /recommendation-image--empty/);
    assert.match(fake.elements.recommendationPreview.innerHTML, /recommendation-image--empty/);

    const renderedSimilarItem = similarResult.items[0];
    const updated = await recommendations.enrichMissingProductImages([outfitItem, renderedSimilarItem]);
    assert.equal(updated, 2);
    assert.equal(messages.length, 1, "같은 goodsNo의 중복 항목은 API를 한 번만 호출한다");
    assert.equal(messages[0].url, "https://goods-detail.musinsa.com/api2/goods/5371284");
    assert.equal(messages[0].timeoutMs, 7000);
    const expected = "https://image.msscdn.net/images/prd_img/20250827/5371284/detail_5371284_17768305654727_500.jpg";
    assert.equal(outfitItem.image, expected);
    assert.equal(renderedSimilarItem.image, expected);

    recommendations.renderOutfits(
      fake.elements.outfitRecommendationSection,
      fake.elements.outfitRecommendationContent,
      fake.elements.outfitRecommendationStatus,
      outfitResult
    );
    recommendations.renderSimilarItems(fake.elements.similarRecommendationContent, similarResult.items);
    controller.update(state);
    assert.ok(fake.elements.outfitRecommendationContent.innerHTML.includes(expected));
    assert.ok(fake.elements.similarRecommendationContent.innerHTML.includes(expected));
    assert.ok(fake.elements.recommendationPreview.innerHTML.includes(expected));

    assert.equal(await recommendations.fetchProductThumbnailImage("5371284"), expected, "성공 URL은 goodsNo별 캐시에서 재사용한다");
    const existingImage = { goodsNo: "5371284", image: "https://image.msscdn.net/images/goods_img/20261001/5371284_1.jpg" };
    assert.equal(await recommendations.enrichMissingProductImages([existingImage]), 0, "이미 URL이 있는 이미지는 요청하지 않는다");
    assert.equal(messages.length, 1);
  } finally {
    recommendations.clearProductImageCache();
    global.chrome = oldChrome;
  }
});

test("상세 API 실패는 짧게 캐시하고 기존 이미지 플레이스홀더를 유지한다", async () => {
  const oldChrome = global.chrome;
  const originalNow = Date.now;
  let now = 1000;
  let calls = 0;
  Date.now = () => now;
  global.chrome = {
    runtime: {
      id: "smoke",
      sendMessage: async () => {
        calls += 1;
        return { ok: false, status: 503 };
      },
    },
  };
  try {
    recommendations.clearProductImageCache();
    const item = { goodsNo: "5371285", name: "이미지 없음 상품", type: "bottom", image: "" };
    const fake = makeRoot("3801654");
    const result = recommendations.renderOutfits(
      fake.elements.outfitRecommendationSection,
      fake.elements.outfitRecommendationContent,
      fake.elements.outfitRecommendationStatus,
      { kind: "snap", sets: [{ reasons: [], items: [item] }] }
    );
    assert.match(fake.elements.outfitRecommendationContent.innerHTML, /recommendation-image--empty/);
    assert.equal(await recommendations.enrichMissingProductImages([item]), 0);
    assert.equal(item.image, "");
    assert.equal(calls, 1);
    assert.equal(await recommendations.fetchProductThumbnailImage("5371285"), "");
    assert.equal(calls, 1, "실패 결과도 캐시 TTL 동안 재요청하지 않는다");
    assert.equal(recommendations.renderOutfits(
      fake.elements.outfitRecommendationSection,
      fake.elements.outfitRecommendationContent,
      fake.elements.outfitRecommendationStatus,
      result
    ).kind, "snap");
    assert.match(fake.elements.outfitRecommendationContent.innerHTML, /recommendation-image--empty/);

    now += 60 * 1000 + 1;
    await recommendations.fetchProductThumbnailImage("5371285");
    assert.equal(calls, 2, "실패 캐시는 1분 뒤 만료된다");
  } finally {
    recommendations.clearProductImageCache();
    Date.now = originalNow;
    global.chrome = oldChrome;
  }
});

test("이미지 URL 보강은 이미지 없는 상품 중 최대 8개만 병렬 조회한다", async () => {
  const oldChrome = global.chrome;
  const pending = [];
  let maxActive = 0;
  let active = 0;
  global.chrome = {
    runtime: {
      id: "smoke",
      sendMessage: (message) => new Promise((resolve) => {
        pending.push(() => {
          const goodsNo = message.url.match(/api2\/goods\/(\d+)$/)?.[1];
          active -= 1;
          resolve({ ok: true, status: 200, body: { data: { thumbnailImageUrl: `/images/prd_img/20250827/${goodsNo}/detail_${goodsNo}_500.jpg` } } });
        });
        active += 1;
        maxActive = Math.max(maxActive, active);
      }),
    },
  };
  try {
    recommendations.clearProductImageCache();
    const items = Array.from({ length: 10 }, (_, index) => ({ goodsNo: String(6000001 + index), image: "" }));
    const enriching = recommendations.enrichMissingProductImages(items);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 8);
    assert.equal(maxActive, 8, "최대 8개 API 요청을 병렬 처리한다");
    pending.forEach((resolve) => resolve());
    assert.equal(await enriching, 8);
    assert.equal(items.filter((item) => item.image).length, 8);
  } finally {
    recommendations.clearProductImageCache();
    global.chrome = oldChrome;
  }
});

test("사이즈 회귀: 상품 실측 매핑 우선, FREE 원문 보존, 미판매 대체 금지, 기준 변경 즉시 반영", () => {
  const source = fs.readFileSync(path.join(projectDir, "content.js"), "utf8");
  const instrumented = source.replace(/\}\)\(\);\s*$/, "globalThis.__sizeSmoke = { parseSizeLetter, deriveNumberedSizeMapFromChart, findAvailableSizeLabel };\n})();");
  assert.notEqual(instrumented, source, "테스트용 함수 노출 지점을 찾는다");
  const windowStub = { addEventListener() {}, removeEventListener() {} };
  const documentStub = { visibilityState: "visible", addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  const context = {
    window: windowStub,
    document: documentStub,
    location: { href: "https://www.musinsa.com/" },
    chrome: { runtime: { id: "smoke", sendMessage() {}, getURL: (value) => `chrome-extension://smoke/${value}` }, storage: { local: {} } },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, URL, console,
    performance: { now: () => 0 }, MutationObserver: class { observe() {} disconnect() {} },
  };
  vm.runInNewContext(instrumented, context, { filename: "content.js" });
  const size = context.__sizeSmoke;
  const measured = size.deriveNumberedSizeMapFromChart({
    headers: ["가슴단면(cm)"],
    rows: [{ size: "1", values: [54] }, { size: "2", values: [56.5] }, { size: "3", values: [59] }],
  });
  assert.equal(measured["2"], "M");
  assert.equal(size.parseSizeLetter("2", measured).letter, "M");
  assert.equal(size.parseSizeLetter("2", null).letter, "S");
  assert.equal(size.parseSizeLetter("2", null).approximate, true);
  for (const [label, expected] of [["1", "XS"], ["2", "S"], ["3", "M"], ["4", "L"]]) {
    const parsed = size.parseSizeLetter(label, null);
    assert.equal(parsed.letter, expected, `번호 ${label}은 기존 평균 매핑을 유지한다`);
    assert.equal(parsed.approximate, true);
  }
  assert.equal(size.findAvailableSizeLabel("M", ["1", "2", "3"], measured), "2", "상품 실측 매핑이 번호 옵션의 평균 매핑보다 우선한다");

  const namedAliases = [
    ["Small", "S"], ["Medium", "M"], ["Large", "L"],
    ["XSmall", "XS"], ["X-Small", "XS"], ["X Small", "XS"], ["Extra-Small", "XS"], ["Extra Small", "XS"],
    ["XLarge", "XL"], ["X-Large", "XL"], ["X Large", "XL"], ["Extra Large", "XL"],
    ["XXLarge", "XXL"], ["2XLarge", "XXL"], ["2X-Large", "XXL"],
    ["3XLarge", "XXXL"], ["3X-Large", "XXXL"], ["3X Large", "XXXL"], ["4XLarge", "XXXXL"],
  ];
  for (const [label, expected] of namedAliases) {
    assert.equal(size.parseSizeLetter(label)?.letter, expected, `${label}을 ${expected}로 해석한다`);
    assert.equal(size.findAvailableSizeLabel(expected, [label]), label, `${label} 원문을 판매 옵션으로 반환한다`);
  }
  const product1762727Sizes = ["MEDIUM", "LARGE", "XLARGE"];
  assert.deepEqual(
    ["M", "L", "XL"].map((calculated) => size.findAvailableSizeLabel(calculated, product1762727Sizes)),
    product1762727Sizes,
    "1762727 표준 계산 결과는 실제 영문 판매 옵션으로 연결한다"
  );
  assert.equal(size.parseSizeLetter("Largest"), null, "단어 일부는 사이즈 별칭으로 매핑하지 않는다");
  assert.equal(size.parseSizeLetter("Smallest"), null, "단어 일부는 사이즈 별칭으로 매핑하지 않는다");
  assert.equal(size.parseSizeLetter("Constructor"), null, "객체 상속 키를 사이즈 별칭으로 취급하지 않는다");
  assert.equal(size.parseSizeLetter("FREE"), null);
  assert.equal(size.parseSizeLetter("F"), null);
  assert.equal(size.parseSizeLetter("ONE SIZE"), null);
  assert.equal(size.parseSizeLetter("ONE-SIZE"), null);
  assert.equal(size.findAvailableSizeLabel("M", ["F", "FREE"]), null);
  assert.equal(size.findAvailableSizeLabel("M", ["ONE SIZE"]), null);
  assert.equal(size.findAvailableSizeLabel("L", ["S", "M"]), null);
  assert.equal(size.findAvailableSizeLabel("M", ["S", "M"]), "M");
  assert.ok(source.includes("availableSizesForDisplay.length === 1") && source.includes("escapeHtml(onlySize)"), "F/FREE는 실제 판매 표기로 보여준다");
  assert.ok(source.includes("판매 사이즈: ${availableSizesForDisplay.map(escapeHtml).join(\" · \")}"), "미판매 계산 결과와 실제 판매 목록을 함께 보여준다");
  assert.match(source, /state\.selectedBasisId\s*=\s*["']usual["']/);
  assert.match(source, /void window\.MusinsaOutfitRecommendations\.render/, "코디 요청이 사이즈 추천 렌더를 기다리게 하지 않는다");
});

test("상품 이동 시 이전 위젯은 CTA·카테고리 대기 전에 제거한다", () => {
  const source = fs.readFileSync(path.join(projectDir, "content.js"), "utf8");
  const changeGuard = source.indexOf("if (goodsNo !== currentGoodsNo)");
  const categoryWait = source.indexOf("waitForCategoryDecision(goodsNo, 6000)");
  assert.ok(changeGuard >= 0 && changeGuard < categoryWait);
  assert.match(source.slice(changeGuard, categoryWait), /removeCurrentWidgetHosts\(\)/);
});

test("백그라운드 요청 타임아웃은 fetch를 중단하고 실패 응답을 돌려준다", async () => {
  const source = fs.readFileSync(path.join(projectDir, "background.js"), "utf8");
  const listeners = [];
  let aborted = false;
  const context = {
    chrome: { runtime: { onMessage: { addListener(listener) { listeners.push(listener); } } } },
    URL, AbortController, setTimeout, clearTimeout, Number, Math, encodeURIComponent,
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    }),
  };
  vm.runInNewContext(source, context, { filename: "background.js" });
  const onFetch = listeners.find((listener) => {
    // 두 번째 등록된 서비스 메시지 리스너가 허용 리소스 프록시다.
    return listener.toString().includes("FETCH_MUSINSA_RESOURCE");
  });
  assert.ok(onFetch);
  const response = await new Promise((resolve) => {
    assert.equal(onFetch({ type: "FETCH_MUSINSA_RESOURCE", url: "https://content.musinsa.com/test", timeoutMs: 1000 }, {}, resolve), true);
  });
  assert.equal(response.ok, false);
  assert.equal(response.status, 0);
  assert.equal(aborted, true);
});

test("타임아웃 응답은 코디·비슷한 상품 각각에 실패 상태로 보인다", async () => {
  const oldChrome = global.chrome;
  const oldDocument = global.document;
  const oldLocation = global.location;
  global.chrome = { runtime: { id: "smoke", sendMessage: async () => ({ ok: false, status: 0, error: "timeout" }) } };
  global.document = { title: "", querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  global.location = { href: "https://www.musinsa.com/products/5000001" };
  try {
    recommendations.clearResourceCache();
    const fake = makeRoot("5000001");
    await recommendations.render(fake.root, "5000001", { productName: "남성 코트" });
    assert.equal(fake.elements.outfitRecommendationStatus.textContent, "불러오지 못했어요");
    assert.match(fake.elements.outfitRecommendationContent.innerHTML, /코디를 불러오지 못했어요/);
    assert.equal(fake.elements.similarRecommendationStatus.textContent, "불러오지 못했어요");
    assert.match(fake.elements.similarRecommendationContent.innerHTML, /비슷한 상품을 불러오지 못했어요/);
    assert.equal(fake.elements.recommendationLauncher.hidden, false);
    assert.match(fake.elements.recommendationSummary.textContent, /불러오지 못했어요/);
  } finally {
    recommendations.clearResourceCache();
    global.chrome = oldChrome;
    global.document = oldDocument;
    global.location = oldLocation;
  }
});

(async () => {
  let failures = 0;
  for (const { name, run } of smokeCases) {
    try {
      await run();
      process.stdout.write(`통과: ${name}\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(`실패: ${name}\n${error.stack || error}\n`);
    }
  }
  process.stdout.write(`스모크 결과: ${smokeCases.length - failures}/${smokeCases.length} 통과\n`);
  if (failures) process.exitCode = 1;
})();
