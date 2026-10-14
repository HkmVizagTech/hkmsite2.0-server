import sanitizeHtml from "sanitize-html";

export const BLOG_CATEGORIES = [
  "Krishna Katha",
  "Vaishnava Songs and Prayers",
  "Our Acharyas",
  "Spiritual Knowledge",
  "Sacred Festivals & Occasions",
  "Spiritual News & Events",
  "Spiritual Charity",
  "Timeless Wisdom",
  "Divine Poetics",
  "Krishna Consciousness",
  "Recipes",
  "Pilgrimage",
  "Other",
];

const SAFE_STYLE_VALUE = [/^(?!.*(?:url\(|expression|javascript:|@import|behavior)).*$/i];
const STYLE_PROPS = [
  "color",
  "background",
  "background-color",
  "font",
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "text-align",
  "text-decoration",
  "text-indent",
  "line-height",
  "letter-spacing",
  "white-space",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "aspect-ratio",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
  "border-collapse",
  "border-radius",
  "float",
  "display",
  "vertical-align",
  "list-style-type",
  "object-fit",
  "word-break",
  "overflow-wrap",
];
const allowedStyles = { "*": Object.fromEntries(STYLE_PROPS.map((p) => [p, SAFE_STYLE_VALUE])) };

const COMMON_ATTRS = ["class", "style", "id", "dir", "lang", "title", "data-*"];

const SANITIZE_OPTIONS = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    "h1",
    "h2",
    "img",
    "figure",
    "figcaption",
    "picture",
    "source",
    "u",
    "s",
    "mark",
    "del",
    "ins",
    "sub",
    "sup",
    "caption",
    "colgroup",
    "col",
    "iframe",
    "oembed",
    "input",
    "span",
    "section",
    "hr",
    "details",
    "summary",
  ],
  allowedAttributes: {
    "*": COMMON_ATTRS,
    a: ["href", "name", "target", "rel", "download", ...COMMON_ATTRS],
    img: ["src", "srcset", "sizes", "alt", "width", "height", "loading", ...COMMON_ATTRS],
    source: ["srcset", "sizes", "type", "media"],
    td: ["colspan", "rowspan", "headers", ...COMMON_ATTRS],
    th: ["colspan", "rowspan", "scope", "headers", ...COMMON_ATTRS],
    col: ["span", "width", ...COMMON_ATTRS],
    colgroup: ["span", ...COMMON_ATTRS],
    ol: ["start", "type", "reversed", ...COMMON_ATTRS],
    li: ["value", ...COMMON_ATTRS],
    input: ["type", "checked", "disabled", ...COMMON_ATTRS],
    oembed: ["url"],
    iframe: [
      "src",
      "width",
      "height",
      "frameborder",
      "allow",
      "allowfullscreen",
      "referrerpolicy",
      "loading",
      ...COMMON_ATTRS,
    ],
    details: ["open", ...COMMON_ATTRS],
  },
  allowedStyles,
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  allowProtocolRelative: false,
  allowedIframeHostnames: ["www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "player.vimeo.com"],
  allowIframeRelativeUrls: false,
  transformTags: {
    a: (tagName, attribs) => {
      if (attribs.target === "_blank" && !attribs.rel) attribs.rel = "noopener noreferrer";
      return { tagName, attribs };
    },
    input: (tagName, attribs) => ({ tagName, attribs: { ...attribs, type: "checkbox", disabled: "disabled" } }),
  },
};

export const sanitizeBlogHtml = (html) => sanitizeHtml(String(html ?? ""), SANITIZE_OPTIONS);

export const computeReadTime = (content) => {
  const text = String(content || "")
    .replace(/<[^>]*>/g, " ")
    .trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
};
