import { darshans } from "../db/tables.js";
import { tx } from "../db/pg.js";
import { darshanSchema } from "../domain/schemas.js";
import { makeStore } from "../domain/store.js";

const store = makeStore(darshans, darshanSchema);

const darshanController = {
  // Server-to-server (shared-secret header). The payload is the full active set,
  // so a missed call self-corrects on the next sync.
  sync: async (req, res) => {
    try {
      const secret = req.headers["x-darshan-sync-secret"];
      if (!process.env.DARSHAN_SYNC_SECRET || secret !== process.env.DARSHAN_SYNC_SECRET) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const photos = Array.isArray(req.body.photos) ? req.body.photos : [];
      const incomingIds = photos.map((p) => Number(p.id)).filter((id) => Number.isFinite(id));

      await tx(async (client) => {
        await darshans.deleteMany({ vaikunthamId: { $nin: incomingIds } }, { client });

        for (let i = 0; i < photos.length; i++) {
          const p = photos[i];
          const vaikunthamId = Number(p.id);
          if (!Number.isFinite(vaikunthamId) || !p.imageUrl) continue;

          const cast = darshanSchema.castUpdate({
            vaikunthamId,
            imageUrl: p.imageUrl,
            position: typeof p.position === "number" ? p.position : i,
            status: "active",
            syncedAt: new Date(),
          });
          await client.query(
            `INSERT INTO darshans (id, vaikuntham_id, image_url, position, status, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (vaikuntham_id) DO UPDATE
               SET image_url = EXCLUDED.image_url, position = EXCLUDED.position,
                   status = EXCLUDED.status, synced_at = EXCLUDED.synced_at, updated_at = now()`,
            [darshans.newId(), cast.vaikunthamId, cast.imageUrl, cast.position, cast.status, cast.syncedAt]
          );
        }
      });

      res.status(200).json({ message: "Darshan photos synced", count: photos.length });
    } catch (err) {
      console.error("Darshan sync error:", err && err.stack ? err.stack : err);
      res.status(500).json({ message: "Server error", error: err && err.message ? err.message : String(err) });
    }
  },

  list: async (req, res) => {
    try {
      const items = await store.find({ status: "active" }, { sort: { position: 1, _id: 1 } });
      res.status(200).json({ items });
    } catch (err) {
      console.error("Darshan list error:", err && err.stack ? err.stack : err);
      res.status(500).json({ message: "Server error", error: err && err.message ? err.message : String(err) });
    }
  },
};

export { darshanController };
