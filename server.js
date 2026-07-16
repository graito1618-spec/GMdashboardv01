// ================================================================
// GAJAH MAS 2026 - Backend API
// Dibuat supaya cocok 1:1 dengan class `ApiTable` di frontend
// (dashboard-kerja.html, dashboard-laporan.html, dashboard-data.html).
//
// Kontrak endpoint per tabel (lihat class ApiTable di frontend):
//   POST   /api/:table            -> tambah 1 record, balikin {id}
//   POST   /api/:table/bulk       -> tambah banyak record sekaligus
//   GET    /api/:table            -> ambil semua record (array)
//   GET    /api/:table/count      -> {count}
//   GET    /api/:table/query?field=&value= -> filter sederhana
//   DELETE /api/:table            -> hapus semua record di tabel itu
//   DELETE /api/:table/:id        -> hapus 1 record
//   PUT    /api/:table/:id        -> update sebagian field record
//
// Auth (cookie session, dipakai lintas-domain GitHub Pages <-> Railway):
//   POST /api/auth/register {username,password}
//   POST /api/auth/login    {username,password}
//   POST /api/auth/logout
//   GET  /api/auth/status   -> {loggedIn, username}
// ================================================================

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || 'ganti-secret-ini-di-railway-variables';

// Daftar origin frontend yang boleh akses (isi di Railway -> Variables -> ALLOWED_ORIGINS)
// Boleh lebih dari 1, dipisah koma, contoh:
// https://graito1618-spec.github.io,http://localhost:5500
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// Nama-nama tabel yang dipakai frontend (whitelist demi keamanan,
// supaya endpoint generik tidak bisa dipakai untuk tabel sembarangan).
const ALLOWED_TABLES = new Set([
    'sales',
    'cashIncome',
    'printHistory',
    'trash',
    'piutangNotes',
    'cashNotes',
    'cetakTagihanMap',
    'inputHarian',
    'pengeluaran'
]);

// Railway kadang otomatis menyuntik DATABASE_URL (private/internal, cuma
// bisa diakses dari jaringan privat Railway) walau kita pakai referensi ke
// DATABASE_PUBLIC_URL secara eksplisit. Karena jaringan privat internal
// kadang tidak resolve (ENOTFOUND postgres.railway.internal), di sini kita
// utamakan DATABASE_PUBLIC_URL dulu (selalu bisa diakses lewat proxy publik).
const CONNECTION_STRING = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;

if (!CONNECTION_STRING) {
    console.error('❌ ENV DATABASE_URL / DATABASE_PUBLIC_URL belum ada. Tambahkan plugin PostgreSQL di Railway lalu hubungkan variable-nya ke service ini.');
}

