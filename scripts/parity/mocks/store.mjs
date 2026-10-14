import fs from "node:fs";

const statePath = () => process.env.MOCK_STATE || "";
const storePath = () => (statePath() ? statePath().replace(/\.json$/, "") + ".store.json" : "");

const readJson = (file, fallback) => {
  if (!file) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = (file, value) => {
  if (!file) return;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
};

export const readState = () => readJson(statePath(), {});
export const writeState = (state) => writeJson(statePath(), state);

const memoryStore = { counters: {}, entities: {} };
export const readStore = () => (storePath() ? readJson(storePath(), { counters: {}, entities: {} }) : memoryStore);
export const writeStore = (store) => (storePath() ? writeJson(storePath(), store) : undefined);

export const nextCounter = (name) => {
  const store = readStore();
  store.counters[name] = (store.counters[name] || 0) + 1;
  writeStore(store);
  return store.counters[name];
};

export const putEntity = (kind, id, value) => {
  const store = readStore();
  store.entities[kind] ||= {};
  store.entities[kind][id] = value;
  writeStore(store);
  return value;
};

export const getEntity = (kind, id) => readStore().entities[kind]?.[id] ?? null;
export const listEntities = (kind) => Object.values(readStore().entities[kind] || {});

export const padId = (n, width = 6) => String(n).padStart(width, "0");

// Consumes one scripted failure for a service (failNext counts down in the state file; failAll never does).
export const takeFailure = (service) => {
  const state = readState();
  const cfg = state[service];
  if (!cfg) return null;
  if (cfg.failAll) return cfg;
  if (Number(cfg.failNext) > 0) {
    cfg.failNext -= 1;
    writeState(state);
    return cfg;
  }
  return null;
};
