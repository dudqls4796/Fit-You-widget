// =============================================================================
// popup.js — 확장 아이콘 클릭 시 뜨는 팝업("최근 본 상품") 스크립트
// -----------------------------------------------------------------------------
// content.js가 상품 페이지를 볼 때마다 chrome.storage.local에 저장해 둔
// 최근 본 상품 목록을 읽어 이미지+상품명 버튼 리스트로 보여준다.
// 버튼을 누르면 해당 무신사 상품 페이지를 새 탭으로 연다.
// =============================================================================
"use strict";

// 최근 본 상품 목록이 저장된 storage 키(content.js와 같은 키를 써야 한다)
const RECENT_PRODUCTS_KEY = "sizeWidget:recentProducts";

// 상품 이미지가 없거나 로딩에 실패했을 때 회색 placeholder 스타일로 바꾼다.
function setImagePlaceholder(image) {
  image.removeAttribute("src");
  image.classList.add("placeholder");
}

/**
 * storage에서 최근 본 상품을 최대 20개 읽어 목록(<ul id="recentProducts">)을 그린다.
 * 목록이 비었거나 읽기에 실패하면 빈 상태 문구(#emptyState)를 보여준다.
 */
async function loadRecentProducts() {
  const list = document.getElementById("recentProducts");
  const empty = document.getElementById("emptyState");
  try {
    const stored = await chrome.storage.local.get(RECENT_PRODUCTS_KEY);
    // 저장값이 배열이 아닐 수 있으므로 방어하고, 최대 20개까지만 표시
    const items = Array.isArray(stored[RECENT_PRODUCTS_KEY]) ? stored[RECENT_PRODUCTS_KEY].slice(0, 20) : [];
    empty.hidden = items.length > 0;
    items.forEach((item) => {
      // 항목 하나 = <li><button><img><span>상품명</span></button></li>
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "product-button";

      // 상품 썸네일: 지연 로딩, 실패 시 placeholder로 교체(한 번만)
      const image = document.createElement("img");
      image.className = "product-image";
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener("error", () => setImagePlaceholder(image), { once: true });
      if (item.imageUrl) image.src = item.imageUrl;
      else setImagePlaceholder(image);

      // 상품명: 이름이 없으면 "상품 {번호}"로 대체. textContent 사용으로 HTML 주입 방지
      const name = document.createElement("span");
      name.className = "product-name";
      name.textContent = item.name || `상품 ${item.goodsNo || ""}`;
      button.append(image, name);

      // 클릭 시 상품 페이지를 새 탭으로 연다.
      // 저장된 URL이 https://www.musinsa.com/products/{숫자} 로 시작할 때만 연다(그 뒤 경로·쿼리는 검사하지 않음).
      button.addEventListener("click", () => {
        const url = item.url || `https://www.musinsa.com/products/${encodeURIComponent(item.goodsNo || "")}`;
        if (/^https:\/\/www\.musinsa\.com\/products\/\d+/.test(url)) {
          chrome.tabs.create({ url });
        }
      });
      li.appendChild(button);
      list.appendChild(li);
    });
  } catch (error) {
    // storage 접근 실패 시에도 빈 상태 문구로 안전하게 표시
    empty.hidden = false;
    empty.textContent = "아직 본 상품이 없어요";
  }
}

// 팝업이 열리면 바로 목록을 그린다.
void loadRecentProducts();
