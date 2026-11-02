import { createHmac } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { playerauctionsAccountAttributes } from "./playerauctions-fields.mjs";
export { playerauctionsAccountAttributes } from "./playerauctions-fields.mjs";

const apiOrigin = "https://seller-api.playerauctions.com";
export function playerauctionsHeaders(key, secret, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  return {
    "X-PA-API-KEY": key,
    "X-PA-TIMESTAMP": timestamp,
    // All requests below are GETs with no request body. Query parameters are
    // encoded in the URL; the documented signature signs the empty body.
    "X-PA-SIGN": createHmac("sha256", secret)
      .update(key + timestamp)
      .digest("hex"),
    Accept: "application/json",
  };
}
export async function playerauctionsRequest(
  path,
  { key, secret, dns64 = process.env.PLAYERAUCTIONS_DNS64_SERVER } = {},
) {
  if (!key || !secret)
    throw new Error(
      "PlayerAuctions: для автосбора нужен API-ключ с правом View Marketplace Offers. Ключи на сервере пока не настроены.",
    );
  const url = new URL(path, apiOrigin);
  if (
    url.origin !== apiOrigin ||
    !/^\/api\/v1\/(?:games|olp\/account)(?:[/?]|$)/.test(url.pathname)
  )
    throw new Error("Недопустимый адрес PlayerAuctions API");
  let address;
  if (dns64) {
    const resolver = new Resolver({ timeout: 3000, tries: 1 });
    resolver.setServers([dns64]);
    const addresses = await resolver.resolve6(url.hostname);
    // DNS64 supplies the gateway addresses; do not hardcode destination IPs
    // or change the server's system-wide resolver. HTTPS still checks the
    // certificate against seller-api.playerauctions.com.
    address = addresses[0];
    if (!address)
      throw new Error("PlayerAuctions: DNS64 не вернул сетевой маршрут.");
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        headers: playerauctionsHeaders(key, secret),
        signal: AbortSignal.timeout(20000),
        ...(address
          ? {
              family: 6,
              lookup: (_host, _options, callback) => callback(null, address, 6),
            }
          : {}),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new Error(
              `PlayerAuctions API: HTTP ${res.statusCode}. Снимок не сохранён.`,
            ),
          );
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 5 * 1024 * 1024)
            res.destroy(new Error("PlayerAuctions: ответ превышает 5 МБ."));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (json.code !== 10000)
              throw new Error(
                `PlayerAuctions API: запрос отклонён (код ${Number(json.code) || "неизвестен"}). Проверьте права ключа и разрешённый исходящий IP.`,
              );
            resolve(json);
          } catch (error) {
            reject(
              error instanceof SyntaxError
                ? new Error("PlayerAuctions: API вернул некорректные данные.")
                : error,
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
export async function fetchPlayerauctionsAccounts({
  key = process.env.PLAYERAUCTIONS_API_KEY,
  secret = process.env.PLAYERAUCTIONS_API_SECRET,
  requestData = (path) => playerauctionsRequest(path, { key, secret }),
  onProgress = () => {},
  knownUrls = new Map(),
} = {}) {
  const games = await requestData("/api/v1/games");
  if (!Array.isArray(games.data))
    throw new Error("PlayerAuctions: изменился формат списка игр.");
  const game = games.data.find((g) => /^dota\s*2$/i.test(g.gameName ?? ""));
  if (!game || !Number.isSafeInteger(game.gameId))
    throw new Error("PlayerAuctions: игра Dota 2 не найдена в API.");
  const offers = new Map();
  const seenIds = new Set();
  let read = 0,
    total = 0;
  for (let page = 1; ; page++) {
    if (page > 100)
      throw new Error(
        "PlayerAuctions: превышен лимит страниц. Неполный снимок не сохранён.",
      );
    const params = new URLSearchParams({
      gameId: String(game.gameId),
      pageIndex: String(page),
      pageSize: "100",
    });
    const { data } = await requestData("/api/v1/olp/account?" + params);
    if (
      !Array.isArray(data?.items) ||
      !Number.isSafeInteger(data.count) ||
      data.count < 0
    )
      throw new Error(
        "PlayerAuctions: изменился формат предложений. Снимок не сохранён.",
      );
    total = data.count;
    if (!data.items.length && read < total)
      throw new Error(
        "PlayerAuctions: не удалось получить все страницы. Снимок не сохранён.",
      );
    const before = seenIds.size;
    for (const row of data.items) {
      seenIds.add(row.offerId);
      if (
        !Number.isSafeInteger(row.offerId) ||
        row.offerId <= 0 ||
        typeof row.offerTitle !== "string" ||
        !row.offerTitle.trim() ||
        !(
          typeof row.price === "number" ||
          /^\d+(?:\.\d+)?$/.test(row.price ?? "")
        ) ||
        !Number.isFinite(Number(row.price)) ||
        Number(row.price) < 0
      )
        throw new Error(
          "PlayerAuctions: неполные данные объявления. Снимок не сохранён.",
        );
      // /immortal/ is a keyword page on PlayerAuctions (it also matches
      // Immortal inventory). Do not invent a rank/MMR threshold for that page.
      if (!/immortal/i.test(row.offerTitle)) continue;
      const url = row.offerTitleUrl || knownUrls.get(row.offerId);
      if (!url)
        throw new Error(
          "PlayerAuctions: API не вернул оригинальную ссылку для нового объявления. Неполный снимок не сохранён.",
        );
      const parsed = new URL(url);
      if (
        parsed.origin !== "https://www.playerauctions.com" ||
        parsed.username ||
        parsed.password ||
        !parsed.pathname.startsWith(`/dota-2-account/${row.offerId}a!`)
      )
        throw new Error("PlayerAuctions: неверная ссылка на объявление.");
      offers.set(row.offerId, {
        id: `playerauctions:${row.offerId}`,
        title: row.offerTitle.trim(),
        price: Number(row.price),
        seller: row.sellerName || "Продавец не указан",
        sellerId: `playerauctions:${row.sellerName || "unknown"}`,
        reviews: 0,
        online: false,
        attributes: playerauctionsAccountAttributes(
          row.offerTitle,
          "",
          /^Instant$/i.test(row.deliveryTime ?? ""),
        ),
        url: parsed.href,
      });
    }
    if (data.items.length && seenIds.size === before)
      throw new Error("PlayerAuctions: повтор страницы. Снимок не сохранён.");
    read += data.items.length;
    onProgress({ completed: read, total });
    if (read >= total) break;
  }
  if (!offers.size)
    throw new Error(
      "PlayerAuctions: аккаунты по запросу Immortal не найдены. Снимок не сохранён.",
    );
  return { offers: [...offers.values()], advertised: offers.size, skipped: 0 };
}
