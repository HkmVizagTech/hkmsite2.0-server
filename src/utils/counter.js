import { one } from "../db/pg.js";

export const getNextSequence = async (name) => {
  const row = await one(
    `INSERT INTO counters (name, seq) VALUES ($1, 1)
     ON CONFLICT (name) DO UPDATE SET seq = counters.seq + 1
     RETURNING seq`,
    [name]
  );
  return row.seq;
};
