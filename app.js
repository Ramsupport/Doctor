const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ─── Security Headers ────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false });
const JWT_SECRET = process.env.JWT_SECRET || 'clinic-mgr-secret-change-me';
const JWT_EXPIRY = '8h';

// ─── Database Init ───────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doctors (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      qualifications VARCHAR(255) DEFAULT '',
      registration_number VARCHAR(100) DEFAULT '',
      clinic_name VARCHAR(255) DEFAULT '',
      clinic_address TEXT DEFAULT '',
      clinic_phone VARCHAR(20) DEFAULT '',
      consultation_fee DECIMAL(10,2) DEFAULT 500,
      role VARCHAR(20) DEFAULT 'doctor',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS patients (
      id SERIAL PRIMARY KEY,
      doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL, dob DATE, gender VARCHAR(10),
      contact VARCHAR(20) NOT NULL, email VARCHAR(255), address TEXT,
      blood_group VARCHAR(5), allergies TEXT, medical_history TEXT, notes TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS visits (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
      doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
      visit_date TIMESTAMPTZ DEFAULT NOW(),
      chief_complaint TEXT, examination TEXT, diagnosis TEXT, notes TEXT,
      bp_systolic INTEGER, bp_diastolic INTEGER, pulse INTEGER,
      temperature DECIMAL(4,1), weight DECIMAL(5,1), height DECIMAL(5,1), spo2 INTEGER,
      follow_up_date DATE, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS prescriptions (
      id SERIAL PRIMARY KEY,
      visit_id INTEGER REFERENCES visits(id) ON DELETE CASCADE,
      patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
      medicines JSONB DEFAULT '[]', advice TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS charges (
      id SERIAL PRIMARY KEY,
      visit_id INTEGER REFERENCES visits(id) ON DELETE SET NULL,
      patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
      doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
      description VARCHAR(255) NOT NULL, amount DECIMAL(10,2) NOT NULL,
      payment_mode VARCHAR(20) DEFAULT 'cash', payment_status VARCHAR(20) DEFAULT 'paid',
      charge_date TIMESTAMPTZ DEFAULT NOW(), notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
      doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
      appointment_date DATE NOT NULL, appointment_time TIME,
      status VARCHAR(20) DEFAULT 'scheduled', reason TEXT, notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(doctor_id)
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
      description VARCHAR(255) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      expense_date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_patients_doctor ON patients(doctor_id);
    CREATE INDEX IF NOT EXISTS idx_patients_contact ON patients(contact);
    CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(LOWER(name));
    CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id);
    CREATE INDEX IF NOT EXISTS idx_visits_doctor ON visits(doctor_id);
    CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(visit_date);
    CREATE INDEX IF NOT EXISTS idx_charges_doctor ON charges(doctor_id);
    CREATE INDEX IF NOT EXISTS idx_charges_date ON charges(charge_date);
    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appointment_date);
    CREATE INDEX IF NOT EXISTS idx_appointments_doctor ON appointments(doctor_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_doctor ON expenses(doctor_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
  `);

  // No default admin — doctors self-register via the Register page

  // VAPID setup
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails('mailto:support@gizmohub.co.in', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    console.log('VAPID push configured');
  } else {
    console.log('VAPID keys not set — push notifications disabled. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars.');
  }

  console.log('Database initialized');
}

// ─── Auth Middleware ──────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.doctorId = decoded.id;
    req.doctorRole = decoded.role;
    next();
  } catch (e) { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ─── Push Notification Helper ────────────────────────────────────
async function sendPushToDoctor(doctorId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  try {
    const { rows } = await pool.query('SELECT subscription FROM push_subscriptions WHERE doctor_id=$1', [doctorId]);
    if (!rows.length) return;
    const sub = rows[0].subscription;
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      await pool.query('DELETE FROM push_subscriptions WHERE doctor_id=$1', [doctorId]);
    }
    console.error('Push error:', e.message);
  }
}

async function sendPushToAll(payload) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  try {
    const { rows } = await pool.query('SELECT doctor_id, subscription FROM push_subscriptions');
    for (const row of rows) {
      try {
        await webpush.sendNotification(row.subscription, JSON.stringify(payload));
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await pool.query('DELETE FROM push_subscriptions WHERE doctor_id=$1', [row.doctor_id]);
        }
      }
    }
  } catch (e) { console.error('Push broadcast error:', e.message); }
}

// ─── Auth Routes ─────────────────────────────────────────────────
// PUBLIC self-registration — any doctor can register

// ─── Rate Limiter (login brute-force protection) ─────────────────
const loginAttempts = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const window = 60000; // 1 minute
  const maxAttempts = 5;
  const entry = loginAttempts.get(ip) || { count: 0, start: now };
  if (now - entry.start > window) { entry.count = 0; entry.start = now; }
  entry.count++;
  loginAttempts.set(ip, entry);
  if (entry.count > maxAttempts) return res.status(429).json({ error: 'Too many login attempts. Please wait 1 minute.' });
  next();
}
// Clean up rate limiter every 5 minutes
setInterval(() => { const now = Date.now(); for (const [k, v] of loginAttempts) { if (now - v.start > 60000) loginAttempts.delete(k); } }, 300000);

app.post('/api/auth/login', rateLimit, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    
    // Convert username to lowercase to match registration format
    const { rows } = await pool.query('SELECT * FROM doctors WHERE username=$1 AND is_active=true', [username.toLowerCase()]);
    
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const doc = rows[0];
    const valid = await bcrypt.compare(password, doc.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: doc.id, username: doc.username, role: doc.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.json({ token, doctor: { id: doc.id, name: doc.name, username: doc.username, role: doc.role, clinic_name: doc.clinic_name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, name, qualifications, clinic_name } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: 'Name, username and password are required' });
    if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers and underscore' });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO doctors (username,password_hash,name,qualifications,clinic_name) VALUES ($1,$2,$3,$4,$5) RETURNING id,username,name,role`,
      [username.toLowerCase(), hash, name, qualifications || '', clinic_name || '']
    );
    // Auto-login after registration
    const doc = rows[0];
    const token = jwt.sign({ id: doc.id, username: doc.username, role: doc.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.json({ token, doctor: doc });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/change-password', auth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const { rows } = await pool.query('SELECT password_hash FROM doctors WHERE id=$1', [req.doctorId]);
    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE doctors SET password_hash=$1 WHERE id=$2', [hash, req.doctorId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Push Notification Routes ────────────────────────────────────
app.get('/api/push/vapid-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(404).json({ error: 'Push not configured' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', auth, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'Subscription required' });
    await pool.query(
      `INSERT INTO push_subscriptions (doctor_id,subscription) VALUES ($1,$2)
       ON CONFLICT (doctor_id) DO UPDATE SET subscription=$2, created_at=NOW()`,
      [req.doctorId, JSON.stringify(subscription)]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/push/subscribe', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM push_subscriptions WHERE doctor_id=$1', [req.doctorId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Doctor Profile ──────────────────────────────────────────────
app.get('/api/profile', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id,username,name,qualifications,registration_number,clinic_name,clinic_address,clinic_phone,consultation_fee,role,created_at FROM doctors WHERE id=$1', [req.doctorId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/profile', auth, async (req, res) => {
  try {
    const { name, qualifications, registration_number, clinic_name, clinic_address, clinic_phone, consultation_fee } = req.body;
    const { rows } = await pool.query(
      `UPDATE doctors SET name=$1,qualifications=$2,registration_number=$3,clinic_name=$4,clinic_address=$5,clinic_phone=$6,consultation_fee=$7
       WHERE id=$8 RETURNING id,username,name,qualifications,registration_number,clinic_name,clinic_address,clinic_phone,consultation_fee,role`,
      [name, qualifications, registration_number, clinic_name, clinic_address, clinic_phone, consultation_fee || 500, req.doctorId]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Dashboard ───────────────────────────────────────────────────
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const did = req.doctorId;
    const today = new Date().toISOString().split('T')[0];
    const [totalPatients, todayAppointments, todayRevenue, pendingPayments, recentPatients, upcomingAppts] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM patients WHERE doctor_id=$1 AND is_active=true', [did]),
      pool.query("SELECT COUNT(*) FROM appointments WHERE doctor_id=$1 AND appointment_date=$2 AND status!='cancelled'", [did, today]),
      pool.query("SELECT COALESCE(SUM(amount),0) as total FROM charges WHERE doctor_id=$1 AND charge_date::date=$2 AND payment_status='paid'", [did, today]),
      pool.query("SELECT COALESCE(SUM(amount),0) as total FROM charges WHERE doctor_id=$1 AND payment_status='pending'", [did]),
      pool.query('SELECT id,name,contact,created_at FROM patients WHERE doctor_id=$1 AND is_active=true ORDER BY created_at DESC LIMIT 5', [did]),
      pool.query(`SELECT a.*,p.name as patient_name,p.contact as patient_contact FROM appointments a JOIN patients p ON a.patient_id=p.id
        WHERE a.doctor_id=$1 AND a.appointment_date=$2 AND a.status!='cancelled' ORDER BY a.appointment_time ASC NULLS LAST`, [did, today])
    ]);
    res.json({
      total_patients: parseInt(totalPatients.rows[0].count),
      today_appointments: parseInt(todayAppointments.rows[0].count),
      today_revenue: parseFloat(todayRevenue.rows[0].total),
      pending_payments: parseFloat(pendingPayments.rows[0].total),
      recent_patients: recentPatients.rows,
      upcoming_appointments: upcomingAppts.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Patients ────────────────────────────────────────────────────
app.get('/api/patients', auth, async (req, res) => {
  try {
    const did = req.doctorId;
    const { search, page = 1, limit = 15 } = req.query;
    const offset = (page - 1) * limit;
    let query, countQuery, params;
    if (search && search.trim()) {
      // Replace spaces with wildcard to allow searching multiple disjointed terms
      const s = `%${search.trim().replace(/\s+/g, '%')}%`;
      const searchCond = `CONCAT_WS(' ', name, contact, email, address, blood_group, allergies, medical_history, notes) ILIKE $2`;
      query = `SELECT * FROM patients WHERE doctor_id=$1 AND is_active=true AND ${searchCond} ORDER BY name ASC LIMIT $3 OFFSET $4`;
      countQuery = `SELECT COUNT(*) FROM patients WHERE doctor_id=$1 AND is_active=true AND ${searchCond}`;
      params = [did, s, limit, offset];
    } else {
      query = `SELECT * FROM patients WHERE doctor_id=$1 AND is_active=true ORDER BY updated_at DESC LIMIT $2 OFFSET $3`;
      countQuery = `SELECT COUNT(*) FROM patients WHERE doctor_id=$1 AND is_active=true`;
      params = [did, limit, offset];
    }
    const [{ rows }, countRes] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, search?.trim() ? [did, `%${search.trim()}%`] : [did])
    ]);
    res.json({ patients: rows, total: parseInt(countRes.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/patients/search/quick', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const s = `%${q.trim().replace(/\s+/g, '%')}%`;
    const { rows } = await pool.query(
      `SELECT id,name,contact,gender FROM patients WHERE doctor_id=$1 AND is_active=true AND CONCAT_WS(' ', name, contact, email, address, blood_group, allergies, medical_history, notes) ILIKE $2 LIMIT 10`,
      [req.doctorId, s]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/patients/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM patients WHERE id=$1 AND doctor_id=$2', [req.params.id, req.doctorId]);
    if (!rows.length) return res.status(404).json({ error: 'Patient not found' });
    const stats = await pool.query('SELECT COUNT(*) as visit_count,MAX(visit_date) as last_visit FROM visits WHERE patient_id=$1 AND doctor_id=$2', [req.params.id, req.doctorId]);
    const tc = await pool.query(`SELECT COALESCE(SUM(amount),0) as total_charges,COALESCE(SUM(CASE WHEN payment_status='pending' THEN amount ELSE 0 END),0) as pending FROM charges WHERE patient_id=$1 AND doctor_id=$2`, [req.params.id, req.doctorId]);
    res.json({ ...rows[0], visit_count: parseInt(stats.rows[0].visit_count), last_visit: stats.rows[0].last_visit, total_charges: parseFloat(tc.rows[0].total_charges), pending_amount: parseFloat(tc.rows[0].pending) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/patients', auth, async (req, res) => {
  try {
    const { name, dob, gender, contact, email, address, blood_group, allergies, medical_history, notes } = req.body;
    if (!name || !contact) return res.status(400).json({ error: 'Name and contact are required' });
    const dup = await pool.query('SELECT id,name FROM patients WHERE contact=$1 AND doctor_id=$2 AND is_active=true', [contact, req.doctorId]);
    if (dup.rows.length) return res.status(409).json({ error: `Patient "${dup.rows[0].name}" already exists with this contact`, existing_id: dup.rows[0].id });
    const { rows } = await pool.query(
      `INSERT INTO patients (doctor_id,name,dob,gender,contact,email,address,blood_group,allergies,medical_history,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.doctorId, name, dob||null, gender, contact, email, address, blood_group, allergies, medical_history, notes]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/patients/:id', auth, async (req, res) => {
  try {
    const { name, dob, gender, contact, email, address, blood_group, allergies, medical_history, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE patients SET name=$1,dob=$2,gender=$3,contact=$4,email=$5,address=$6,blood_group=$7,allergies=$8,medical_history=$9,notes=$10,updated_at=NOW()
       WHERE id=$11 AND doctor_id=$12 RETURNING *`,
      [name, dob||null, gender, contact, email, address, blood_group, allergies, medical_history, notes, req.params.id, req.doctorId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Patient not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/patients/:id', auth, async (req, res) => {
  try {
    await pool.query('UPDATE patients SET is_active=false,updated_at=NOW() WHERE id=$1 AND doctor_id=$2', [req.params.id, req.doctorId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Visits ──────────────────────────────────────────────────────
app.get('/api/patients/:id/visits', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.*, (SELECT json_agg(row_to_json(p)) FROM prescriptions p WHERE p.visit_id=v.id) as prescriptions,
       (SELECT json_agg(row_to_json(c)) FROM charges c WHERE c.visit_id=v.id) as charges
       FROM visits v WHERE v.patient_id=$1 AND v.doctor_id=$2 ORDER BY v.visit_date DESC`, [req.params.id, req.doctorId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/visits/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT v.*,p.name as patient_name,p.contact as patient_contact,p.dob as patient_dob,p.gender as patient_gender,p.allergies as patient_allergies
      FROM visits v JOIN patients p ON v.patient_id=p.id WHERE v.id=$1 AND v.doctor_id=$2`, [req.params.id, req.doctorId]);
    if (!rows.length) return res.status(404).json({ error: 'Visit not found' });
    const prescriptions = await pool.query('SELECT * FROM prescriptions WHERE visit_id=$1', [req.params.id]);
    const charges = await pool.query('SELECT * FROM charges WHERE visit_id=$1', [req.params.id]);
    res.json({ ...rows[0], prescriptions: prescriptions.rows, charges: charges.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/visits', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const did = req.doctorId;
    const { patient_id, chief_complaint, examination, diagnosis, notes, bp_systolic, bp_diastolic, pulse, temperature, weight, height, spo2, follow_up_date, medicines, advice, charges } = req.body;
    const visitRes = await client.query(
      `INSERT INTO visits (patient_id,doctor_id,chief_complaint,examination,diagnosis,notes,bp_systolic,bp_diastolic,pulse,temperature,weight,height,spo2,follow_up_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [patient_id, did, chief_complaint, examination, diagnosis, notes, bp_systolic||null, bp_diastolic||null, pulse||null, temperature||null, weight||null, height||null, spo2||null, follow_up_date||null]
    );
    const visit = visitRes.rows[0];
    if (medicines?.length) {
      await client.query('INSERT INTO prescriptions (visit_id,patient_id,medicines,advice) VALUES ($1,$2,$3,$4)', [visit.id, patient_id, JSON.stringify(medicines), advice||'']);
    }
    if (charges?.length) {
      for (const ch of charges) {
        await client.query('INSERT INTO charges (visit_id,patient_id,doctor_id,description,amount,payment_mode,payment_status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [visit.id, patient_id, did, ch.description, ch.amount, ch.payment_mode||'cash', ch.payment_status||'paid', ch.notes||'']);
      }
    }
    await client.query('UPDATE patients SET updated_at=NOW() WHERE id=$1', [patient_id]);
    const today = new Date().toISOString().split('T')[0];
    await client.query("UPDATE appointments SET status='completed',updated_at=NOW() WHERE patient_id=$1 AND doctor_id=$2 AND appointment_date=$3 AND status='scheduled'", [patient_id, did, today]);
    await client.query('COMMIT');
    res.json(visit);
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.put('/api/visits/:id', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { chief_complaint, examination, diagnosis, notes, bp_systolic, bp_diastolic, pulse, temperature, weight, height, spo2, follow_up_date, medicines, advice } = req.body;
    const visitRes = await client.query(
      `UPDATE visits SET chief_complaint=$1,examination=$2,diagnosis=$3,notes=$4,bp_systolic=$5,bp_diastolic=$6,pulse=$7,temperature=$8,weight=$9,height=$10,spo2=$11,follow_up_date=$12
       WHERE id=$13 AND doctor_id=$14 RETURNING *`,
      [chief_complaint, examination, diagnosis, notes, bp_systolic||null, bp_diastolic||null, pulse||null, temperature||null, weight||null, height||null, spo2||null, follow_up_date||null, req.params.id, req.doctorId]
    );
    if (!visitRes.rows.length) throw new Error('Visit not found');
    await client.query('DELETE FROM prescriptions WHERE visit_id=$1', [req.params.id]);
    if (medicines?.length) {
      await client.query('INSERT INTO prescriptions (visit_id,patient_id,medicines,advice) VALUES ($1,$2,$3,$4)', [req.params.id, visitRes.rows[0].patient_id, JSON.stringify(medicines), advice||'']);
    }
    await client.query('COMMIT');
    res.json(visitRes.rows[0]);
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.get('/api/visits/:id/prescription', auth, async (req, res) => {
  try {
    const visit = await pool.query(`SELECT v.*,p.name as patient_name,p.dob as patient_dob,p.gender as patient_gender,p.contact as patient_contact,p.allergies as patient_allergies
      FROM visits v JOIN patients p ON v.patient_id=p.id WHERE v.id=$1 AND v.doctor_id=$2`, [req.params.id, req.doctorId]);
    if (!visit.rows.length) return res.status(404).json({ error: 'Visit not found' });
    const rx = await pool.query('SELECT * FROM prescriptions WHERE visit_id=$1', [req.params.id]);
    const doc = await pool.query('SELECT name,qualifications,registration_number,clinic_name,clinic_address,clinic_phone FROM doctors WHERE id=$1', [req.doctorId]);
    res.json({ visit: visit.rows[0], prescription: rx.rows[0]||null, clinic: doc.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Charges ─────────────────────────────────────────────────────
app.get('/api/patients/:id/charges', auth, async (req, res) => {
  try { const { rows } = await pool.query('SELECT * FROM charges WHERE patient_id=$1 AND doctor_id=$2 ORDER BY charge_date DESC', [req.params.id, req.doctorId]); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/charges', auth, async (req, res) => {
  try {
    const { patient_id, visit_id, description, amount, payment_mode, payment_status, notes } = req.body;
    const { rows } = await pool.query('INSERT INTO charges (patient_id,visit_id,doctor_id,description,amount,payment_mode,payment_status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [patient_id, visit_id||null, req.doctorId, description, amount, payment_mode||'cash', payment_status||'paid', notes]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/charges/:id', auth, async (req, res) => {
  try {
    const { description, amount, payment_mode, payment_status, notes } = req.body;
    const { rows } = await pool.query('UPDATE charges SET description=$1,amount=$2,payment_mode=$3,payment_status=$4,notes=$5 WHERE id=$6 AND doctor_id=$7 RETURNING *',
      [description, amount, payment_mode, payment_status, notes, req.params.id, req.doctorId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Appointments ────────────────────────────────────────────────
app.get('/api/appointments', auth, async (req, res) => {
  try {
    const { date, status, patient_id } = req.query;
    let query = `SELECT a.*,p.name as patient_name,p.contact as patient_contact FROM appointments a JOIN patients p ON a.patient_id=p.id WHERE a.doctor_id=$1`;
    const params = [req.doctorId];
    if (date) { params.push(date); query += ` AND a.appointment_date=$${params.length}`; }
    if (status) { params.push(status); query += ` AND a.status=$${params.length}`; }
    if (patient_id) { params.push(patient_id); query += ` AND a.patient_id=$${params.length}`; }
    query += ' ORDER BY a.appointment_date ASC, a.appointment_time ASC NULLS LAST';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/appointments', auth, async (req, res) => {
  try {
    const { patient_id, appointment_date, appointment_time, reason, notes } = req.body;
    if (!patient_id || !appointment_date) return res.status(400).json({ error: 'Patient and date required' });
    const { rows } = await pool.query(
      'INSERT INTO appointments (patient_id,doctor_id,appointment_date,appointment_time,reason,notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [patient_id, req.doctorId, appointment_date, appointment_time||null, reason, notes]
    );
    const full = await pool.query('SELECT a.*,p.name as patient_name,p.contact as patient_contact FROM appointments a JOIN patients p ON a.patient_id=p.id WHERE a.id=$1', [rows[0].id]);
    // Send push notification
    const appt = full.rows[0];
    sendPushToDoctor(req.doctorId, { title: '📅 New Appointment', body: `${appt.patient_name} — ${appointment_date}${appointment_time ? ' at ' + appointment_time : ''}`, url: '/' });
    res.json(appt);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/appointments/:id', auth, async (req, res) => {
  try {
    const { appointment_date, appointment_time, status, reason, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE appointments SET appointment_date=COALESCE($1,appointment_date),appointment_time=COALESCE($2,appointment_time),
       status=COALESCE($3,status),reason=COALESCE($4,reason),notes=COALESCE($5,notes),updated_at=NOW()
       WHERE id=$6 AND doctor_id=$7 RETURNING *`,
      [appointment_date, appointment_time, status, reason, notes, req.params.id, req.doctorId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Expenses ────────────────────────────────────────────────────
app.get('/api/expenses', auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    let q = 'SELECT * FROM expenses WHERE doctor_id=$1';
    const p = [req.doctorId];
    if (from) { p.push(from); q += ` AND expense_date>=$${p.length}`; }
    if (to) { p.push(to); q += ` AND expense_date<=$${p.length}`; }
    q += ' ORDER BY expense_date DESC';
    const { rows } = await pool.query(q, p);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/expenses', auth, async (req, res) => {
  try {
    const { description, amount, expense_date } = req.body;
    if (!description || !amount) return res.status(400).json({ error: 'Description and amount required' });
    const { rows } = await pool.query(
      'INSERT INTO expenses (doctor_id, description, amount, expense_date) VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE)) RETURNING *',
      [req.doctorId, description, amount, expense_date || null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/expenses/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM expenses WHERE id=$1 AND doctor_id=$2', [req.params.id, req.doctorId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Reports ─────────────────────────────────────────────────────
app.get('/api/reports/revenue', auth, async (req, res) => {
  try {
    const did = req.doctorId; 
    const { from, to, group_by = 'day' } = req.query;
    const fmt = group_by === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
    
    // Revenue query
    let rq = `SELECT to_char(charge_date,'${fmt}') as period, SUM(CASE WHEN payment_status='paid' THEN amount ELSE 0 END) as paid, SUM(CASE WHEN payment_status='pending' THEN amount ELSE 0 END) as pending FROM charges WHERE doctor_id=$1`;
    const rp = [did];
    if (from) { rp.push(from); rq += ` AND charge_date>=$${rp.length}`; }
    if (to) { rp.push(to+'T23:59:59'); rq += ` AND charge_date<=$${rp.length}`; }
    rq += ' GROUP BY period';

    // Expense query
    let eq = `SELECT to_char(expense_date,'${fmt}') as period, SUM(amount) as expenses FROM expenses WHERE doctor_id=$1`;
    const ep = [did];
    if (from) { ep.push(from); eq += ` AND expense_date>=$${ep.length}`; }
    if (to) { ep.push(to); eq += ` AND expense_date<=$${ep.length}`; }
    eq += ' GROUP BY period';

    const [revRes, expRes] = await Promise.all([pool.query(rq, rp), pool.query(eq, ep)]);
    
    // Merge revenue and expenses by period
    const periods = {};
    revRes.rows.forEach(r => {
        periods[r.period] = { period: r.period, revenue: parseFloat(r.paid), pending: parseFloat(r.pending), expenses: 0, profit: parseFloat(r.paid) };
    });
    expRes.rows.forEach(e => {
        if (!periods[e.period]) periods[e.period] = { period: e.period, revenue: 0, pending: 0, expenses: 0, profit: 0 };
        periods[e.period].expenses = parseFloat(e.expenses);
        periods[e.period].profit = periods[e.period].revenue - periods[e.period].expenses;
    });
    
    const mergedPeriods = Object.values(periods).sort((a,b) => b.period.localeCompare(a.period));

    // Summary totals
    let tq = `SELECT COALESCE(SUM(CASE WHEN payment_status='paid' THEN amount ELSE 0 END),0) as total_revenue, COALESCE(SUM(CASE WHEN payment_status='pending' THEN amount ELSE 0 END),0) as total_pending FROM charges WHERE doctor_id=$1`;
    const tp = [did]; if (from) { tp.push(from); tq += ` AND charge_date>=$${tp.length}`; } if (to) { tp.push(to+'T23:59:59'); tq += ` AND charge_date<=$${tp.length}`; }
    
    let teq = `SELECT COALESCE(SUM(amount),0) as total_expenses FROM expenses WHERE doctor_id=$1`;
    const tep = [did]; if (from) { tep.push(from); teq += ` AND expense_date>=$${tep.length}`; } if (to) { tep.push(to); teq += ` AND expense_date<=$${tep.length}`; }

    const [totRev, totExp] = await Promise.all([pool.query(tq, tp), pool.query(teq, tep)]);
    
    const summary = {
        total_revenue: parseFloat(totRev.rows[0].total_revenue),
        total_pending: parseFloat(totRev.rows[0].total_pending),
        total_expenses: parseFloat(totExp.rows[0].total_expenses),
        net_profit: parseFloat(totRev.rows[0].total_revenue) - parseFloat(totExp.rows[0].total_expenses)
    };

    res.json({ periods: mergedPeriods, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/patients', auth, async (req, res) => {
  try {
    const did = req.doctorId; const { from, to } = req.query;
    let rq = `SELECT to_char(created_at,'YYYY-MM-DD') as period,COUNT(*) as count FROM patients WHERE doctor_id=$1 AND is_active=true`;
    const rp = [did]; if (from) { rp.push(from); rq += ` AND created_at>=$${rp.length}`; } if (to) { rp.push(to+'T23:59:59'); rq += ` AND created_at<=$${rp.length}`; }
    rq += ' GROUP BY period ORDER BY period DESC'; const regs = await pool.query(rq, rp);
    const gd = await pool.query("SELECT COALESCE(gender,'Not specified') as gender,COUNT(*) as count FROM patients WHERE doctor_id=$1 AND is_active=true GROUP BY gender", [did]);
    const ad = await pool.query(`SELECT CASE WHEN dob IS NULL THEN 'Unknown' WHEN EXTRACT(YEAR FROM age(dob))<18 THEN '0-17' WHEN EXTRACT(YEAR FROM age(dob))<30 THEN '18-29' WHEN EXTRACT(YEAR FROM age(dob))<45 THEN '30-44' WHEN EXTRACT(YEAR FROM age(dob))<60 THEN '45-59' ELSE '60+' END as age_group,COUNT(*) as count FROM patients WHERE doctor_id=$1 AND is_active=true GROUP BY age_group ORDER BY age_group`, [did]);
    const total = await pool.query('SELECT COUNT(*) FROM patients WHERE doctor_id=$1 AND is_active=true', [did]);
    res.json({ registrations: regs.rows, gender: gd.rows, age: ad.rows, total: parseInt(total.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/visits', auth, async (req, res) => {
  try {
    const did = req.doctorId; const { from, to, search, page = 1, limit = 50 } = req.query; const offset = (page - 1) * limit;
    let q = `SELECT v.*,p.name as patient_name,p.contact as patient_contact FROM visits v JOIN patients p ON v.patient_id=p.id WHERE v.doctor_id=$1`;
    const prms = [did];
    if (from) { prms.push(from); q += ` AND v.visit_date>=$${prms.length}`; }
    if (to) { prms.push(to+'T23:59:59'); q += ` AND v.visit_date<=$${prms.length}`; }
    if (search) { prms.push(`%${search}%`); q += ` AND (LOWER(p.name) LIKE LOWER($${prms.length}) OR p.contact LIKE $${prms.length} OR LOWER(v.diagnosis) LIKE LOWER($${prms.length}))`; }
    const cntQ = q.replace(/SELECT v\.\*.*?FROM/, 'SELECT COUNT(*) FROM');
    prms.push(limit); q += ` ORDER BY v.visit_date DESC LIMIT $${prms.length}`;
    prms.push(offset); q += ` OFFSET $${prms.length}`;
    const [{ rows }, cntRes] = await Promise.all([pool.query(q, prms), pool.query(cntQ, prms.slice(0, -2))]);
    res.json({ visits: rows, total: parseInt(cntRes.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/export/:type', auth, async (req, res) => {
  try {
    const did = req.doctorId; const { type } = req.params; const { from, to } = req.query; let rows, headers;
    if (type === 'revenue') { const r = await pool.query(`SELECT c.charge_date,p.name,p.contact,c.description,c.amount,c.payment_mode,c.payment_status FROM charges c JOIN patients p ON c.patient_id=p.id WHERE c.doctor_id=$1 AND ($2::date IS NULL OR c.charge_date>=$2) AND ($3::date IS NULL OR c.charge_date<=$3::date+1) ORDER BY c.charge_date DESC`,[did,from||null,to||null]); rows=r.rows; headers=['Date','Patient','Contact','Description','Amount','Mode','Status']; }
    else if (type === 'visits') { const r = await pool.query(`SELECT v.visit_date,p.name,p.contact,v.chief_complaint,v.diagnosis,v.bp_systolic,v.bp_diastolic,v.pulse,v.temperature,v.weight FROM visits v JOIN patients p ON v.patient_id=p.id WHERE v.doctor_id=$1 AND ($2::date IS NULL OR v.visit_date>=$2) AND ($3::date IS NULL OR v.visit_date<=$3::date+1) ORDER BY v.visit_date DESC`,[did,from||null,to||null]); rows=r.rows; headers=['Date','Patient','Contact','Complaint','Diagnosis','BP Sys','BP Dia','Pulse','Temp','Weight']; }
    else if (type === 'patients') { const r = await pool.query('SELECT name,contact,dob,gender,blood_group,email,address,allergies,created_at FROM patients WHERE doctor_id=$1 AND is_active=true ORDER BY name',[did]); rows=r.rows; headers=['Name','Contact','DOB','Gender','Blood','Email','Address','Allergies','Registered']; }
    else return res.status(400).json({ error: 'Invalid type' });
    const esc = v => { const s = String(v??''); return s.includes(',')||s.includes('"')||s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s; };
    let csv = headers.join(',')+'\n'; rows.forEach(row => { csv += Object.values(row).map(esc).join(',')+'\n'; });
    res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition',`attachment; filename=${type}_report.csv`); res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Backup & Restore ────────────────────────────────────────────
app.get('/api/backup', auth, async (req, res) => {
  try {
    const did = req.doctorId;
    const [patients,visits,prescriptions,charges,appointments,doctor] = await Promise.all([
      pool.query('SELECT * FROM patients WHERE doctor_id=$1',[did]), pool.query('SELECT * FROM visits WHERE doctor_id=$1',[did]),
      pool.query('SELECT pr.* FROM prescriptions pr JOIN visits v ON pr.visit_id=v.id WHERE v.doctor_id=$1',[did]),
      pool.query('SELECT * FROM charges WHERE doctor_id=$1',[did]), pool.query('SELECT * FROM appointments WHERE doctor_id=$1',[did]),
      pool.query('SELECT name,qualifications,registration_number,clinic_name,clinic_address,clinic_phone,consultation_fee FROM doctors WHERE id=$1',[did])
    ]);
    const backup = { version:'1.0', app:'clinic-manager', exported_at: new Date().toISOString(), doctor_info: doctor.rows[0],
      counts: { patients:patients.rows.length, visits:visits.rows.length, prescriptions:prescriptions.rows.length, charges:charges.rows.length, appointments:appointments.rows.length },
      data: { patients:patients.rows, visits:visits.rows, prescriptions:prescriptions.rows, charges:charges.rows, appointments:appointments.rows }
    };
    res.setHeader('Content-Type','application/json'); res.setHeader('Content-Disposition',`attachment; filename=clinic-backup-${new Date().toISOString().split('T')[0]}.json`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup/stats', auth, async (req, res) => {
  try {
    const did = req.doctorId;
    const [p,v,pr,c,a] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM patients WHERE doctor_id=$1',[did]), pool.query('SELECT COUNT(*) FROM visits WHERE doctor_id=$1',[did]),
      pool.query('SELECT COUNT(*) FROM prescriptions pr JOIN visits vt ON pr.visit_id=vt.id WHERE vt.doctor_id=$1',[did]),
      pool.query('SELECT COUNT(*) FROM charges WHERE doctor_id=$1',[did]), pool.query('SELECT COUNT(*) FROM appointments WHERE doctor_id=$1',[did])
    ]);
    res.json({ patients:parseInt(p.rows[0].count), visits:parseInt(v.rows[0].count), prescriptions:parseInt(pr.rows[0].count), charges:parseInt(c.rows[0].count), appointments:parseInt(a.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/restore', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const backup = req.body; if (!backup || backup.app !== 'clinic-manager' || !backup.data) return res.status(400).json({ error: 'Invalid backup file' });
    const did = req.doctorId;
    await client.query('BEGIN');
    await client.query('DELETE FROM prescriptions WHERE visit_id IN (SELECT id FROM visits WHERE doctor_id=$1)', [did]);
    await client.query('DELETE FROM charges WHERE doctor_id=$1', [did]);
    await client.query('DELETE FROM visits WHERE doctor_id=$1', [did]);
    await client.query('DELETE FROM appointments WHERE doctor_id=$1', [did]);
    await client.query('DELETE FROM patients WHERE doctor_id=$1', [did]);
    const d = backup.data; const patientMap = {};
    for (const p of (d.patients||[])) { const r = await client.query(`INSERT INTO patients (doctor_id,name,dob,gender,contact,email,address,blood_group,allergies,medical_history,notes,is_active,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`, [did,p.name,p.dob||null,p.gender,p.contact,p.email,p.address,p.blood_group,p.allergies,p.medical_history,p.notes,p.is_active!==false,p.created_at||new Date(),p.updated_at||new Date()]); patientMap[p.id]=r.rows[0].id; }
    const visitMap = {};
    for (const v of (d.visits||[])) { const np=patientMap[v.patient_id]; if(!np)continue; const r = await client.query(`INSERT INTO visits (patient_id,doctor_id,visit_date,chief_complaint,examination,diagnosis,notes,bp_systolic,bp_diastolic,pulse,temperature,weight,height,spo2,follow_up_date,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`, [np,did,v.visit_date,v.chief_complaint,v.examination,v.diagnosis,v.notes,v.bp_systolic,v.bp_diastolic,v.pulse,v.temperature,v.weight,v.height,v.spo2,v.follow_up_date,v.created_at||new Date()]); visitMap[v.id]=r.rows[0].id; }
    for (const pr of (d.prescriptions||[])) { const nv=visitMap[pr.visit_id]; const np=patientMap[pr.patient_id]; if(!nv||!np)continue; await client.query('INSERT INTO prescriptions (visit_id,patient_id,medicines,advice,created_at) VALUES ($1,$2,$3,$4,$5)', [nv,np,typeof pr.medicines==='string'?pr.medicines:JSON.stringify(pr.medicines),pr.advice,pr.created_at||new Date()]); }
    for (const ch of (d.charges||[])) { const np=patientMap[ch.patient_id]; if(!np)continue; await client.query('INSERT INTO charges (visit_id,patient_id,doctor_id,description,amount,payment_mode,payment_status,charge_date,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [ch.visit_id?visitMap[ch.visit_id]:null,np,did,ch.description,ch.amount,ch.payment_mode,ch.payment_status,ch.charge_date,ch.notes,ch.created_at||new Date()]); }
    for (const a of (d.appointments||[])) { const np=patientMap[a.patient_id]; if(!np)continue; await client.query('INSERT INTO appointments (patient_id,doctor_id,appointment_date,appointment_time,status,reason,notes,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [np,did,a.appointment_date,a.appointment_time,a.status,a.reason,a.notes,a.created_at||new Date(),a.updated_at||new Date()]); }
    await client.query('COMMIT');
    res.json({ success:true, restored:{ patients:Object.keys(patientMap).length, visits:Object.keys(visitMap).length } });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Cron: Daily appointment reminders at 8 AM ──────────────────
cron.schedule('0 8 * * *', async () => {
  console.log('Running daily appointment reminder cron...');
  try {
    const today = new Date().toISOString().split('T')[0];
    const { rows } = await pool.query(
      `SELECT a.doctor_id, COUNT(*) as cnt, STRING_AGG(p.name, ', ' ORDER BY a.appointment_time ASC NULLS LAST) as names
       FROM appointments a JOIN patients p ON a.patient_id=p.id
       WHERE a.appointment_date=$1 AND a.status='scheduled'
       GROUP BY a.doctor_id`, [today]
    );
    for (const row of rows) {
      await sendPushToDoctor(row.doctor_id, {
        title: `📅 ${row.cnt} appointment${row.cnt > 1 ? 's' : ''} today`,
        body: row.names,
        url: '/'
      });
    }
    console.log(`Sent appointment reminders to ${rows.length} doctor(s)`);
  } catch (e) { console.error('Cron error:', e.message); }
}, { timezone: 'Asia/Kolkata' });

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Clinic Manager running on port ${PORT}`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
