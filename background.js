// =============================================================================
// background.js — 확장 프로그램 서비스 워커(백그라운드)
// -----------------------------------------------------------------------------
// content.js(무신사 상품 페이지에 주입되는 스크립트)는 페이지 출처(origin)에서
// 동작하므로 다른 무신사 서브도메인 API를 직접 호출하면 CORS에 막힐 수 있다.
// 그래서 네트워크 요청과 모델 데이터 로딩은 이 백그라운드가 대신 수행하고,
// chrome.runtime 메시지로 결과를 돌려준다.
//
// 처리하는 메시지 종류
//   - FETCH_REF_SIZE_CHART   : 기준 상품(goodsNo)의 실측 사이즈표 조회
//   - GET_MODEL_DATA         : 확장 내부 model/*.json(추천 모델·상품 조회표) 로딩
//   - FETCH_MUSINSA_RESOURCE : 허용된 무신사 URL을 임의로 대리 요청
// =============================================================================

// 대리 요청을 허용하는 출처 목록(화이트리스트).
// 여기에 없는 출처로의 요청은 거부해 확장이 임의 사이트 프록시로 악용되지 않게 한다.
// manifest.json의 host_permissions와 동일하게 유지해야 한다.
const ALLOWED_FETCH_ORIGINS = new Set([
  "https://www.musinsa.com",
  "https://my.musinsa.com",
  "https://api.musinsa.com",
  "https://goods.musinsa.com",
  "https://goods-detail.musinsa.com",
  "https://content.musinsa.com",
]);

// 기준 상품 실측 사이즈표 요청의 타임아웃(ms). 응답이 늦으면 위젯이 무한 로딩되지 않도록 끊는다.
const REF_SIZE_CHART_TIMEOUT_MS = 5000;

/**
 * 허용된 무신사 출처의 리소스를 가져온다.
 * @param {string} url           요청할 절대 URL
 * @param {"json"|"text"} responseType  응답 본문 파싱 방식(기본 json)
 * @param {number} timeoutMs     0이면 타임아웃 없음, 양수면 해당 ms 후 요청 중단
 * @returns {Promise<{ok:boolean, status:number, body:any}>}
 *          메시지로 그대로 전달 가능한 직렬화 가능 객체
 */
async function fetchMusinsaResource(url, responseType = "json", timeoutMs = 0) {
  // 출처 검사: 화이트리스트 밖이면 즉시 예외
  const parsedUrl = new URL(url);
  if (!ALLOWED_FETCH_ORIGINS.has(parsedUrl.origin)) throw new Error("fetch origin not allowed");

  // 타임아웃이 지정된 경우에만 AbortController로 요청 중단 타이머를 건다.
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    // credentials: "include" → 사용자의 무신사 로그인 쿠키를 함께 보내
    // 로그인이 필요한 API(구매 이력 등)도 조회할 수 있게 한다.
    const res = await fetch(parsedUrl.href, {
      credentials: "include",
      ...(controller ? { signal: controller.signal } : {}),
    });
    const body = responseType === "text" ? await res.text() : await res.json();
    // HTTP 오류여도 예외를 던지지 않고 ok/status로 알려 호출 측이 판단하게 한다.
    return { ok: res.ok, status: res.status, body };
  } finally {
    // 성공/실패와 관계없이 타이머 정리
    if (timer) clearTimeout(timer);
  }
}

// [메시지 1] FETCH_REF_SIZE_CHART
// 사용자가 고른 "기준 상품"의 실측 사이즈표를 무신사 상세 API에서 가져온다.
// 요청: { type, goodsNo }  →  응답: { ok, status, body } 또는 { ok:false, status:0, error }
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 다른 메시지 타입은 무시(false 반환 = 비동기 응답 안 함)
  if (!message || message.type !== "FETCH_REF_SIZE_CHART") return false;

  (async () => {
    try {
      // 상품 번호는 숫자만 허용(경로 조작 방지)
      const goodsNo = String(message.goodsNo || "").trim();
      if (!/^\d+$/.test(goodsNo)) throw new Error("invalid goodsNo");
      const result = await fetchMusinsaResource(
        `https://goods-detail.musinsa.com/api2/goods/${encodeURIComponent(goodsNo)}/actual-size`,
        "json",
        REF_SIZE_CHART_TIMEOUT_MS
      );
      sendResponse(result);
    } catch (err) {
      // 네트워크 오류·타임아웃·검증 실패 모두 status 0으로 통일해 전달
      sendResponse({ ok: false, status: 0, error: String((err && err.message) || err) });
    }
  })();

  // true 반환 → sendResponse를 비동기로 호출하겠다는 의미(채널 유지)
  return true;
});

