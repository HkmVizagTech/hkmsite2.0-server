const mongoose = require("mongoose");
const { darshanModel } = require("../models/darshan.model");

const darshanController = {
  // POST /darshan/sync — internal endpoint hit by the Vaikuntham admin
  // panel every time an admin adds, edits, blocks, or deletes a daily
  // darshan photo there. Server-to-server only: auth is a shared secret
  // header, not a user JWT — same pattern as the existing
  // /api/internal/send-pending-reminders and /api/internal/resend-receipts
  // routes in app.js.
  //
  // The payload is always the FULL current active set (not a single-photo
  // diff), so this replaces the site's whole darshan set atomically: any
  // doc whose vaikunthamId isn't in the incoming list gets removed, and
  // everything in the list gets upserted. A missed or out-of-order call
  // self-corrects on the very next sync instead of causing drift.
  sync: async (req, res) => {
    try {
      const secret = req.headers["x-darshan-sync-secret"];
      if (!process.env.DARSHAN_SYNC_SECRET || secret !== process.env.DARSHAN_SYNC_SECRET) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const photos = Array.isArray(req.body.photos) ? req.body.photos : [];
      const incomingIds = photos
        .map((p) => Number(p.id))
        .filter((id) => Number.isFinite(id));

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await darshanModel.deleteMany(
            { vaikunthamId: { $nin: incomingIds } },
            { session }
          );

          for (let i = 0; i < photos.length; i++) {
            const p = photos[i];
            const vaikunthamId = Number(p.id);
            if (!Number.isFinite(vaikunthamId) || !p.imageUrl) continue;

            await darshanModel.findOneAndUpdate(
              { vaikunthamId },
              {
                vaikunthamId,
                imageUrl: p.imageUrl,
                position: typeof p.position === "number" ? p.position : i,
                status: "active",
                syncedAt: new Date(),
              },
              { upsert: true, session, setDefaultsOnInsert: true }
            );
          }
        });
      } finally {
        session.endSession();
      }

      res.status(200).json({ message: "Darshan photos synced", count: photos.length });
    } catch (err) {
      console.error("Darshan sync error:", err && err.stack ? err.stack : err);
      res.status(500).json({ message: "Server error", error: err && err.message ? err.message : String(err) });
    }
  },

  // GET /darshan — public, used by the homepage's "Today's Darshan" section.
  list: async (req, res) => {
    try {
      const items = await darshanModel.find({ status: "active" }).sort({ position: 1 });
      res.status(200).json({ items });
    } catch (err) {
      console.error("Darshan list error:", err && err.stack ? err.stack : err);
      res.status(500).json({ message: "Server error", error: err && err.message ? err.message : String(err) });
    }
  },
};

module.exports = { darshanController };
