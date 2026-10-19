// 무신사 상품 상세 API에서 코디 스냅과 비슷한 상품을 읽고 위젯 안에 그린다.
// 직접 태그된 스냅이 부족하면 비슷한 상품이 태그된 스냅에서 코디를 보충한다.
(function (global) {
  "use strict";

  const REQUEST_TIMEOUT_MS = 7000;
  const MAX_SIMILAR_SNAP_PRODUCTS = 4;
  const RESOURCE_CACHE_TTL_MS = 5 * 60 * 1000;
  const RESOURCE_CACHE_MAX_ENTRIES = 80;
  const MAX_MISSING_IMAGE_LOOKUPS = 8;
  const PRODUCT_IMAGE_CACHE_TTL_MS = 30 * 60 * 1000;
  const PRODUCT_IMAGE_FAILURE_CACHE_TTL_MS = 60 * 1000;
  const PRODUCT_IMAGE_CACHE_MAX_ENTRIES = 256;
  const PRODUCT_PATH = /^\/products\/(\d+)(?:[/?#]|$)/;
  const NEUTRAL_COLORS = new Set(["black", "white", "gray", "beige"]);
  const OUTFIT_TYPES = ["top", "bottom", "shoes", "accessory"];
  const OUTFIT_LABELS = { top: "상의", bottom: "하의", shoes: "신발", accessory: "액세서리" };
  const resourceCache = new Map();
  const productImageCache = new Map();

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => {
      const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
      return entities[char];
    });
  }

  function asText(value) {
    if (typeof value === "string" || typeof value === "number") return String(value).trim();
    if (value && typeof value === "object") return String(value.name || value.label || value.value || "").trim();
    return "";
  }

  function walkObjects(value, visit, depth = 0, seen = new Set()) {
    if (!value || typeof value !== "object" || depth > 10 || seen.has(value)) return;
    seen.add(value);
    visit(value);
    if (Array.isArray(value)) {
      value.forEach((child) => walkObjects(child, visit, depth + 1, seen));
    } else {
      Object.values(value).forEach((child) => walkObjects(child, visit, depth + 1, seen));
    }
  }

  function getProductNo(item) {
    const value = item?.goodsNo ?? item?.goodsNumber ?? item?.productNo ?? item?.productId;
    return /^\d+$/.test(String(value ?? "")) ? String(value) : "";
  }

  function getProductName(item) {
    return asText(item?.goodsName || item?.productName || item?.name || item?.title || item?.goodsNm);
  }

  function getProductCategory(item) {
    return asText(item?.categoryName || item?.categoryTitle || item?.category || item?.categoryDepth2Name || item?.category1Name);
  }

  function getProductPrice(item) {
    for (const value of [item?.finalPrice, item?.couponPrice, item?.price, item?.salePrice, item?.normalPrice]) {
      const parsed = Number(String(value ?? "").replace(/[^\d.]/g, ""));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  function getProductBrand(item) {
    return asText(item?.brandName || item?.brand || item?.brandEnglishName);
  }

  function findImageValue(value, depth = 0, seen = new Set()) {
    if (depth > 4 || value == null) return "";
    if (typeof value === "string") {
      const text = value.trim();
      if (text.startsWith("/images/")) return text;
      try {
        const url = new URL(text.startsWith("//") ? `https:${text}` : text);
        return url.protocol === "https:" && (url.hostname === "image.msscdn.net" || url.hostname.endsWith(".msscdn.net")) ? text : "";
      } catch (_) {
        return "";
      }
    }
    if (typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    const imageKeys = ["thumbnailImageUrl", "imageUrl", "thumbnailUrl", "goodsImageUrl", "goodsImage", "goodsImg", "thumbnail", "image", "img", "src", "url", "path"];
    for (const key of imageKeys) {
      if (value[key] == null) continue;
      const found = findImageValue(value[key], depth + 1, seen);
      if (found) return found;
    }
    for (const child of Object.values(value)) {
      const found = findImageValue(child, depth + 1, seen);
      if (found) return found;
    }
    return "";
  }

  // 상품 이미지 경로는 상품 번호 외에 등록 날짜·파일 식별자를 포함하므로 번호만으로 추측하지 않고 응답 URL을 사용한다.
  function getProductImage(item, sourceKind = "similar") {
    const goodsNo = getProductNo(item);
    // 스냅의 thumbnailUrl은 태그 상품 이미지가 아니라 모델 착용컷일 수 있다.
    // 상품 전용 필드를 먼저 읽고, 스냅의 일반 이미지 URL은 goodsNo와 연결될 때만 사용한다.
    const productImageKeys = ["goodsImageUrl", "goodsImgUrl", "goodsImage", "goodsImg", "goodsImagePath", "goodsImgPath"];
    const genericImageKeys = ["imageUrl", "thumbnailUrl", "thumbnail", "image", "img"];
    const readFirstImage = (keys) => {
      for (const key of keys) {
        if (item?.[key] == null) continue;
        const found = findImageValue(item[key]);
        if (found) return found;
      }
      return "";
    };
    let raw = readFirstImage(productImageKeys);
    if (!raw) {
      const generic = readFirstImage(genericImageKeys);
      if (generic && (sourceKind !== "snap" || isCatalogImageForProduct(generic, goodsNo))) raw = generic;
    }
    if (!raw) return "";
    return normalizeProductImageUrl(raw, goodsNo);
  }

  function normalizeProductImageUrl(raw, goodsNo) {
    if (!raw) return "";
    try {
      const normalized = raw.startsWith("//")
        ? `https:${raw}`
        : raw.startsWith("/")
          ? `https://image.msscdn.net${raw}`
          : raw;
      const url = new URL(normalized);
      if (url.protocol !== "https:" || !(url.hostname === "image.msscdn.net" || url.hostname.endsWith(".msscdn.net"))) return "";
      return imageUrlMatchesProduct(url.href, goodsNo) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function getThumbnailImageFromProductDetail(payload, goodsNo) {
    let raw = "";
    walkObjects(payload, (node) => {
      if (raw || node.thumbnailImageUrl == null) return;
      raw = findImageValue(node.thumbnailImageUrl);
    });
    return normalizeProductImageUrl(raw, goodsNo);
  }

  function fetchProductThumbnailImage(goodsNo) {
    const safeGoodsNo = String(goodsNo ?? "").trim();
    if (!/^\d+$/.test(safeGoodsNo)) return Promise.resolve("");

    const cached = productImageCache.get(safeGoodsNo);
    if (cached && cached.expiresAt > Date.now()) {
      productImageCache.delete(safeGoodsNo);
      productImageCache.set(safeGoodsNo, cached);
      return cached.promise;
    }
    if (cached) productImageCache.delete(safeGoodsNo);

    const now = Date.now();
    for (const [key, entry] of productImageCache) {
      if (entry.expiresAt <= now) productImageCache.delete(key);
    }
    while (productImageCache.size >= PRODUCT_IMAGE_CACHE_MAX_ENTRIES) {
      productImageCache.delete(productImageCache.keys().next().value);
    }

    const entry = { expiresAt: Date.now() + PRODUCT_IMAGE_FAILURE_CACHE_TTL_MS, promise: null };
    entry.promise = Promise.resolve().then(async () => {
      try {
        const url = `https://goods-detail.musinsa.com/api2/goods/${encodeURIComponent(safeGoodsNo)}`;
        const payload = await fetchMusinsaJson(url);
        const imageUrl = getThumbnailImageFromProductDetail(payload, safeGoodsNo);
        entry.expiresAt = Date.now() + (imageUrl ? PRODUCT_IMAGE_CACHE_TTL_MS : PRODUCT_IMAGE_FAILURE_CACHE_TTL_MS);
        return imageUrl;
      } catch (_) {
        entry.expiresAt = Date.now() + PRODUCT_IMAGE_FAILURE_CACHE_TTL_MS;
        return "";
      }
    });
    productImageCache.set(safeGoodsNo, entry);
    return entry.promise;
  }

  async function enrichMissingProductImages(items) {
    const productItems = (Array.isArray(items) ? items : []).filter((item) => item && typeof item === "object");
    const knownImages = new Map();
    productItems.forEach((item) => {
      const goodsNo = getProductNo(item);
      if (goodsNo && item.image && !knownImages.has(goodsNo)) knownImages.set(goodsNo, item.image);
    });

    const missingByGoodsNo = new Map();
    productItems.forEach((item) => {
      const goodsNo = getProductNo(item);
      if (!goodsNo || item.image) return;
      if (knownImages.has(goodsNo)) {
        item.image = knownImages.get(goodsNo);
        return;
      }
      if (!missingByGoodsNo.has(goodsNo)) missingByGoodsNo.set(goodsNo, []);
      missingByGoodsNo.get(goodsNo).push(item);
    });

    const candidates = [...missingByGoodsNo.entries()].slice(0, MAX_MISSING_IMAGE_LOOKUPS);
    const results = await Promise.all(candidates.map(async ([goodsNo, targets]) => {
      const imageUrl = await fetchProductThumbnailImage(goodsNo);
      if (!imageUrl) return 0;
      targets.forEach((item) => {
        if (!item.image) item.image = imageUrl;
      });
      return targets.length;
    }));
    return results.reduce((sum, count) => sum + count, 0);
  }

  function isCatalogImageForProduct(rawUrl, goodsNo) {
    if (!imageUrlMatchesProduct(rawUrl, goodsNo, true)) return false;
    try {
      const value = String(rawUrl || "");
      const url = new URL(value.startsWith("//") ? `https:${value}` : value.startsWith("/") ? `https://image.msscdn.net${value}` : value);
      return /\/goods_img\//i.test(decodeURIComponent(url.pathname));
    } catch (_) {
      return false;
    }
  }

  function imageUrlMatchesProduct(rawUrl, goodsNo, requireIdentity = false) {
    if (!goodsNo) return true;
    try {
      const value = String(rawUrl || "");
      const url = new URL(value.startsWith("//") ? `https:${value}` : value.startsWith("/") ? `https://image.msscdn.net${value}` : value);
      const path = decodeURIComponent(url.pathname);
      if (new RegExp(`(?:^|\\D)${String(goodsNo)}(?:\\D|$)`).test(path)) return true;
      const ids = [...path.matchAll(/(?:^|\/)(\d{6,})(?=[_./-]|$)/g)]
        .map((match) => match[1])
        .filter((id) => !/^20\d{6}$/.test(id)); // YYYYMMDD 등록 날짜 디렉터리는 제외한다.
      if (ids.some((id) => id.length === String(goodsNo).length)) return false;
      return !requireIdentity;
    } catch (_) {
      return false;
    }
  }

  function getProductUrl(item) {
    const goodsNo = getProductNo(item);
    const raw = asText(item?.linkUrl || item?.productUrl || item?.url);
    if (raw) {
      try {
        const url = new URL(raw, "https://www.musinsa.com");
        const match = url.pathname.match(PRODUCT_PATH);
        if (url.protocol === "https:" && url.hostname === "www.musinsa.com" && match) {
          if (match[1] === goodsNo) return `https://www.musinsa.com/products/${goodsNo}`;
        }
      } catch (_) {
        // 상품 번호가 있으면 아래의 표준 무신사 상품 링크를 사용한다.
      }
    }
    return goodsNo ? `https://www.musinsa.com/products/${goodsNo}` : "";
  }

  function isExplicitlyUnavailable(item) {
    const unavailableText = /품절|판매\s*중지|판매\s*중단|판매\s*정지|판매\s*종료|판매종료|미판매|sold[ _-]?out|out[ _-]?of[ _-]?stock|discontinued|sale[ _-]?stop|not[ _-]?for[ _-]?sale|^stop$/i;
    const falseLike = (value) => value === false || value === 0 || /^(?:n|no|false|0)$/i.test(String(value ?? "").trim());
    if ([item?.isDisplay, item?.displayYn, item?.available, item?.isAvailable]
      .some(falseLike)) return true;
    if ([item?.isSoldOut, item?.soldOut].some((value) => /^(?:y|yes|true|1)$/i.test(String(value ?? "").trim()))) return true;
    if ([item?.goodsStatus, item?.saleStatus, item?.displayStatus, item?.status, item?.statusName]
      .some((value) => unavailableText.test(asText(value)))) return true;
    const stock = item?.stockQty ?? item?.stockCount ?? item?.totalStock;
    return stock != null && stock !== "" && Number.isFinite(Number(stock)) && Number(stock) <= 0;
  }

  function classifyGender(value) {
    const text = String(value || "").toLowerCase();
    if (/유니섹스|공용|unisex|男女共用/.test(text)) return "unisex";
    if (/여성|우먼|레이디|women|woman|female|ladies|womens/.test(text)) return "women";
    if (/남성|맨즈|men|man|male|mens/.test(text)) return "men";
    return "";
  }

  function classifySeason(value) {
    const text = String(value || "").toLowerCase();
    const warm = /봄|여름|spring|summer|(?:^|\b)(?:ss|s\/s)(?:\b|\d)|\d{2,4}\s*ss\b/.test(text);
    const cold = /가을|겨울|autumn|fall|winter|(?:^|\b)(?:fw|f\/w)(?:\b|\d)|\d{2,4}\s*fw\b/.test(text);
    if (warm === cold) return "";
    return warm ? "warm" : "cold";
  }

  function productGender(item) {
    const explicit = classifyGender([
      item?.gender, item?.genderName, item?.genderType, item?.genderCode, item?.sex, item?.sexName, item?.sexCode,
    ].map(asText).join(" "));
    if (explicit) return explicit;
    const code = String(item?.genderCode ?? item?.sexCode ?? "").trim().toUpperCase();
    if (code === "M") return "men";
    if (code === "F") return "women";
    return classifyGender([item?.category, getProductName(item)].map(asText).join(" "));
  }

  function productSeason(item) {
    return classifySeason([
      item?.season, item?.seasonName, item?.seasonCode, item?.seasonType,
      item?.category, getProductName(item),
    ].map(asText).join(" "));
  }

  function normalizeProduct(item, rank = 0, sourceKind = "similar") {
    const goodsNo = getProductNo(item);
    const name = getProductName(item);
    if (!goodsNo || !name) return null;
    return {
      goodsNo,
      name,
      brand: getProductBrand(item),
      category: getProductCategory(item),
      categoryCode: asText(item?.categoryCode || item?.categoryDepth2Code || item?.categoryId),
      color: asText(item?.colorName || item?.colorText || item?.color),
      fit: asText(item?.fitName || item?.fitText || item?.fit),
      price: getProductPrice(item),
      image: getProductImage(item, sourceKind),
      url: getProductUrl(item),
      gender: productGender(item),
      season: productSeason(item),
      soldOut: isExplicitlyUnavailable(item),
      rank,
    };
  }

  function collectSimilarCandidates(payload) {
    const candidates = [];
    const seen = new Set();
    const root = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    walkObjects(root, (node) => {
      if (!Array.isArray(node.recommendedGoodsList)) return;
      node.recommendedGoodsList.forEach((raw, index) => {
        const item = normalizeProduct(raw, index, "similar");
        if (!item || seen.has(item.goodsNo)) return;
        seen.add(item.goodsNo);
        candidates.push(item);
      });
    });
    return candidates;
  }

  function findColor(value) {
    const text = String(value || "").toLowerCase();
    const colors = [
      ["black", /블랙|검정|black|blk/],
      ["white", /화이트|흰색|아이보리|크림|white|ivory|cream/],
      ["gray", /그레이|회색|차콜|gray|grey|charcoal/],
      ["beige", /베이지|카키베이지|beige|tan/],
      ["navy", /네이비|남색|navy/],
      ["blue", /블루|파랑|청색|데님|blue|denim/],
      ["green", /그린|카키|올리브|green|khaki|olive/],
      ["brown", /브라운|갈색|카멜|brown|camel/],
      ["red", /레드|빨강|버건디|와인|red|burgundy/],
      ["pink", /핑크|분홍|pink/],
      ["yellow", /옐로|노랑|머스타드|yellow|mustard/],
      ["purple", /퍼플|보라|purple/],
    ];
    return colors.find(([, pattern]) => pattern.test(text))?.[0] || "";
  }

  function findFit(value) {
    const text = String(value || "").toLowerCase();
    if (/세미\s*오버|semi.?over/.test(text)) return "semi-over";
    if (/오버핏|oversized|oversize|loose fit/.test(text)) return "over";
    if (/슬림핏|슬림|slim fit|slim-fit/.test(text)) return "slim";
    if (/레귤러핏|스탠다드핏|정핏|regular fit|standard fit/.test(text)) return "regular";
    return "";
  }

  function getColorHarmonyScore(first, second) {
    if (!first || !second) return 0;
    if (first === second) return 2;
    if (NEUTRAL_COLORS.has(first) || NEUTRAL_COLORS.has(second)) return 1;
    if (["black", "navy", "gray"].includes(first) && ["black", "navy", "gray"].includes(second)) return 1;
    if (["beige", "brown", "green"].includes(first) && ["beige", "brown", "green"].includes(second)) return 1;
    return 0;
  }

  function classifyOuterCategory(value) {
    const text = String(value || "").toLowerCase();
    const rules = [
      ["padding", /패딩|다운|puffer|down jacket/],
      ["coat", /코트|발마칸|트렌치|coat|trench/],
      ["shearling", /무스탕|퍼 점퍼|shearling|mouton/],
      ["leather", /레더|가죽|leather/],
      ["denim-jacket", /데님자켓|청자켓|denim jacket/],
      ["blouson", /블루종|ma-1|bomber|blouson/],
      ["windbreaker", /바람막이|윈드브레이커|windbreaker/],
      ["fleece", /플리스|후리스|fleece/],
      ["cardigan", /가디건|cardigan/],
      ["parka", /파카|parka/],
      ["vest", /베스트|조끼|vest/],
      ["track-jacket", /트랙탑|트랙자켓|track.?top|track.?jacket/],
      ["jacket", /아우터|자켓|재킷|블레이저|jacket|blazer/],
    ];
    return rules.find(([, pattern]) => pattern.test(text))?.[0] || "";
  }

  function scoreSimilarProducts(current, candidates) {
    const currentName = current?.name || "";
    const currentCategory = current?.category || "";
    const currentCategoryCode = current?.categoryCode || "";
    const currentBrand = String(current?.brand || "").toLowerCase().replace(/\s+/g, "");
    const currentColor = findColor(current?.color || currentName);
    const currentFit = findFit(current?.fit || currentName);
    const currentPrice = Number(current?.price) || null;

    return (candidates || [])
      .filter((item) => item && !item.soldOut && item.goodsNo !== String(current?.goodsNo || ""))
      .filter((item) => !incompatibleGender(current, item))
      .map((item) => {
        let score = Math.max(0, 2 - item.rank * 0.25);
        const reasons = ["무신사 유사 상품 후보"];
        const categoryCode = item.categoryCode;
        const category = item.category || item.name;
        const currentType = classifyOuterCategory(`${currentCategory} ${currentName}`);
        const candidateType = classifyOuterCategory(`${category} ${item.name}`);
        if (currentCategoryCode && categoryCode && currentCategoryCode === categoryCode) {
          score += 3;
          reasons.push("같은 세부 카테고리");
        } else if (currentType && candidateType && currentType === candidateType) {
          score += 3;
          reasons.push("같은 아우터 종류");
        }

        const candidateFit = findFit(`${item.fit} ${item.name}`);
        if (currentFit && candidateFit && currentFit === candidateFit) {
          score += 2;
          reasons.push("비슷한 핏");
        }

        const candidateColor = findColor(`${item.color} ${item.name}`);
        const colorScore = getColorHarmonyScore(currentColor, candidateColor);
        if (colorScore === 2) {
          score += colorScore;
          reasons.push("같은 색상 계열");
        } else if (colorScore === 1) {
          score += colorScore;
          reasons.push("톤이 조화로운 색상");
        }

        const candidatePrice = Number(item.price) || null;
        if (currentPrice && candidatePrice) {
          const ratio = Math.abs(candidatePrice - currentPrice) / currentPrice;
          if (ratio <= 0.25) {
            score += 2;
            reasons.push("가격대가 가까움");
          } else if (ratio <= 0.5) {
            score += 1;
            reasons.push("가격대가 비슷함");
          }
        }

        const candidateBrand = String(item.brand || "").toLowerCase().replace(/\s+/g, "");
        if (currentBrand && candidateBrand && currentBrand === candidateBrand) {
          score += 1;
          reasons.push("같은 브랜드");
        }
        return { ...item, score, reasons };
      })
      .sort((a, b) => b.score - a.score || a.rank - b.rank)
      .slice(0, 4);
  }

  function classifyOutfitType(item) {
    const text = `${item.category || ""} ${item.name || ""}`.toLowerCase();
    if (/아우터|외투|패딩|코트|트렌치|자켓|재킷|블레이저|블루종|점퍼|집업|바람막이|파카|가디건|무스탕|베스트|coat|jacket|jumper|zip.?up|bomber|puffer|outerwear|blazer/.test(text)) return "";
    if (/신발|슈즈|스니커즈|운동화|구두|부츠|샌들|슬리퍼|로퍼|뮬|sneaker|shoes|boots|loafers|sandal|clogs|flats/.test(text)) return "shoes";
    if (/바지|팬츠|데님|슬랙스|스커트|쇼츠|레깅스|pants|jeans|skirt|shorts/.test(text)) return "bottom";
    if (/가방|백팩|모자|캡|벨트|지갑|안경|선글라스|양말|머플러|장갑|bag|backpack|cap|hat|belt|wallet|glasses|socks|scarf/.test(text)) return "accessory";
    if (/상의|티셔츠|셔츠|니트|스웨트|후드|맨투맨|블라우스|탑|민소매|슬리브리스|나시|반팔|긴팔|top|shirt|knit|sweatshirt|hoodie|blouse|sleeveless|tank top/.test(text)) return "top";
    return "";
  }

  function collectSnapProducts(snap) {
    const roots = [snap?.goods, snap?.goodsList, snap?.taggedGoods, snap?.products].filter(Boolean);
    const found = [];
    const seenObjects = new Set();
    roots.forEach((root) => walkObjects(root, (node) => {
      const product = normalizeProduct(node, 0, "snap");
      if (product && !seenObjects.has(product.goodsNo)) {
        seenObjects.add(product.goodsNo);
        found.push(product);
      }
    }));
    if (found.length) return found;
    walkObjects(snap, (node) => {
      const product = normalizeProduct(node, 0, "snap");
      if (product && !seenObjects.has(product.goodsNo)) {
        seenObjects.add(product.goodsNo);
        found.push(product);
      }
    });
    return found;
  }

  function incompatibleGender(current, item) {
    const currentGender = current?.gender || productGender(current || {});
    const itemGender = item?.gender || productGender(item || {});
    return !!currentGender && currentGender !== "unisex" && !!itemGender && itemGender !== "unisex" && currentGender !== itemGender;
  }

  function incompatibleProducts(current, items) {
    const genders = new Set([current?.gender || productGender(current || {}), ...items.map((item) => item.gender || productGender(item))]
      .filter((gender) => gender && gender !== "unisex"));
    if (genders.size > 1) return true;
    const seasons = new Set([current?.season || productSeason(current || {}), ...items.map((item) => item.season || productSeason(item))]
      .filter(Boolean));
    return seasons.size > 1;
  }

  function scoreOutfitSet(current, items, sourceKind = "direct") {
    let score = 2;
    const reasons = [sourceKind === "similar" ? "비슷한 상품에 태그된 스타일링 스냅" : "같은 스타일링 스냅"];
    score += items.length;
    const types = new Set(items.map((item) => item.type));
    // 가능하면 신발을 포함한 구성이 먼저 선택되도록 한다.
    if (types.has("shoes")) score += 2;
    if (types.has("top") && types.has("bottom") && types.has("shoes")) reasons.push("상의·하의·신발 조합");
    else reasons.push("카테고리 조합");

    const currentColor = findColor(`${current?.color || ""} ${current?.name || ""}`);
    const compatibleColors = items.filter((item) => getColorHarmonyScore(currentColor, findColor(`${item.color} ${item.name}`)) > 0).length;
    if (compatibleColors > 0) {
      score += compatibleColors;
      reasons.push("색상 톤 조화");
    }

    const outerFit = findFit(`${current?.fit || ""} ${current?.name || ""}`);
    const top = items.find((item) => item.type === "top");
    const bottom = items.find((item) => item.type === "bottom");
    const topFit = findFit(`${top?.fit || ""} ${top?.name || ""}`);
    const bottomFit = findFit(`${bottom?.fit || ""} ${bottom?.name || ""}`);
    const fitBalanced =
      (outerFit === "over" && ["regular", "slim"].includes(bottomFit)) ||
      (outerFit === "slim" && ["regular", "over", "semi-over"].includes(topFit));
    if (fitBalanced) {
      score += 1;
      reasons.push("핏 균형");
    }
    return { score, reasons };
  }

  function makeOutfitSets(payload, currentProduct, excludedGoodsNo = "", sourceKind = "direct") {
    const currentGoodsNo = typeof currentProduct === "object" ? currentProduct?.goodsNo : currentProduct;
    const current = typeof currentProduct === "object" ? currentProduct : {};
    const excludedGoodsNos = new Set([String(currentGoodsNo || ""), String(excludedGoodsNo || "")].filter(Boolean));
    const root = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const snaps = Array.isArray(root?.list) ? root.list : Array.isArray(root?.data?.list) ? root.data.list : [];
    const sets = [];
    snaps.forEach((snap) => {
      const byType = new Map();
      collectSnapProducts(snap).forEach((product) => {
        if (!product.goodsNo || excludedGoodsNos.has(product.goodsNo) || product.soldOut) return;
        if (incompatibleGender(current, product)) return;
        const type = classifyOutfitType(product);
        if (type && !byType.has(type)) byType.set(type, { ...product, type });
      });
      const items = OUTFIT_TYPES.map((type) => byType.get(type)).filter(Boolean);
      if (items.length >= 2 && !incompatibleProducts(current, items)) {
        sets.push({
          id: String(snap.id || snap.snapId || sets.length),
          items,
          ...scoreOutfitSet(current, items, sourceKind),
        });
      }
    });
    return sets.sort((a, b) => b.score - a.score || b.items.length - a.items.length);
  }

  function getCoreItems(set) {
    return (set?.items || []).filter((item) => ["top", "bottom", "shoes"].includes(item.type));
  }

  function selectDiverseOutfitSets(sets, limit = 2) {
    const selected = [];
    const seenCoreCompositions = new Set();
    const ranked = [...(sets || [])].sort((a, b) =>
      b.score - a.score || (a.sourceKind === "direct" ? -1 : 0) - (b.sourceKind === "direct" ? -1 : 0)
    );

    ranked.forEach((set) => {
      if (selected.length >= limit) return;
      const coreItems = getCoreItems(set);
      if (!coreItems.length) return;
      const composition = coreItems
        .map((item) => `${item.type}:${item.goodsNo}`)
        .sort()
        .join("|");
      if (seenCoreCompositions.has(composition)) return;
      const coreGoodsNos = new Set(coreItems.map((item) => item.goodsNo));
      const duplicatesCoreItems = selected.some((prior) => {
        const priorGoodsNos = new Set(getCoreItems(prior).map((item) => item.goodsNo));
        let shared = 0;
        coreGoodsNos.forEach((goodsNo) => {
          if (priorGoodsNos.has(goodsNo)) shared += 1;
        });
        return shared >= 2;
      });
      if (duplicatesCoreItems) return;
      seenCoreCompositions.add(composition);
      selected.push(set);
    });
    return selected;
  }

  async function fetchMusinsaJson(url) {
    if (!global.chrome?.runtime?.id) throw new Error("확장 프로그램 컨텍스트를 사용할 수 없습니다.");
    const response = await chrome.runtime.sendMessage({
      type: "FETCH_MUSINSA_RESOURCE",
      url,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response?.ok) throw new Error(`무신사 응답 오류 (${response?.status || 0})`);
    return response.body;
  }

  function fetchCachedResource(key, loader) {
    const cached = resourceCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      resourceCache.delete(key);
      resourceCache.set(key, cached);
      return cached.promise;
    }
    if (cached) resourceCache.delete(key);

    const now = Date.now();
    for (const [cacheKey, entry] of resourceCache) {
      if (entry.expiresAt <= now) resourceCache.delete(cacheKey);
    }
    while (resourceCache.size >= RESOURCE_CACHE_MAX_ENTRIES) {
      resourceCache.delete(resourceCache.keys().next().value);
    }

    const entry = { expiresAt: Date.now() + RESOURCE_CACHE_TTL_MS, promise: null };
    entry.promise = Promise.resolve()
      .then(loader)
      .catch((error) => {
        if (resourceCache.get(key) === entry) resourceCache.delete(key);
        throw error;
      });
    resourceCache.set(key, entry);
    return entry.promise;
  }

  function buildSnapUrl(goodsNo) {
    const url = new URL("https://content.musinsa.com/api2/content/snap/v1/snaps");
    url.searchParams.set("page", "1");
    url.searchParams.set("size", "20");
    url.searchParams.set("goodsNosIncludeOtherColor", `MUSINSA:${goodsNo}`);
    url.searchParams.set("sort", "POPULAR");
    url.searchParams.set("fields", "id,thumbnailUrl,medias,formatType,aggregations,createdBy,model,goods");
    url.searchParams.set("formatTypes", "SHORTS,POST");
    url.searchParams.set("displayStatuses", "DISPLAY,PDP_ONLY");
    return url.href;
  }

  function fetchSnapPayload(goodsNo) {
    return fetchCachedResource(`snaps:${goodsNo}`, () => fetchMusinsaJson(buildSnapUrl(goodsNo)));
  }

  function fetchSimilarCandidates(goodsNo) {
    const safeGoodsNo = encodeURIComponent(String(goodsNo));
    const url = `https://goods-detail.musinsa.com/api2/goods/${safeGoodsNo}/recommends/multi?uuid=detail_goods_attributes_allbrand&limit=10`;
    return fetchCachedResource(`similar:${goodsNo}`, async () => collectSimilarCandidates(await fetchMusinsaJson(url)));
  }

  async function fetchSimilarSnapSets(current, candidates) {
    const selectedCandidates = scoreSimilarProducts(current, candidates).slice(0, MAX_SIMILAR_SNAP_PRODUCTS);
    const results = await Promise.all(selectedCandidates.map(async (candidate) => {
      try {
        const payload = await fetchSnapPayload(candidate.goodsNo);
        return { candidate, payload, error: null };
      } catch (error) {
        return { candidate, payload: null, error };
      }
    }));

    const sets = [];
    const errors = [];
    results.forEach(({ candidate, payload, error }) => {
      if (error) {
        errors.push(error);
        return;
      }
      try {
        makeOutfitSets(payload, current, candidate.goodsNo, "similar").forEach((set) => {
          sets.push({
            ...set,
            id: `${candidate.goodsNo}-${set.id}`,
            sourceKind: "similar",
            sourceLabel: "비슷한 상품의 스타일링 스냅 기반",
          });
        });
      } catch (parseError) {
        errors.push(parseError);
      }
    });
    return { sets, errors };
  }

  function getCurrentProductContext(goodsNo, state) {
    const name = String(state?.productName || document.querySelector('meta[property="og:title"]')?.content || document.title || "").replace(/\s*-\s*사이즈\s*&?\s*후기.*$/, "").trim();
    const brand = String(state?.brand?.name || "").trim();
    let category = String(state?.category?.name || "").trim();
    let categoryCode = "";
    let gender = asText(state?.gender || state?.genderName || state?.sex || state?.sexName);
    let season = asText(state?.season || state?.seasonName || state?.seasonCode);
    try {
      const nextData = JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent || "null");
      walkObjects(nextData, (node) => {
        if (String(node.goodsNo ?? "") !== String(goodsNo)) return;
        if (node.category) {
          categoryCode = String(node.category.categoryDepth2Code || node.category.categoryDepth1Code || "");
          category = category || String(node.category.categoryDepth2Name || node.category.categoryDepth1Name || "");
        }
        gender = gender || asText(node.genderName || node.gender || node.sexName || node.sex || node.genderCode || node.sexCode);
        season = season || asText(node.seasonName || node.season || node.seasonCode);
      });
    } catch (_) {
      // 페이지 내 상품 정보가 다르면 상품명 기반으로 계속 추천한다.
    }

    let price = null;
    const priceMeta = document.querySelector('meta[property="product:price:amount"], meta[property="og:price:amount"]')?.content;
    if (priceMeta) price = Number(String(priceMeta).replace(/[^\d.]/g, "")) || null;
    if (!price) {
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(script.textContent || "null");
          const product = Array.isArray(data) ? data.find((item) => item?.["@type"] === "Product") : data;
          const offer = Array.isArray(product?.offers) ? product.offers[0] : product?.offers;
          price = Number(offer?.price) || null;
          if (price) break;
        } catch (_) {
          // JSON-LD가 아닌 스크립트는 무시한다.
        }
      }
    }
    return {
      goodsNo: String(goodsNo),
      name,
      brand,
      category,
      categoryCode,
      price,
      color: asText(state?.colorName || state?.color),
      fit: asText(state?.fitName || state?.fit),
      gender: classifyGender([gender, name, category].map(asText).join(" ")) || (String(gender).trim().toUpperCase() === "M" ? "men" : String(gender).trim().toUpperCase() === "F" ? "women" : ""),
      season: classifySeason([season, name].map(asText).join(" ")),
    };
  }

  function renderProductCard(item, options = {}) {
    const url = item.url || getProductUrl(item);
    const image = item.image
      ? `<img class="recommendation-image" data-goods-no="${escapeHtml(item.goodsNo)}" loading="lazy" src="${escapeHtml(item.image)}" alt="">`
      : `<span class="recommendation-image recommendation-image--empty" data-goods-no="${escapeHtml(item.goodsNo)}" aria-hidden="true"></span>`;
    const brand = item.brand ? `<span>${escapeHtml(item.brand)}</span>` : "";
    const price = item.price ? `<span>${Number(item.price).toLocaleString("ko-KR")}원</span>` : "";
    const detail = [brand, price].filter(Boolean).join(" · ");
    const reasonTags = options.reasons?.length
      ? `<div class="recommendation-tags">${options.reasons.slice(0, 4).map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}</div>`
      : "";
    const cardClass = options.grid ? "recommendation-product recommendation-product--grid" : "recommendation-product";
    const card = `<span class="${cardClass}">${image}<span class="recommendation-product-copy"><b>${escapeHtml(item.name)}</b>${detail ? `<small>${detail}</small>` : ""}${reasonTags}</span></span>`;
    return url ? `<a class="recommendation-product-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${card}</a>` : `<div class="recommendation-product-link">${card}</div>`;
  }

  function preserveImageLayoutOnFailure(container) {
    container?.querySelectorAll?.("img.recommendation-image, img.recommendation-preview-image").forEach((image) => {
      image.addEventListener("error", () => {
        const placeholder = image.ownerDocument.createElement("span");
        placeholder.className = `${image.className} recommendation-image--empty`;
        placeholder.setAttribute("aria-hidden", "true");
        image.replaceWith(placeholder);
      }, { once: true });
    });
  }

  function renderOutfits(section, container, status, result) {
    if (!section || !container || !status) return { kind: "empty", sets: [] };
    section.hidden = false;
    if (result.kind === "empty") {
      status.textContent = "결과 없음";
      container.innerHTML = '<p class="recommendation-empty">아직 추천할 코디가 없어요.</p>';
      return { kind: "empty", sets: [] };
    }
    if (result.kind === "error") {
      status.textContent = "불러오지 못했어요";
      container.innerHTML = '<p class="recommendation-empty">코디를 불러오지 못했어요.</p>';
      return { kind: "error", sets: [] };
    }
    const { sets } = result;
    status.textContent = `${sets.length}세트`;
    const hasSimilarSnap = sets.some((set) => set.sourceKind === "similar");
    const intro = hasSimilarSnap
      ? "상품 또는 비슷한 상품에 태그된 스타일링 스냅에서 구성했어요."
      : "같은 무신사 스타일링 스냅에 함께 태그된 상품이에요.";
    container.innerHTML = `<p class="recommendation-intro">${intro}</p>${sets.map((set, index) => `
      <div class="outfit-set">
        <div class="outfit-set-title">스타일링 세트 ${index + 1} <span class="outfit-source-label">${escapeHtml(set.sourceLabel || (set.sourceKind === "similar" ? "비슷한 상품의 스타일링 스냅 기반" : "스타일링 스냅"))}</span></div>
        <div class="recommendation-tags outfit-reasons">${set.reasons.map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}</div>
        <div class="outfit-items">${set.items.map((item) => `<div class="outfit-item"><span class="outfit-type">${escapeHtml(OUTFIT_LABELS[item.type] || "상품")}</span>${renderProductCard(item, { grid: true })}</div>`).join("")}</div>
      </div>`).join("")}`;
    preserveImageLayoutOnFailure(container);
    return { kind: "snap", sets };
  }

  function renderSimilar(section, container, status, current, candidates, error = null) {
    if (!container || !status) return { kind: "empty", items: [] };
    if (error) {
      if (section) section.hidden = false;
      status.textContent = "불러오지 못했어요";
      container.innerHTML = '<p class="recommendation-empty">비슷한 상품을 불러오지 못했어요.</p>';
      return { kind: "error", items: [] };
    }
    if (!candidates.length) {
      if (section) section.hidden = false;
      status.textContent = "결과 없음";
      container.innerHTML = '<p class="recommendation-empty">아직 비슷한 상품이 없어요.</p>';
      return { kind: "empty", items: [] };
    }
    const ranked = scoreSimilarProducts(current, candidates);
    if (!ranked.length) {
      if (section) section.hidden = false;
      status.textContent = "결과 없음";
      container.innerHTML = '<p class="recommendation-empty">아직 비슷한 상품이 없어요.</p>';
      return { kind: "empty", items: [] };
    }
    if (section) section.hidden = false;
    status.textContent = `${ranked.length}개`;
    renderSimilarItems(container, ranked);
    return { kind: "items", items: ranked };
  }

  function renderSimilarItems(container, ranked) {
    container.innerHTML = `<p class="recommendation-intro">무신사에서 제공하는 비슷한 상품을 카테고리·핏·색상·가격대·브랜드 근거로 정렬했어요.</p><div class="recommendation-list recommendation-grid">${ranked.map((item) => renderProductCard(item, { reasons: item.reasons, grid: true })).join("")}</div>`;
    preserveImageLayoutOnFailure(container);
  }

  function createRecommendationModalController(launcherRoot, modalRoot = launcherRoot, lifecycleRoot = launcherRoot) {
    const launcher = launcherRoot?.getElementById("recommendationLauncher");
    const openButton = launcherRoot?.getElementById("recommendationOpenButton");
    const summary = launcherRoot?.getElementById("recommendationSummary");
    const preview = launcherRoot?.getElementById("recommendationPreview");
    const modal = modalRoot?.getElementById("recommendationModal");
    const dialog = modalRoot?.getElementById("recommendationDialog");
    const closeButton = modalRoot?.getElementById("recommendationCloseButton");
    const backdrop = modalRoot?.getElementById("recommendationModalBackdrop");
    const outfitTab = modalRoot?.getElementById("outfitRecommendationTab");
    const similarTab = modalRoot?.getElementById("similarRecommendationTab");
    const outfitPanel = modalRoot?.getElementById("outfitRecommendationSection");
    const similarPanel = modalRoot?.getElementById("similarRecommendationSection");
    if (!launcher || !openButton || !summary || !preview || !modal || !dialog || !closeButton || !backdrop || !outfitTab || !similarTab || !outfitPanel || !similarPanel) {
      return { update() {} };
    }

    const state = {
      outfit: { kind: "loading", sets: [] },
      similar: { kind: "loading", items: [] },
      activeTab: "outfit",
      scrollLock: null,
      opener: null,
    };
    const documentRef = global.document || global.window?.document || null;
    const modalHost = modalRoot?.host || null;
    const detachedLauncherHost = launcherRoot !== lifecycleRoot ? launcherRoot?.host || null : null;

    function attachModalHost() {
      if (!modalHost || modalHost.isConnected) return true;
      const mountTarget = documentRef?.documentElement || documentRef?.body;
      if (!mountTarget?.appendChild) return false;
      mountTarget.appendChild(modalHost);
      return modalHost.isConnected !== false;
    }

    function detachModalHost() {
      if (modalHost?.isConnected) modalHost.remove?.();
    }

    function setActiveTab(tabName, moveFocus = false) {
      state.activeTab = tabName;
      const isOutfit = tabName === "outfit";
      outfitTab.setAttribute("aria-selected", String(isOutfit));
      similarTab.setAttribute("aria-selected", String(!isOutfit));
      outfitTab.tabIndex = isOutfit ? 0 : -1;
      similarTab.tabIndex = isOutfit ? -1 : 0;
      outfitPanel.hidden = !isOutfit;
      similarPanel.hidden = isOutfit;
      if (moveFocus) (isOutfit ? outfitTab : similarTab).focus?.();
    }

    function lockBackgroundScroll() {
      const body = documentRef?.body;
      const documentElement = documentRef?.documentElement;
      state.scrollLock = {
        body,
        documentElement,
        bodyOverflow: body?.style?.overflow ?? "",
        documentOverflow: documentElement?.style?.overflow ?? "",
      };
      if (body?.style) body.style.overflow = "hidden";
      if (documentElement?.style) documentElement.style.overflow = "hidden";
    }

    function unlockBackgroundScroll() {
      const locked = state.scrollLock;
      if (!locked) return;
      if (locked.body?.style) locked.body.style.overflow = locked.bodyOverflow;
      if (locked.documentElement?.style) locked.documentElement.style.overflow = locked.documentOverflow;
      state.scrollLock = null;
    }

    function closeModal(restoreFocus = true) {
      if (modal.hidden) return;
      modal.hidden = true;
      openButton.setAttribute("aria-expanded", "false");
      unlockBackgroundScroll();
      detachModalHost();
      if (restoreFocus && state.opener?.isConnected !== false) state.opener?.focus?.();
      state.opener = null;
    }

    function openModal() {
      if (launcher.hidden) return;
      if (!attachModalHost()) return;
      state.opener = openButton;
      lockBackgroundScroll();
      modal.hidden = false;
      openButton.setAttribute("aria-expanded", "true");
      const initialTab = state.outfit.kind === "snap" || state.similar.kind !== "items" ? "outfit" : "similar";
      setActiveTab(initialTab);
      closeButton.focus?.();
    }

    function getFocusableElements() {
      return Array.from(dialog.querySelectorAll('button:not([disabled]):not([tabindex="-1"]), a[href], [tabindex]:not([tabindex="-1"])'))
        .filter((element) => !element.closest?.("[hidden]") && element.getAttribute?.("aria-hidden") !== "true");
    }

    function onDialogKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "Home" || event.key === "End") {
        const isTab = event.target?.closest?.('[role="tab"]');
        if (!isTab) return;
        event.preventDefault();
        const nextTab = event.key === "Home" ? "outfit"
          : event.key === "End" ? "similar"
            : event.key === "ArrowRight" ? (state.activeTab === "outfit" ? "similar" : "outfit")
              : (state.activeTab === "outfit" ? "similar" : "outfit");
        setActiveTab(nextTab, true);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements();
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus?.();
        return;
      }
      const activeElement = modalRoot.activeElement || documentRef?.activeElement;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (activeElement === first || !dialog.contains?.(activeElement))) {
        event.preventDefault();
        last.focus?.();
      } else if (!event.shiftKey && (activeElement === last || !dialog.contains?.(activeElement))) {
        event.preventDefault();
        first.focus?.();
      }
    }

    openButton.addEventListener("click", openModal);
    closeButton.addEventListener("click", () => closeModal());
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal();
    });
    outfitTab.addEventListener("click", () => setActiveTab("outfit"));
    similarTab.addEventListener("click", () => setActiveTab("similar"));
    dialog.addEventListener("keydown", onDialogKeydown);

    const MutationObserverRef = global.MutationObserver || global.window?.MutationObserver;
    if (documentRef?.documentElement && MutationObserverRef) {
      const detachObserver = new MutationObserverRef(() => {
        if (!lifecycleRoot.host?.isConnected) {
          closeModal(false);
          detachModalHost();
          detachObserver.disconnect();
        }
      });
      detachObserver.observe(documentRef.documentElement, { childList: true, subtree: true });
    }

    function update(nextState) {
      state.outfit = nextState.outfit;
      state.similar = nextState.similar;
      const bothEmpty = state.outfit.kind === "empty" && state.similar.kind === "empty";
      launcher.hidden = bothEmpty;
      if (detachedLauncherHost) {
        detachedLauncherHost.hidden = bothEmpty;
        detachedLauncherHost.style.display = bothEmpty ? "none" : "block";
      }
      const describe = (label, result, unit) => {
        if (result.kind === "loading") return `${label} 불러오는 중`;
        if (result.kind === "error") return `${label} 불러오지 못했어요`;
        if (result.kind === "empty") return `${label} 결과 없음`;
        const count = result.kind === "snap" ? result.sets.length : result.items.length;
        return `${label} ${count}${unit}`;
      };
      summary.textContent = state.outfit.kind === "loading" && state.similar.kind === "loading"
        ? "불러오는 중…"
        : state.outfit.kind === "error" && state.similar.kind === "error"
          ? "불러오지 못했어요"
          : `${describe("코디", state.outfit, "세트")} · ${describe("비슷한 상품", state.similar, "개")}`;
      if (bothEmpty) closeModal(false);

      const previewItems = [];
      const seenGoods = new Set();
      const addPreviewItem = (item) => {
        if (!item) return;
        const key = String(item.goodsNo || item.url || item.name || previewItems.length);
        if (seenGoods.has(key)) return;
        seenGoods.add(key);
        previewItems.push(item);
      };
      state.outfit.sets?.forEach((set) => set.items?.forEach(addPreviewItem));
      state.similar.items?.forEach(addPreviewItem);
      preview.innerHTML = previewItems.slice(0, 3).map((item) =>
        `<span class="recommendation-preview-cell">${item.image
          ? `<img class="recommendation-preview-image" data-goods-no="${escapeHtml(item.goodsNo)}" loading="lazy" src="${escapeHtml(item.image)}" alt="">`
          : `<span class="recommendation-preview-image recommendation-image--empty" data-goods-no="${escapeHtml(item.goodsNo)}" aria-hidden="true"></span>`}</span>`
      ).join("");
      preview.hidden = !previewItems.length || bothEmpty;
      preserveImageLayoutOnFailure(preview);
    }

    return { update };
  }

  async function render(shadowRoot, goodsNo, state, modalRoot = shadowRoot, launcherRoot = shadowRoot) {
    const outfitSection = modalRoot?.getElementById("outfitRecommendationSection");
    const outfitContainer = modalRoot?.getElementById("outfitRecommendationContent");
    const outfitStatus = modalRoot?.getElementById("outfitRecommendationStatus");
    const similarContainer = modalRoot?.getElementById("similarRecommendationContent");
    const similarSection = modalRoot?.getElementById("similarRecommendationSection");
    const similarStatus = modalRoot?.getElementById("similarRecommendationStatus");
    if (!outfitSection || !outfitContainer || !outfitStatus || !similarSection || !similarContainer || !similarStatus) return;

    const recommendationState = {
      outfit: { kind: "loading", sets: [] },
      similar: { kind: "loading", items: [] },
    };
    const modalController = createRecommendationModalController(launcherRoot, modalRoot, shadowRoot);
    modalController.update(recommendationState);

    outfitSection.hidden = false;
    let current = { goodsNo: String(goodsNo), name: String(state?.productName || ""), brand: String(state?.brand?.name || ""), category: String(state?.category?.name || "") };
    try {
      current = getCurrentProductContext(goodsNo, state);
    } catch (error) {
      console.warn("[사이즈·코디위젯] 현재 상품 정보 일부를 읽지 못했습니다:", error);
    }
    const isMounted = () => {
      if (!shadowRoot.host?.isConnected) return false;
      const href = global.location?.href || global.window?.location?.href;
      if (!href) return true;
      try {
        const match = new URL(href).pathname.match(PRODUCT_PATH);
        return !match || match[1] === String(goodsNo);
      } catch (_) {
        return true;
      }
    };
    const similarCandidatesTask = fetchSimilarCandidates(goodsNo).then(
      (candidates) => ({ candidates, error: null }),
      (error) => ({ candidates: [], error })
    );
    const similarTask = similarCandidatesTask.then(({ candidates, error }) => {
      if (!isMounted()) return null;
      const result = renderSimilar(similarSection, similarContainer, similarStatus, current, candidates, error);
      recommendationState.similar = result;
      modalController.update(recommendationState);
      return result;
    });
    const outfitTask = (async () => {
      const errors = [];
      let snapPayload = null;
      try {
        snapPayload = await fetchSnapPayload(goodsNo);
      } catch (error) {
        errors.push(error);
      }
      let sets = [];
      try {
        if (snapPayload) {
          sets = makeOutfitSets(snapPayload, current).map((set) => ({
            ...set,
            sourceKind: "direct",
            sourceLabel: "스타일링 스냅",
          }));
        }
      } catch (error) {
        errors.push(error);
      }

      if (selectDiverseOutfitSets(sets).length < 2) {
        const similarResult = await similarCandidatesTask;
        if (similarResult.error) {
          errors.push(similarResult.error);
        } else if (similarResult.candidates.length) {
          const similarSnapResult = await fetchSimilarSnapSets(current, similarResult.candidates);
          sets = sets.concat(similarSnapResult.sets);
          errors.push(...similarSnapResult.errors);
        }
      }

      const diverseSets = selectDiverseOutfitSets(sets);
      const result = diverseSets.length
        ? { kind: "snap", sets: diverseSets }
        : errors.length
          ? { kind: "error", sets: [] }
          : { kind: "empty", sets: [] };
      if (!isMounted()) return;
      recommendationState.outfit = renderOutfits(outfitSection, outfitContainer, outfitStatus, result);
      modalController.update(recommendationState);
    })().catch((error) => {
      if (!isMounted()) return;
      console.warn("[사이즈·코디위젯] 코디 추천 처리 실패:", error);
      recommendationState.outfit = renderOutfits(outfitSection, outfitContainer, outfitStatus, { kind: "error", sets: [] });
      modalController.update(recommendationState);
    });
    await Promise.all([similarTask, outfitTask]);

    const recommendedItems = [];
    recommendationState.outfit.sets?.forEach((set) => set.items?.forEach((item) => recommendedItems.push(item)));
    recommendationState.similar.items?.forEach((item) => recommendedItems.push(item));
    const enrichedCount = await enrichMissingProductImages(recommendedItems);
    if (enrichedCount && isMounted()) {
      if (recommendationState.outfit.kind === "snap") {
        recommendationState.outfit = renderOutfits(outfitSection, outfitContainer, outfitStatus, recommendationState.outfit);
      }
      if (recommendationState.similar.kind === "items") {
        renderSimilarItems(similarContainer, recommendationState.similar.items);
      }
      modalController.update(recommendationState);
    }
  }

  global.MusinsaOutfitRecommendations = { render };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      render,
      collectSimilarCandidates,
      scoreSimilarProducts,
      makeOutfitSets,
      selectDiverseOutfitSets,
      fetchSimilarSnapSets,
      renderOutfits,
      renderSimilar,
      renderSimilarItems,
      createRecommendationModalController,
      classifyOutfitType,
      normalizeProduct,
      getProductImage,
      getThumbnailImageFromProductDetail,
      fetchProductThumbnailImage,
      enrichMissingProductImages,
      getProductUrl,
      isExplicitlyUnavailable,
      classifyGender,
      classifySeason,
      incompatibleProducts,
      imageUrlMatchesProduct,
      isCatalogImageForProduct,
      fetchCachedResource,
      clearResourceCache: () => resourceCache.clear(),
      resourceCacheSize: () => resourceCache.size,
      clearProductImageCache: () => productImageCache.clear(),
      productImageCacheSize: () => productImageCache.size,
    };
  }
})(typeof window !== "undefined" ? window : globalThis);
