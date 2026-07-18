const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
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
      name VARCHAR(255) NOT NULL,
      dob DATE,
      gender VARCHAR(10),
      contact VARCHAR(20) NOT NULL,
      email VARCHAR(255),
      address TEXT,
      blood_group VARCHAR(5),
      allergies TEXT,
      medical_history TEXT,
      notes TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS visits (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
      doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
      visit_date TIMESTAMPTZ DEFAULT NOW(),
      chief_complaint TEXT,
      examination TEXT,
      diagnosis TEXT,
      notes TEXT,
      bp_systolic INTEGER,
      bp_diastolic INTEGER,
      pulse INTEGER,
      temperature DECIMAL(4,1),
      weight DECIMAL(5,1),
      height DECIMAL(5,1),
      spo2 INTEGER,
      follow_up_date DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS prescriptions (
      id SERIAL PRIMARY KEY,
      visit_id INTEGER REFERENCES visits(id) ON DELETE CASCADE,
      patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
      medicines JSONB DEFAULT '[]',
      advice TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS charges (
      id SERIAL PRIMARY KEY,
      visit_id INTEGER REFERENCES visits(id) ON DELETE SET NULL,
      patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
      doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
      description VARCHAR(255) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      payment_mode VARCHAR(20) DEFAULT 'cash',
      payment_status VARCHAR(20) DEFAULT 'paid',
      charge_date TIMESTAMPTZ DEFAULT NOW(),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
      doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
      appointment_date DATE NOT NULL,
      appointment_time TIME,
      status VARCHAR(20) DEFAULT 'scheduled',
      reason TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Indexes
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_patients_doctor ON patients(doctor_id);
    CREATE INDEX IF NOT EXISTS idx_patients_contact ON patients(contact);
    CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(LOWER(name));
    CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id);
    CREATE INDEX IF NOT EXISTS idx_visits_doctor ON visits(doctor_id);
    CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(visit_date);
    CREATE INDEX IF NOT EXISTS idx_charges_patient ON charges(patient_id);
    CREATE INDEX IF NOT EXISTS idx_charges_doctor ON charges(doctor_id);
    CREATE INDEX IF NOT EXISTS idx_charges_date ON charges(charge_date);
    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appointment_date);
    CREATE INDEX IF NOT EXISTS idx_appointments_doctor ON appointments(doctor_id);
  `);

  // Seed default admin doctor if no doctors exist
  const { rows } = await pool.query('SELECT COUNT(*) FROM doctors');
  if (parseInt(rows[0].count) === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      `INSERT INTO doctors (username, password_hash, name, qualifications, clinic_name, role)
       VALUES ('admin', $1, 'Dr. Admin', 'MBBS', 'My Clinic', 'admin')`, [hash]
    );
    console.log('Default admin created — username: admin, password: admin123');
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

// ─── Auth Routes ─────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const { rows } = await pool.query('SELECT * FROM doctors WHERE username = $1 AND is_active = true', [username]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const doc = rows[0];
    const valid = await bcrypt.compare(password, doc.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: doc.id, username: doc.username, role: doc.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.json({ token, doctor: { id: doc.id, name: doc.name, username: doc.username, role: doc.role, clinic_name: doc.clinic_name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', auth, async (req, res) => {
  try {
    if (req.doctorRole !== 'admin') return res.status(403).json({ error: 'Only admin can register doctors' });
    const { username, password, name, qualifications, clinic_name } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: 'Username, password and name required' });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO doctors (username, password_hash, name, qualifications, clinic_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, username, name, role`,
      [username, hash, name, qualifications || '', clinic_name || '']
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/change-password', auth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
    if (new_password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const { rows } = await pool.query('SELECT password_hash FROM doctors WHERE id = $1', [req.doctorId]);
    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE doctors SET password_hash = $1 WHERE id = $2', [hash, req.doctorId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Doctor Profile / Settings ───────────────────────────────────
app.get('/api/profile', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, name, qualifications, registration_number, clinic_name, clinic_address, clinic_phone, consultation_fee, role, created_at FROM doctors WHERE id = $1',
      [req.doctorId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Doctor not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/profile', auth, async (req, res) => {
  try {
    const { name, qualifications, registration_number, clinic_name, clinic_address, clinic_phone, consultation_fee } = req.body;
    const { rows } = await pool.query(
      `UPDATE doctors SET name=$1, qualifications=$2, registration_number=$3, clinic_name=$4, clinic_address=$5, clinic_phone=$6, consultation_fee=$7
       WHERE id=$8 RETURNING id, username, name, qualifications, registration_number, clinic_name, clinic_address, clinic_phone, consultation_fee, role`,
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
    const { search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let query, countQuery, params;
    if (search && search.trim()) {
      const s = `%${search.trim()}%`;
      query = `SELECT * FROM patients WHERE doctor_id=$1 AND is_active=true AND (LOWER(name) LIKE LOWER($2) OR contact LIKE $2) ORDER BY name ASC LIMIT $3 OFFSET $4`;
      countQuery = `SELECT COUNT(*) FROM patients WHERE doctor_id=$1 AND is_active=true AND (LOWER(name) LIKE LOWER($2) OR contact LIKE $2)`;
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
    const { rows } = await pool.query(
      `SELECT id,name,contact,gender FROM patients WHERE doctor_id=$1 AND is_active=true AND (LOWER(name) LIKE LOWER($2) OR contact LIKE $2) LIMIT 10`,
      [req.doctorId, `%${q}%`]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/patients/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM patients WHERE id=$1 AND doctor_id=$2', [req.params.id, req.doctorId]);
    if (!rows.length) return res.status(404).json({ error: 'Patient not found' });
    const stats = await pool.query('SELECT COUNT(*) as visit_count, MAX(visit_date) as last_visit FROM visits WHERE patient_id=$1 AND doctor_id=$2', [req.params.id, req.doctorId]);
    const totalCharges = await pool.query(`SELECT COALESCE(SUM(amount),0) as total_charges, COALESCE(SUM(CASE WHEN payment_status='pending' THEN amount ELSE 0 END),0) as pending FROM charges WHERE patient_id=$1 AND doctor_id=$2`, [req.params.id, req.doctorId]);
    res.json({ ...rows[0], visit_count: parseInt(stats.rows[0].visit_count), last_visit: stats.rows[0].last_visit, total_charges: parseFloat(totalCharges.rows[0].total_charges), pending_amount: parseFloat(totalCharges.rows[0].pending) });
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

// ─── Prescription print ──────────────────────────────────────────
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
  try {
    const { rows } = await pool.query('SELECT * FROM charges WHERE patient_id=$1 AND doctor_id=$2 ORDER BY charge_date DESC', [req.params.id, req.doctorId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/charges', auth, async (req, res) => {
  try {
    const { patient_id, visit_id, description, amount, payment_mode, payment_status, notes } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO charges (patient_id,visit_id,doctor_id,description,amount,payment_mode,payment_status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [patient_id, visit_id||null, req.doctorId, description, amount, payment_mode||'cash', payment_status||'paid', notes]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/charges/:id', auth, async (req, res) => {
  try {
    const { description, amount, payment_mode, payment_status, notes } = req.body;
    const { rows } = await pool.query(
      'UPDATE charges SET description=$1,amount=$2,payment_mode=$3,payment_status=$4,notes=$5 WHERE id=$6 AND doctor_id=$7 RETURNING *',
      [description, amount, payment_mode, payment_status, notes, req.params.id, req.doctorId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Charge not found' });
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
    res.json(full.rows[0]);
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
    if (!rows.length) return res.status(404).json({ error: 'Appointment not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Reports ─────────────────────────────────────────────────────
app.get('/api/reports/revenue', auth, async (req, res) => {
  try {
    const did = req.doctorId;
    const { from, to, group_by = 'day' } = req.query;
    const fmt = group_by === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
    let query = `SELECT to_char(charge_date,'${fmt}') as period,SUM(CASE WHEN payment_status='paid' THEN amount ELSE 0 END) as paid,SUM(CASE WHEN payment_status='pending' THEN amount ELSE 0 END) as pending,SUM(amount) as total,COUNT(*) as count FROM charges WHERE doctor_id=$1`;
    const params = [did];
    if (from) { params.push(from); query += ` AND charge_date>=$${params.length}`; }
    if (to) { params.push(to+'T23:59:59'); query += ` AND charge_date<=$${params.length}`; }
    query += ' GROUP BY period ORDER BY period DESC';
    const { rows } = await pool.query(query, params);
    let modeQuery = `SELECT payment_mode,SUM(amount) as total,COUNT(*) as count FROM charges WHERE doctor_id=$1 AND payment_status='paid'`;
    const mp = [did];
    if (from) { mp.push(from); modeQuery += ` AND charge_date>=$${mp.length}`; }
    if (to) { mp.push(to+'T23:59:59'); modeQuery += ` AND charge_date<=$${mp.length}`; }
    modeQuery += ' GROUP BY payment_mode';
    const modes = await pool.query(modeQuery, mp);
    let tq = `SELECT COALESCE(SUM(amount),0) as grand_total,COALESCE(SUM(CASE WHEN payment_status='paid' THEN amount ELSE 0 END),0) as total_paid,COALESCE(SUM(CASE WHEN payment_status='pending' THEN amount ELSE 0 END),0) as total_pending,COUNT(*) as total_transactions FROM charges WHERE doctor_id=$1`;
    const tp = [did];
    if (from) { tp.push(from); tq += ` AND charge_date>=$${tp.length}`; }
    if (to) { tp.push(to+'T23:59:59'); tq += ` AND charge_date<=$${tp.length}`; }
    const totals = await pool.query(tq, tp);
    res.json({ periods: rows, modes: modes.rows, summary: totals.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/patients', auth, async (req, res) => {
  try {
    const did = req.doctorId;
    const { from, to } = req.query;
    let rq = `SELECT to_char(created_at,'YYYY-MM-DD') as period,COUNT(*) as count FROM patients WHERE doctor_id=$1 AND is_active=true`;
    const rp = [did];
    if (from) { rp.push(from); rq += ` AND created_at>=$${rp.length}`; }
    if (to) { rp.push(to+'T23:59:59'); rq += ` AND created_at<=$${rp.length}`; }
    rq += ' GROUP BY period ORDER BY period DESC';
    const regs = await pool.query(rq, rp);
    const gd = await pool.query("SELECT COALESCE(gender,'Not specified') as gender,COUNT(*) as count FROM patients WHERE doctor_id=$1 AND is_active=true GROUP BY gender", [did]);
    const ad = await pool.query(`SELECT CASE WHEN dob IS NULL THEN 'Unknown' WHEN EXTRACT(YEAR FROM age(dob))<18 THEN '0-17' WHEN EXTRACT(YEAR FROM age(dob))<30 THEN '18-29' WHEN EXTRACT(YEAR FROM age(dob))<45 THEN '30-44' WHEN EXTRACT(YEAR FROM age(dob))<60 THEN '45-59' ELSE '60+' END as age_group,COUNT(*) as count FROM patients WHERE doctor_id=$1 AND is_active=true GROUP BY age_group ORDER BY age_group`, [did]);
    const total = await pool.query('SELECT COUNT(*) FROM patients WHERE doctor_id=$1 AND is_active=true', [did]);
    res.json({ registrations: regs.rows, gender: gd.rows, age: ad.rows, total: parseInt(total.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/visits', auth, async (req, res) => {
  try {
    const did = req.doctorId;
    const { from, to, search, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let query = `SELECT v.*,p.name as patient_name,p.contact as patient_contact FROM visits v JOIN patients p ON v.patient_id=p.id WHERE v.doctor_id=$1`;
    const params = [did];
    if (from) { params.push(from); query += ` AND v.visit_date>=$${params.length}`; }
    if (to) { params.push(to+'T23:59:59'); query += ` AND v.visit_date<=$${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (LOWER(p.name) LIKE LOWER($${params.length}) OR p.contact LIKE $${params.length} OR LOWER(v.diagnosis) LIKE LOWER($${params.length}))`; }
    const countQ = query.replace(/SELECT v\.\*.*?FROM/, 'SELECT COUNT(*) FROM');
    params.push(limit); query += ` ORDER BY v.visit_date DESC LIMIT $${params.length}`;
    params.push(offset); query += ` OFFSET $${params.length}`;
    const [{ rows }, cntRes] = await Promise.all([pool.query(query, params), pool.query(countQ, params.slice(0, -2))]);
    res.json({ visits: rows, total: parseInt(cntRes.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/export/:type', auth, async (req, res) => {
  try {
    const did = req.doctorId;
    const { type } = req.params;
    const { from, to } = req.query;
    let rows, headers;
    if (type === 'revenue') {
      const r = await pool.query(`SELECT c.charge_date,p.name as patient_name,p.contact,c.description,c.amount,c.payment_mode,c.payment_status FROM charges c JOIN patients p ON c.patient_id=p.id WHERE c.doctor_id=$1 AND ($2::date IS NULL OR c.charge_date>=$2) AND ($3::date IS NULL OR c.charge_date<=$3::date+1) ORDER BY c.charge_date DESC`, [did, from||null, to||null]);
      rows = r.rows; headers = ['Date','Patient','Contact','Description','Amount','Payment Mode','Status'];
    } else if (type === 'visits') {
      const r = await pool.query(`SELECT v.visit_date,p.name,p.contact,v.chief_complaint,v.diagnosis,v.bp_systolic,v.bp_diastolic,v.pulse,v.temperature,v.weight FROM visits v JOIN patients p ON v.patient_id=p.id WHERE v.doctor_id=$1 AND ($2::date IS NULL OR v.visit_date>=$2) AND ($3::date IS NULL OR v.visit_date<=$3::date+1) ORDER BY v.visit_date DESC`, [did, from||null, to||null]);
      rows = r.rows; headers = ['Date','Patient','Contact','Complaint','Diagnosis','BP Sys','BP Dia','Pulse','Temp','Weight'];
    } else if (type === 'patients') {
      const r = await pool.query('SELECT name,contact,dob,gender,blood_group,email,address,allergies,created_at FROM patients WHERE doctor_id=$1 AND is_active=true ORDER BY name', [did]);
      rows = r.rows; headers = ['Name','Contact','DOB','Gender','Blood Group','Email','Address','Allergies','Registered'];
    } else return res.status(400).json({ error: 'Invalid type' });
    const esc = v => { const s = String(v??''); return s.includes(',')||s.includes('"')||s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s; };
    let csv = headers.join(',') + '\n';
    rows.forEach(row => { csv += Object.values(row).map(esc).join(',') + '\n'; });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${type}_report.csv`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Backup & Restore ────────────────────────────────────────────
app.get('/api/backup', auth, async (req, res) => {
  try {
    const did = req.doctorId;
    const [patients, visits, prescriptions, charges, appointments, doctor] = await Promise.all([
      pool.query('SELECT * FROM patients WHERE doctor_id=$1', [did]),
      pool.query('SELECT * FROM visits WHERE doctor_id=$1', [did]),
      pool.query('SELECT pr.* FROM prescriptions pr JOIN visits v ON pr.visit_id=v.id WHERE v.doctor_id=$1', [did]),
      pool.query('SELECT * FROM charges WHERE doctor_id=$1', [did]),
      pool.query('SELECT * FROM appointments WHERE doctor_id=$1', [did]),
      pool.query('SELECT name,qualifications,registration_number,clinic_name,clinic_address,clinic_phone,consultation_fee FROM doctors WHERE id=$1', [did])
    ]);
    const backup = {
      version: '1.0',
      app: 'clinic-manager',
      exported_at: new Date().toISOString(),
      doctor_info: doctor.rows[0],
      counts: { patients: patients.rows.length, visits: visits.rows.length, prescriptions: prescriptions.rows.length, charges: charges.rows.length, appointments: appointments.rows.length },
      data: { patients: patients.rows, visits: visits.rows, prescriptions: prescriptions.rows, charges: charges.rows, appointments: appointments.rows }
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=clinic-backup-${new Date().toISOString().split('T')[0]}.json`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup/stats', auth, async (req, res) => {
  try {
    const did = req.doctorId;
    const [p, v, pr, c, a] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM patients WHERE doctor_id=$1', [did]),
      pool.query('SELECT COUNT(*) FROM visits WHERE doctor_id=$1', [did]),
      pool.query('SELECT COUNT(*) FROM prescriptions pr JOIN visits vt ON pr.visit_id=vt.id WHERE vt.doctor_id=$1', [did]),
      pool.query('SELECT COUNT(*) FROM charges WHERE doctor_id=$1', [did]),
      pool.query('SELECT COUNT(*) FROM appointments WHERE doctor_id=$1', [did])
    ]);
    res.json({ patients: parseInt(p.rows[0].count), visits: parseInt(v.rows[0].count), prescriptions: parseInt(pr.rows[0].count), charges: parseInt(c.rows[0].count), appointments: parseInt(a.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/restore', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const backup = req.body;
    if (!backup || backup.app !== 'clinic-manager' || !backup.data) return res.status(400).json({ error: 'Invalid backup file' });
    const did = req.doctorId;
    await client.query('BEGIN');
    // Delete existing data in FK-safe order
    await client.query('DELETE FROM prescriptions WHERE visit_id IN (SELECT id FROM visits WHERE doctor_id=$1)', [did]);
    await client.query('DELETE FROM charges WHERE doctor_id=$1', [did]);
    await client.query('DELETE FROM visits WHERE doctor_id=$1', [did]);
    await client.query('DELETE FROM appointments WHERE doctor_id=$1', [did]);
    await client.query('DELETE FROM patients WHERE doctor_id=$1', [did]);

    const d = backup.data;
    const patientMap = {};
    // Insert patients
    for (const p of (d.patients || [])) {
      const r = await client.query(
        `INSERT INTO patients (doctor_id,name,dob,gender,contact,email,address,blood_group,allergies,medical_history,notes,is_active,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [did, p.name, p.dob||null, p.gender, p.contact, p.email, p.address, p.blood_group, p.allergies, p.medical_history, p.notes, p.is_active!==false, p.created_at||new Date(), p.updated_at||new Date()]
      );
      patientMap[p.id] = r.rows[0].id;
    }
    // Insert visits
    const visitMap = {};
    for (const v of (d.visits || [])) {
      const newPid = patientMap[v.patient_id];
      if (!newPid) continue;
      const r = await client.query(
        `INSERT INTO visits (patient_id,doctor_id,visit_date,chief_complaint,examination,diagnosis,notes,bp_systolic,bp_diastolic,pulse,temperature,weight,height,spo2,follow_up_date,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [newPid, did, v.visit_date, v.chief_complaint, v.examination, v.diagnosis, v.notes, v.bp_systolic, v.bp_diastolic, v.pulse, v.temperature, v.weight, v.height, v.spo2, v.follow_up_date, v.created_at||new Date()]
      );
      visitMap[v.id] = r.rows[0].id;
    }
    // Insert prescriptions
    for (const pr of (d.prescriptions || [])) {
      const newVid = visitMap[pr.visit_id];
      const newPid = patientMap[pr.patient_id];
      if (!newVid || !newPid) continue;
      await client.query('INSERT INTO prescriptions (visit_id,patient_id,medicines,advice,created_at) VALUES ($1,$2,$3,$4,$5)',
        [newVid, newPid, typeof pr.medicines === 'string' ? pr.medicines : JSON.stringify(pr.medicines), pr.advice, pr.created_at||new Date()]);
    }
    // Insert charges
    for (const ch of (d.charges || [])) {
      const newPid = patientMap[ch.patient_id];
      if (!newPid) continue;
      const newVid = ch.visit_id ? visitMap[ch.visit_id] : null;
      await client.query(
        'INSERT INTO charges (visit_id,patient_id,doctor_id,description,amount,payment_mode,payment_status,charge_date,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [newVid, newPid, did, ch.description, ch.amount, ch.payment_mode, ch.payment_status, ch.charge_date, ch.notes, ch.created_at||new Date()]
      );
    }
    // Insert appointments
    for (const a of (d.appointments || [])) {
      const newPid = patientMap[a.patient_id];
      if (!newPid) continue;
      await client.query(
        'INSERT INTO appointments (patient_id,doctor_id,appointment_date,appointment_time,status,reason,notes,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [newPid, did, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes, a.created_at||new Date(), a.updated_at||new Date()]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, restored: { patients: Object.keys(patientMap).length, visits: Object.keys(visitMap).length, charges: (d.charges||[]).length, appointments: (d.appointments||[]).length } });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ─── Doctor Management (admin only) ──────────────────────────────
app.get('/api/doctors', auth, async (req, res) => {
  try {
    if (req.doctorRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { rows } = await pool.query('SELECT id,username,name,qualifications,clinic_name,role,is_active,created_at FROM doctors ORDER BY created_at');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Clinic Manager running on port ${PORT}`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
