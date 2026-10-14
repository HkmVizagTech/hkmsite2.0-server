import { darshans } from "../db/tables.js";
import { tx } from "../db/pg.js";

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
          await client.query(
            `INSERT INTO darshans (id, vaikuntham_id, image_url, position, status, synced_at)
             VALUES ($1, $2, $3, $4, 'active', now())
             ON CONFLICT (vaikuntham_id) DO UPDATE
               SET image_url = EXCLUDED.image_url, position = EXCLUDED.position,
                   status = 'active', synced_at = now(), updated_at = now()`,
            [darshans.newId(), vaikunthamId, p.imageUrl, typeof p.position === "number" ? p.position : i]
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
      const items = await darshans.find({ status: "active" }, { sort: { position: 1, _id: 1 } });
      res.status(200).json({ items });
    } catch (err) {
      console.error("Darshan list error:", err && err.stack ? err.stack : err);
      res.status(500).json({ message: "Server error", error: err && err.message ? err.message : String(err) });
    }
  },
};

export { darshanController };
