const mongoose = require("mongoose");

// A program people register (and usually pay) for: a kids' course, a
// workshop, a retreat... Created in Admin → Programs. Each program has its own
// custom-designed page on the website; that page finds its program by `slug`
// (e.g. /bala-samskriti → slug "bala-samskriti"), so every registration and
// payment made on the page is counted against this program.
//
// Program fees are NOT donations: no DCC entry and no 80G receipt. A paid (or,
// for a free program, a submitted) registration only gets a WhatsApp
// "thank you for registering" message.
const venueSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    mapUrl: { type: String, trim: true, default: "", maxlength: 500 },
  },
  { _id: false }
);

const programSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 80 },
    tagline: { type: String, trim: true, default: "", maxlength: 200 },
    // Registration fee in rupees. 0 = free program (register only, no payment).
    fee: { type: Number, default: 0, min: 0 },
    startDate: { type: Date, required: true },
    endDate: { type: Date },
    schedule: { type: String, trim: true, default: "", maxlength: 120 }, // "Every Sunday, 10:30 AM to 1:30 PM"
    duration: { type: String, trim: true, default: "", maxlength: 80 }, // "3 months"
    // Kids' programs ask for the child's name and age plus a parent's details.
    forKids: { type: Boolean, default: false },
    ageMin: { type: Number, min: 0 },
    ageMax: { type: Number, min: 0 },
    venues: { type: [venueSchema], default: [] },
    contactPhones: { type: [String], default: [] },
    capacity: { type: Number, default: 0 }, // 0 = no limit (counts paid registrations)
    registrationOpen: { type: Boolean, default: true },
    // Extra line added to the WhatsApp thank-you (e.g. "Please bring a notebook.").
    whatsappNote: { type: String, trim: true, default: "", maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false, collection: "programs" }
);

const programModel = mongoose.model("Program", programSchema);
module.exports = { programModel };
