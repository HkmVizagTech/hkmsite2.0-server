
const mongoose = require("mongoose");


const connectDb = async() =>{
    
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    const opts = {
       // Connection pool — default is 5, which means under burst traffic
       // (e.g. 200 concurrent users after a WhatsApp broadcast) most
       // requests queue behind 5 DB operations instead of running in
       // parallel. 50 is safe for MongoDB Atlas M10+ (which supports
       // 1,500 connections max); keeps the pool well under Atlas limits
       // while handling your real campaign burst traffic comfortably.
       maxPoolSize: 50,
       minPoolSize: 5,
       serverSelectionTimeoutMS: 5000,
       connectTimeoutMS: 10000,
       socketTimeoutMS: 45000,
    };
    try {
       if (!uri) {
           throw new Error('MongoDB connection string not provided. Set MONGODB_URI or MONGO_URI environment variable.');
       }
       await mongoose.connect(uri, opts);
       console.log("MongoDB connected");
    } catch (error) {
        console.error("MongoDB connection error:", error);
        throw error;
    }
}

module.exports = { connectDb}