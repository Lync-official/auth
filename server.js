require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { MongoClient } = require('mongodb');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'secret';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

const app = express();
let usersCollection, productsCollection, ordersCollection;

// DB接続
async function initDB() {
    if (!MONGODB_URI) return;
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        console.log('MongoDB Connected');
        const db = client.db();
        usersCollection = db.collection('users');
        productsCollection = db.collection('products');
        ordersCollection = db.collection('orders');
    } catch (e) { console.error('DB Error', e); }
}

// ミドルウェア
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

if (MONGODB_URI) {
    app.use(session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'sessions' }),
        cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 7*24*60*60*1000 }
    }));
} else {
    app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false }));
}

// ルート
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.get('/auth/login', (req, res) => {
    const url = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
    res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('No code');
    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI
            })
        });
        const tokenData = await tokenRes.json();
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const user = await userRes.json();

        if (usersCollection) {
            await usersCollection.updateOne(
                { discordId: user.id },
                { $set: { username: user.username, globalName: user.global_name, avatar: user.avatar }, $setOnInsert: { balance: 0, discordId: user.id } },
                { upsert: true }
            );
        }
        req.session.user = { id: user.id, username: user.username, globalName: user.global_name, avatar: user.avatar };

        // ログイン後はショップ画面へ
        const frontendUrl = process.env.FRONTEND_URL || 'https://kura-monster.github.io/kura/shop/index.html';
        res.redirect(frontendUrl);
    } catch (err) {
        console.error(err);
        res.status(500).send('Auth Error');
    }
});

app.get('/me', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    res.json(req.session.user);
});

app.get('/api/products', async (req, res) => {
    if (!productsCollection) return res.status(500).json({ error: 'No DB' });
    try { res.json(await productsCollection.find({}).toArray()); }
    catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/purchase', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!usersCollection || !productsCollection) return res.status(500).json({ error: 'No DB' });
    const { productId } = req.body;
    try {
        const product = await productsCollection.findOne({ _id: productId });
        if (!product) return res.status(404).json({ error: 'Not found' });
        const user = await usersCollection.findOne({ discordId: req.session.user.id });
        if (!user || user.balance < product.price) return res.status(400).json({ error: 'Balance low' });

        await usersCollection.updateOne({ discordId: req.session.user.id }, { $inc: { balance: -product.price } });
        await ordersCollection.insertOne({ userId: user._id, discordId: req.session.user.id, productId: product._id, price: product.price, date: new Date() });

        res.json({ success: true, balance: user.balance - product.price });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// 起動
async function start() {
    await initDB();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`URL: ${BASE_URL}`);
    });
}
start();