const pool = new Pool({
    connectionString: CONNECTION_STRING,
    ssl: CONNECTION_STRING && (CONNECTION_STRING.includes('railway') || CONNECTION_STRING.includes('rlwy.net')) ? { rejectUnauthorized: false } : (NODE_ENV === 'production' ? { rejectUnauthorized: false } : false)
});

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT now()
        );
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS records (
            id SERIAL PRIMARY KEY,
            table_name TEXT NOT NULL,
            data JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT now()
        );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_records_table_name ON records (table_name);`);
    console.log('✅ Tabel database siap (users, records).');
}

const app = express();

// Railway ada di belakang reverse proxy -> perlu ini supaya cookie "secure" jalan
app.set('trust proxy', 1);

app.use(express.json({ limit: '15mb' }));

app.use(cors({
    origin: function(origin, callback) {
        // izinkan request tanpa origin (curl, healthcheck, dsb)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.length === 0) {
            console.warn('⚠️  ALLOWED_ORIGINS belum di-set, sementara mengizinkan semua origin. Isi env ALLOWED_ORIGINS untuk produksi.');
            return callback(null, true);
        }
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error('Origin tidak diizinkan oleh CORS: ' + origin));
    },
    credentials: true
}));

app.use(session({
    store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    name: 'gm2026.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: NODE_ENV === 'production',
        sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 hari
    }
}));

function requireAuth(req, res, next) {
    if (req.session && req.session.userId) return next();
    return res.status(401).json({ error: 'Belum login / sesi berakhir.' });
}

function checkTable(req, res, next) {
    if (!ALLOWED_TABLES.has(req.params.table)) {
        return res.status(404).json({ error: 'Tabel tidak dikenal: ' + req.params.table });
    }
    next();
}

// ---------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password || String(password).length < 6) {
            return res.status(400).json({ error: 'Username & password (min 6 karakter) wajib diisi.' });
        }
        const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (existing.rows.length) {
            return res.status(409).json({ error: 'Username sudah dipakai.' });
        }
        const hash = await bcrypt.hash(password, 10);
        const r = await pool.query(
            'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
            [username, hash]
        );
        req.session.userId = r.rows[0].id;
        req.session.username = username;
        res.json({ ok: true, username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal daftar: ' + err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ error: 'Username & password wajib diisi.' });
        }
        const r = await pool.query('SELECT id, password_hash FROM users WHERE username = $1', [username]);
        if (!r.rows.length) return res.status(401).json({ error: 'Username atau password salah.' });
        const ok = await bcrypt.compare(password, r.rows[0].password_hash);
        if (!ok) return res.status(401).json({ error: 'Username atau password salah.' });
        req.session.userId = r.rows[0].id;
        req.session.username = username;
        res.json({ ok: true, username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal login: ' + err.message });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('gm2026.sid');
        res.json({ ok: true });
    });
});

app.get('/api/auth/status', (req, res) => {
    if (req.session && req.session.userId) {
        return res.json({ loggedIn: true, username: req.session.username });
    }
    res.json({ loggedIn: false });
});

// ---------------------------------------------------------------
// TABEL GENERIK (sales, cashIncome, printHistory, trash, piutangNotes,
// cashNotes, cetakTagihanMap, inputHarian, pengeluaran)
// PENTING: rute spesifik (bulk/count/query) didaftarkan SEBELUM rute
// generik supaya tidak ketabrak oleh /:id.
// ---------------------------------------------------------------

app.post('/api/:table/bulk', requireAuth, checkTable, async (req, res) => {
    try {
        const arr = Array.isArray(req.body) ? req.body : [];
        if (!arr.length) return res.json({ ok: true, inserted: 0 });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const item of arr) {
                const clean = Object.assign({}, item);
                delete clean.id;
                await client.query(
                    'INSERT INTO records (table_name, data) VALUES ($1, $2::jsonb)',
                    [req.params.table, JSON.stringify(clean)]
                );
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
        res.json({ ok: true, inserted: arr.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal bulk insert: ' + err.message });
    }
});

app.get('/api/:table/count', requireAuth, checkTable, async (req, res) => {
    try {
        const r = await pool.query('SELECT COUNT(*)::int AS count FROM records WHERE table_name = $1', [req.params.table]);
        res.json({ count: r.rows[0].count });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal hitung data: ' + err.message });
    }
});

app.get('/api/:table/query', requireAuth, checkTable, async (req, res) => {
    try {
        const { field, value } = req.query;
        if (!field) return res.status(400).json({ error: 'Parameter field wajib diisi.' });
        const r = await pool.query(
            'SELECT id, data FROM records WHERE table_name = $1 AND data->>$2 = $3 ORDER BY id ASC',
            [req.params.table, field, value]
        );
        res.json(r.rows.map(row => Object.assign({}, row.data, { id: row.id })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal query data: ' + err.message });
    }
});

app.post('/api/:table', requireAuth, checkTable, async (req, res) => {
    try {
        const clean = Object.assign({}, req.body || {});
        delete clean.id;
        const r = await pool.query(
            'INSERT INTO records (table_name, data) VALUES ($1, $2::jsonb) RETURNING id',
            [req.params.table, JSON.stringify(clean)]
        );
        res.json({ id: r.rows[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal simpan data: ' + err.message });
    }
});

app.get('/api/:table', requireAuth, checkTable, async (req, res) => {
    try {
        const r = await pool.query('SELECT id, data FROM records WHERE table_name = $1 ORDER BY id ASC', [req.params.table]);
        res.json(r.rows.map(row => Object.assign({}, row.data, { id: row.id })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal ambil data: ' + err.message });
    }
});

app.delete('/api/:table/:id(\\d+)', requireAuth, checkTable, async (req, res) => {
    try {
        await pool.query('DELETE FROM records WHERE table_name = $1 AND id = $2', [req.params.table, req.params.id]);
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal hapus data: ' + err.message });
    }
});

app.put('/api/:table/:id(\\d+)', requireAuth, checkTable, async (req, res) => {
    try {
        const changes = req.body || {};
        const r = await pool.query(
            'UPDATE records SET data = data || $3::jsonb WHERE table_name = $1 AND id = $2 RETURNING id',
            [req.params.table, req.params.id, JSON.stringify(changes)]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'Data tidak ditemukan.' });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal update data: ' + err.message });
    }
});

app.delete('/api/:table', requireAuth, checkTable, async (req, res) => {
    try {
        await pool.query('DELETE FROM records WHERE table_name = $1', [req.params.table]);
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal hapus semua data: ' + err.message });
    }
});

// ---------------------------------------------------------------
app.get('/', (req, res) => {
    res.json({ ok: true, app: 'GAJAH MAS 2026 API', time: new Date().toISOString() });
});

app.get('/health', (req, res) => res.json({ ok: true }));

initDb()
    .then(() => {
        app.listen(PORT, () => console.log('🚀 Server jalan di port ' + PORT));
    })
    .catch(err => {
        console.error('❌ Gagal inisialisasi database:', err);
        process.exit(1);
    });
