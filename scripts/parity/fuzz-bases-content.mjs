// Valid base bodies so fuzz-content.mjs gets past the first validation error on every content route.
import { MongoClient } from "mongodb";

const mc = new MongoClient(process.env.SRC_MONGO_URI);
await mc.connect();
const db = mc.db();
const devotee = await db.collection("templedevotees").findOne({ status: "active" });
const event = await db.collection("events").findOne({});
await mc.close();

export default {
  "POST /gallery/": {
    title: "Fuzz item",
    date: "2026-03-01",
    images: ["https://x.example/a.jpg"],
    category: "c",
    type: "seva",
    status: "active",
  },
  "PUT /gallery/:id": { title: "Fuzz edit", category: "edit" },
  "POST /events/": {
    title: "Fuzz event",
    description: "d",
    date: "2026-05-01",
    category: "General",
    status: "upcoming",
  },
  "PUT /events/:id": { title: "Fuzz event edit", description: "d2", date: "2026-05-02" },
  "POST /events/:id/register": { name: "Fuzz Person", phone: "9000000000" },
  "POST /events/:id/registrations/:token/attendance": {},
  "POST /events/:id/checkin/:token": {},
  "POST /important-dates/": { title: "Fuzz date", date: "2026-06-01", type: "Festival", description: "d" },
  "PUT /important-dates/:id": { title: "Fuzz date edit" },
  "POST /hero-banners/": {
    title: "Fuzz banner",
    desktopImage: "https://x.example/d.jpg",
    mobileImage: "https://x.example/m.jpg",
  },
  "PUT /hero-banners/:id": { title: "Fuzz banner edit", order: 3 },
  "PUT /hero-banners/reorder": { order: [{ id: "000000000000000000000000", order: 2 }] },
  "PUT /media/:id": { name: "fuzz media", tags: "a b" },
  "POST /contact-messages/": { name: "Fuzz", email: "Fuzz@Example.COM", message: "hello", subject: "s", phone: "123" },
  "PUT /contact-messages/:id/status": { status: "read" },
  "POST /volunteers/admin": {
    title: "Fuzz drive",
    description: "d",
    date: "2026-07-01",
    slots: 3,
    formFields: [{ id: "n", label: "Name", required: true }],
  },
  "PUT /volunteers/admin/:id": { title: "Fuzz drive edit", status: "active" },
  "PUT /volunteers/admin/registrations/:id": { status: "approved" },
  "POST /volunteers/:id/register": { responses: { n: "Fuzz" } },
  "POST /festival-donations/": {
    title: "Fuzz festival",
    slug: "fuzz-festival",
    donationOptions: [{ label: "L", amount: 5 }],
  },
  "PUT /festival-donations/:id": { title: "Fuzz festival edit" },
  "POST /festival-showcases/": { title: "Fuzz showcase", slug: "fuzz-showcase" },
  "PUT /festival-showcases/:id": { title: "Fuzz showcase edit" },
  "PUT /donation-page/": {
    heroTitle: "Fuzz hero",
    bankDetails: { bankName: "B" },
    donationOptions: [{ id: 1, category: "X", title: "T", amount: 1 }],
  },
  "PUT /site-content/": { hero: { title: "Fuzz hero" }, construction: { videoUrl: "https://youtu.be/dQw4w9WgXcQ" } },
  "POST /temple-devotees/admin": { name: "Fuzz Devotee", dccEnrolledById: 77 },
  "PUT /temple-devotees/admin/:id": { name: "Fuzz Devotee Edit" },
  "POST /campaigners/register": {
    name: "Fuzz Campaigner",
    email: "fuzz@example.com",
    mobile: "9000000009",
    devoteeId: String(devotee?._id),
    campaignType: "SQFT",
    goalSqft: 5,
  },
  "PUT /campaigners/admin/:id/status": { status: "active" },
  "POST /users/register": { name: "Fuzz User", email: "fuzz.user@example.com", password: "password123", role: "user" },
  "POST /users/register-admin": {
    name: "Fuzz Admin",
    email: "fuzz.admin@example.com",
    password: "password123",
    confirm: "CREATE ADMIN",
  },
  "PUT /users/change-password": { currentPassword: "nope", newPassword: "password456" },
  "PUT /users/update": { name: "Fuzz Admin Name", preferences: { weeklyReport: true } },
  "POST /blogs/": {
    title: "Fuzz post",
    content: "<p>Fuzz content body that is long enough to pass the validator.</p>",
    category: "Recipes",
    status: "draft",
    tags: "a,b",
  },
  "PUT /blogs/:id": {
    title: "Fuzz post edit",
    content: "<p>Fuzz edited body that is long enough to pass the validator.</p>",
  },
  "POST /blogs/:id/approve-deletion": {},
  "POST /blogs/:id/reject-deletion": {},
};
