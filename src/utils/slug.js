// URL slug from a title: "Gita Jayanti 2026!" -> "gita-jayanti-2026".
// Indian-script titles are turned into English letters first (toEnglish), so
// a Telugu or Hindi title still gives a readable address.
import { toEnglish } from "./toEnglish.js";

function slugify(text, maxLength = 80) {
  return String(toEnglish(String(text || "")) || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
}

export { slugify };
