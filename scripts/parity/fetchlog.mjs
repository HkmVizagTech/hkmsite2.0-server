import { appendFileSync } from "node:fs";

const file = process.env.FETCH_LOG;
const real = globalThis.fetch;
if (file) {
  globalThis.fetch = async (input, init) => {
    const res = await real(input, init);
    try {
      const url = new URL(typeof input === "string" ? input : (input.url ?? String(input)));
      const method = (init?.method ?? input?.method ?? "GET").toUpperCase();
      appendFileSync(file, `${url.port} ${method} ${url.pathname} ${res.status}\n`);
    } catch {}
    return res;
  };
}
