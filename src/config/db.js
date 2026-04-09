
const mongoose = require("mongoose");


const connectDb = async() =>{
    
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    const opts = {
       useNewUrlParser: true,
       useUnifiedTopology: true,
       serverSelectionTimeoutMS: 5000,
       connectTimeoutMS: 10000,
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