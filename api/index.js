import { MongoClient } from 'mongodb';
import crypto from 'crypto';

// Global variables to cache our MongoDB connection across execution cycles
let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
    if (cachedClient && cachedDb) {
        return cachedDb;
    }
    const uri = process.env.MONGODB_URI;
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db("MemoryMasterDB");
    
    cachedClient = client;
    cachedDb = db;
    return db;
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

export default async function handler(req, res) {
    // 1. Authorize the incoming request using your custom secret password
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.GAME_SECRET_KEY) {
        return res.status(401).json({ success: false, message: 'Unauthorized pipeline access' });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    try {
        const database = await connectToDatabase();
        const action = req.query.action; // Grab action from url query string

        if (action === 'register') {
            const users = database.collection('users');
            const { username, email, password } = req.body;
            const cleanUser = username.trim();
            const cleanEmail = email.trim();

            const existingUser = await users.findOne({ $or: [{ username: cleanUser }, { email: cleanEmail }] });
            if (existingUser) {
                return res.json({ success: false, message: 'Username or email already exists' });
            }

            const newUser = {
                username: cleanUser,
                email: cleanEmail,
                password: hashPassword(password),
                totalScore: 0,
                gamesPlayed: 0,
                createdDate: new Date().toISOString(),
                stats: {
                    easy: { bestTime: null, bestMoves: null, highScore: 0 },
                    medium: { bestTime: null, bestMoves: null, highScore: 0 },
                    hard: { bestTime: null, bestMoves: null, highScore: 0 }
                }
            };
            await users.insertOne(newUser);
            return res.json({ success: true, message: 'User registered successfully', username: cleanUser });

        } else if (action === 'login') {
            const users = database.collection('users');
            const { username, password } = req.body;
            const user = await users.findOne({ username: username.trim(), password: hashPassword(password) });
            if (user) {
                return res.json({ success: true, message: 'Login successful', username: user.username, stats: user.stats });
            }
            return res.json({ success: false, message: 'Invalid credentials' });

        } else if (action === 'submitScore') {
            const scores = database.collection('scores');
            const users = database.collection('users');
            const { username, level, score, time, moves } = req.body;
            const parsedScore = parseInt(score);

            await scores.insertOne({ username, level, score: parsedScore, time, moves, date: new Date().toISOString() });

            const user = await users.findOne({ username });
            if (!user) return res.json({ success: false, message: 'User not found' });

            let currentStats = user.stats?.[level] || { bestTime: null, bestMoves: null, highScore: 0 };
            let updatedStats = {
                bestTime: (currentStats.bestTime === null || time < currentStats.bestTime) ? time : currentStats.bestTime,
                bestMoves: (currentStats.bestMoves === null || moves < currentStats.bestMoves) ? moves : currentStats.bestMoves,
                highScore: (parsedScore > currentStats.highScore) ? parsedScore : currentStats.highScore
            };

            const updateFields = {
                totalScore: (user.totalScore || 0) + parsedScore,
                gamesPlayed: (user.gamesPlayed || 0) + 1
            };
            updateFields[`stats.${level}`] = updatedStats;

            await users.updateOne({ username }, { $set: updateFields });
            return res.json({ success: true, message: 'Score updated successfully' });

        } else if (action === 'getLeaderboard') {
            const scores = database.collection('scores');
            const { level } = req.body;

            const leaderboard = await scores.aggregate([
                { $match: { level: level || 'easy' } },
                { $sort: { score: -1 } },
                { $group: { _id: "$username", score: { $first: "$score" }, time: { $first: "$time" } } },
                { $project: { _id: 0, username: "$_id", score: 1, time: 1 } },
                { $sort: { score: -1 } },
                { $limit: 50 }
            ]).toArray();

            return res.json({ success: true, data: leaderboard });
        }

        return res.status(400).json({ success: false, message: 'Invalid Route' });

    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}
