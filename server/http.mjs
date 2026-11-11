import { setTimeout as delay } from "node:timers/promises";

const transient = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
function codes(error) {
  return [
    ...new Set(
      [
        error?.code,
        error?.cause?.code,
        ...(error?.cause?.errors ?? []).map((e) => e.code),
      ].filter(Boolean),
    ),
  ];
}
export function upstreamError(source, status) {
  return Object.assign(
    new Error(`${source}: HTTP ${status}. Новый снимок не сохранён.`),
    {
      retryable: [408, 500, 502, 503, 504].includes(status),
    },
  );
}
export async function retrySnapshot(read, { wait = delay } = {}) {
  try {
    return await read();
  } catch (error) {
    if (
      !error.retryable &&
      !["TimeoutError", "AbortError"].includes(error.name) &&
      !codes(error).some((code) => transient.has(code)) &&
      !/net::ERR_(CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|NETWORK_CHANGED)/.test(
        error.message,
      )
    )
      throw error;
    await wait(1000);
    return read();
  }
}
export function collectionError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError")
    return "Площадка не ответила за 20 секунд. Новый снимок не сохранён.";
  if (error?.message === "fetch failed") {
    const detail = codes(error).join(", ");
    return `Не удалось соединиться с площадкой${detail ? ` (${detail})` : ""}. Новый снимок не сохранён.`;
  }
  return error?.message ?? "Не удалось получить данные площадки";
}
export async function fetchListing(
  url,
  options,
  { fetchImpl = fetch, timeoutMs = 20000 } = {},
) {
  // One retry for a transient connection failure, sharing the SAME deadline.
  // HTTP errors, access restrictions and TLS validation errors are not retried.
  const signal = AbortSignal.timeout(timeoutMs);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchImpl(url, { ...options, signal });
    } catch (error) {
      if (
        attempt ||
        signal.aborted ||
        !codes(error).some((code) => transient.has(code))
      )
        throw error;
    }
  }
}
