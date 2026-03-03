const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('./events.db');

// Créer les tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        date TEXT NOT NULL,
        price TEXT,
        currency TEXT DEFAULT 'fc',
        location TEXT,
        color TEXT DEFAULT '#ff0000',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS qr_codes (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL,
        qr_data TEXT NOT NULL,
        numero INTEGER,
        status TEXT DEFAULT 'unused',
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (event_id) REFERENCES events(id)
    )`);
});

// Routes API

// Créer un nouvel événement
app.post('/api/events', (req, res) => {
    const { name, date, price, currency, location, color } = req.body;
    const id = uuidv4();
    
    db.run(`INSERT INTO events (id, name, date, price, currency, location, color) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [name, date, price || '0', currency || 'fc', location || '', color || '#ff0000'],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id, name, date, price, currency, location, color });
        });
});

// Lister tous les événements
app.get('/api/events', (req, res) => {
    db.all("SELECT * FROM events ORDER BY created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Générer QR codes pour un événement
app.post('/api/generate-qr', async (req, res) => {
    const { eventId, quantity, startNumber, prefix } = req.body;
    const qty = parseInt(quantity) || 100;
    const start = parseInt(startNumber) || 1;
    const codePrefix = prefix || 'EVT';
    
    // Récupérer infos événement
    db.get("SELECT * FROM events WHERE id = ?", [eventId], async (err, event) => {
        if (err || !event) {
            return res.status(404).json({ error: 'Evenement non trouve' });
        }
        
        const generated = [];
        
        for (let i = 0; i < qty; i++) {
            const num = start + i;
            const id = uuidv4();
            const random = Math.random().toString(36).substring(2, 6).toUpperCase();
            const code = `${codePrefix}-${num.toString().padStart(4, '0')}-${random}`;
            
            const qrData = JSON.stringify({
                id: id,
                code: code,
                num: num,
                eventId: eventId,
                eventName: event.name,
                eventDate: event.date,
                created: Date.now()
            });
            
            try {
                const qrImage = await QRCode.toDataURL(qrData, {
                    width: 400,
                    margin: 1,
                    errorCorrectionLevel: 'H',
                    color: { dark: '#000000', light: '#ffffff' }
                });
                
                db.run(`INSERT INTO qr_codes (id, event_id, code, qr_data, numero) 
                        VALUES (?, ?, ?, ?, ?)`,
                    [id, eventId, code, qrData, num]);
                
                generated.push({
                    num: num,
                    code: code,
                    qrImage: qrImage,
                    event: event
                });
            } catch (err) {
                console.error(err);
            }
        }
        
        res.json({
            success: true,
            count: generated.length,
            codes: generated,
            event: event
        });
    });
});

// Vérifier QR code
app.post('/api/verify', (req, res) => {
    const { qrData } = req.body;
    
    try {
        const parsed = JSON.parse(qrData);
        
        db.get(`SELECT q.*, e.name as event_name, e.date as event_date, e.color 
                FROM qr_codes q 
                JOIN events e ON q.event_id = e.id 
                WHERE q.code = ?`, [parsed.code], (err, row) => {
            
            if (err || !row) {
                return res.json({ valid: false, error: 'QR code inconnu' });
            }
            
            if (row.status === 'used') {
                return res.json({
                    valid: false,
                    error: 'Billet deja utilise',
                    usedAt: row.used_at,
                    event: row.event_name
                });
            }
            
            db.run(`UPDATE qr_codes SET status = 'used', used_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [row.id]);
            
            res.json({
                valid: true,
                code: row.code,
                num: row.numero,
                event: row.event_name,
                date: row.event_date,
                color: row.color
            });
        });
    } catch (e) {
        res.json({ valid: false, error: 'QR invalide' });
    });
});

// Stats par événement
app.get('/api/stats/:eventId', (req, res) => {
    const { eventId } = req.params;
    
    db.get(`SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END) as unused,
        SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) as used
        FROM qr_codes WHERE event_id = ?`, [eventId], (err, row) => {
        
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { total: 0, unused: 0, used: 0 });
    });
});

// Supprimer un événement (et ses QR)
app.delete('/api/events/:id', (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM qr_codes WHERE event_id = ?", [id], () => {
        db.run("DELETE FROM events WHERE id = ?", [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// Page principale
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Generateur QR sur port ${PORT}`);
});