// 모델 데이터 로딩 Promise 캐시. 서비스 워커 인스턴스가 살아 있는 동안 여러 탭/요청이 같은 Promise를 재사용한다.
// (서비스 워커가 종료·재시작되면 메모리가 비워져 파일을 다시 읽는다.)
let modelDataPromise = null;

/**
 * 확장에 포함된 추천 모델(model.json)과 상품 조회표(product_lookup.json)를 읽는다.
 * 성공 결과는 캐시해 재사용하고, 실패하면 캐시를 비워 다음 요청에서 다시 시도한다.
 * @returns {Promise<{model:object, lookup:object}>}
 */
async function loadModelData() {
  if (!modelDataPromise) {
    modelDataPromise = Promise.all([
      fetch(chrome.runtime.getURL("model/model.json")),
      fetch(chrome.runtime.getURL("model/product_lookup.json")),
    ])
      .then(async ([modelRes, lookupRes]) => {
        if (!modelRes.ok || !lookupRes.ok) {
          throw new Error(`model data load failed (${modelRes.status}, ${lookupRes.status})`);
        }
        const [model, lookup] = await Promise.all([modelRes.json(), lookupRes.json()]);
        return { model, lookup };
      })
      .catch((err) => {
        // 실패한 Promise가 캐시에 남지 않도록 초기화 후 오류 전파
        modelDataPromise = null;
        throw err;
      });
  }
  return modelDataPromise;
}

// [메시지 2] GET_MODEL_DATA
// content.js가 사이즈 추천 계산에 필요한 모델 데이터를 요청할 때 응답한다.
// 응답: { ok:true, model, lookup } 또는 { ok:false, error }
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "GET_MODEL_DATA") return false;

  loadModelData()
    .then(({ model, lookup }) => sendResponse({ ok: true, model, lookup }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));

  return true; // 비동기 응답
});

// [메시지 3] FETCH_MUSINSA_RESOURCE
// content.js가 무신사 API/페이지(구매 이력, 상품 정보 등)를 대리 요청할 때 사용한다.
// 요청: { type, url, responseType?, timeoutMs? }
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "FETCH_MUSINSA_RESOURCE") return false;

  (async () => {
    try {
      // 타임아웃은 숫자일 때만 적용하고 1초~15초 범위로 제한. 숫자가 아니면 타임아웃 없음(0).
      const timeoutMs = Number.isFinite(Number(message.timeoutMs))
        ? Math.min(15000, Math.max(1000, Number(message.timeoutMs)))
        : 0;
      sendResponse(await fetchMusinsaResource(message.url, message.responseType, timeoutMs));
    } catch (err) {
      sendResponse({ ok: false, status: 0, error: String((err && err.message) || err) });
    }
  })();

  return true; // 비동기 응답
});

// DEV-ONLY AUTO-RELOAD (배포 전 제거) - BEGIN
const DEV_RELOAD_STAMP_STORAGE_KEY = "devReloadStamp";
let devReloadCheckPromise = null;
let devReloadTriggered = false;

async function checkDevReloadStamp() {
  if (devReloadTriggered) return false;
  if (devReloadCheckPromise) return devReloadCheckPromise;

  devReloadCheckPromise = (async () => {
    const response = await fetch(chrome.runtime.getURL("dev-reload.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`dev-reload.json fetch failed (${response.status})`);

    const payload = await response.json();
    const nextStamp = typeof payload?.stamp === "string" ? payload.stamp.trim() : "";
    if (!nextStamp) throw new Error("dev-reload.json has no valid stamp");

    const stored = await chrome.storage.local.get(DEV_RELOAD_STAMP_STORAGE_KEY);
    const previousStamp = stored[DEV_RELOAD_STAMP_STORAGE_KEY];
    if (previousStamp == null) {
      await chrome.storage.local.set({ [DEV_RELOAD_STAMP_STORAGE_KEY]: nextStamp });
      return false;
    }
    if (previousStamp === nextStamp) return false;

    // 저장을 먼저 완료하면 확장 재시작 후 같은 stamp를 다시 읽어 무한 reload를 막는다.
    await chrome.storage.local.set({ [DEV_RELOAD_STAMP_STORAGE_KEY]: nextStamp });
    devReloadTriggered = true;
    chrome.runtime.reload();
    return true;
  })().finally(() => {
    devReloadCheckPromise = null;
  });

  return devReloadCheckPromise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "DEV_RELOAD_PING") return false;

  const senderUrl = sender && sender.url;
  if (!senderUrl || !/^https:\/\/www\.musinsa\.com\/products\/\d+(?:[/?#]|$)/.test(senderUrl)) {
    return false;
  }

  checkDevReloadStamp().then(
    (reloaded) => sendResponse({ ok: true, reloaded }),
    (error) => {
      console.warn("[DEV-ONLY AUTO-RELOAD] stamp 확인 실패:", error);
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    }
  );
  return true;
});
// DEV-ONLY AUTO-RELOAD (배포 전 제거) - END
