
const mongoose = require("mongoose");


const connectDb = async() =>{
    const uri = process.env.MONGO_URI;
    const opts = {
       useNewUrlParser: true,
       useUnifiedTopology: true,
       serverSelectionTimeoutMS: 5000,
       connectTimeoutMS: 10000,
    };
    try {
       await mongoose.connect(uri, opts);
       console.log("MongoDB connected");
    } catch (error) {
        console.error("MongoDB connection error:", error);
        throw error;
    }
}

module.exports = { connectDb}