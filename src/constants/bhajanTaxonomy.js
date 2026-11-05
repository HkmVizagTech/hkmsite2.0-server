// Human labels for the bhajan taxonomy slugs. Single source of truth: the
// public GET /bhajans/meta endpoint returns these and the client never
// hardcodes them. Add a slug here to make a new filter appear.

const categories = {
  "lord-sri-krishna": "Lord Sri Krishna",
  "sri-chaitanya-mahaprabhu": "Sri Chaitanya Mahaprabhu",
  "sri-nityananda-prabhu": "Sri Nityananda Prabhu",
  "srimati-radharani": "Srimati Radharani",
  "spiritual-master": "Guru and Spiritual Master",
  "glories-of-holy-name": "Glories of the Holy Name",
  "kripa-prarthana": "Kripa Prarthana (Prayers for Mercy)",
  "dependency": "Dependency on the Lord",
  "narasimha-prayers": "Lord Narasimha Prayers",
  "stotram-ashtakam": "Stotrams and Ashtakams",
  "pranam-mantras": "Pranam Mantras",
  "other": "Other Bhajans",
};

const moods = {
  "glorification-praise": "Glorification and Praise",
  "humility": "Humility",
  "separation": "Separation",
  "reverence": "Reverence",
  "teachings-and-guidance": "Teachings and Guidance",
  "deep-longing": "Deep Longing",
  "self-surrender": "Self-Surrender",
  "longing-aspiration": "Longing and Aspiration",
};

const festivals = {
  "ekadashi": "Ekadashi",
  "gaura-purnima": "Gaura Purnima",
  "govardhan-puja": "Govardhan Puja",
  "janmashtami": "Janmashtami",
  "kartik-damodar": "Kartik (Damodar Month)",
  "narasimha-chaturdashi": "Narasimha Chaturdashi",
  "nityananda-trayodashi": "Nityananda Trayodashi",
  "radhashtami": "Radhashtami",
  "rama-navami": "Rama Navami",
  "ratha-yatra": "Ratha Yatra",
  "vyasa-puja": "Vyasa Puja",
};

const labelFor = (group, slug) =>
  group[slug] ||
  String(slug)
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

module.exports = { bhajanTaxonomy: { categories, moods, festivals }, labelFor };
