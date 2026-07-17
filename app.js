const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false });

// ─── Database Init ───────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clinic_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS patients (
      id SERIAL PRIMARY KEY,
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
      appointment_date DATE NOT NULL,
      appointment_time TIME,
      status VARCHAR(20) DEFAULT 'scheduled',
      reason TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Create indexes
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_patients_contact ON patients(contact);
    CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(LOWER(name));
    CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id);
    CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(visit_date);
    CREATE INDEX IF NOT EXISTS idx_charges_patient ON charges(patient_id);
    CREATE INDEX IF NOT EXISTS idx_charges_date ON charges(charge_date);
    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appointment_date);
    CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);
  `);

  // Seed default settings
  const defaults = {
    doctor_name: 'Dr. Name',
    qualifications: 'MBBS, MD',
    clinic_name: 'My Clinic',
    clinic_address: 'Clinic Address',
    clinic_phone: '',
    registration_number: '',
    consultation_fee: '500',
    currency_symbol: '₹'
  };
  for (const [k, v] of Object.entries(defaults)) {
    await pool.query(`INSERT INTO clinic_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [k, v]);
  }
  console.log('Database initialized');
}

// ─── Settings ────────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM clinic_settings');
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', async (req, res) => {
  try {
    for (const [k, v] of Object.entries(req.body)) {
      await pool.query('INSERT INTO clinic_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [k, v]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Dashboard ───────────────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [totalPatients, todayAppointments, todayRevenue, pendingPayments, recentPatients, upcomingAppts] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM patients WHERE is_active = true'),
      pool.query("SELECT COUNT(*) FROM appointments WHERE appointment_date = $1 AND status != 'cancelled'", [today]),
      pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM charges WHERE charge_date::date = $1 AND payment_status = 'paid'", [today]),
      pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM charges WHERE payment_status = 'pending'"),
      pool.query('SELECT id, name, contact, created_at FROM patients WHERE is_active = true ORDER BY created_at DESC LIMIT 5'),
      pool.query(`SELECT a.*, p.name as patient_name, p.contact as patient_contact
        FROM appointments a JOIN patients p ON a.patient_id = p.id
        WHERE a.appointment_date = $1 AND a.status != 'cancelled'
        ORDER BY a.appointment_time ASC NULLS LAST`, [today])
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
app.get('/api/patients', async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let query, countQuery, params;
    if (search && search.trim()) {
      const s = `%${search.trim()}%`;
      query = `SELECT * FROM patients WHERE is_active = true AND (LOWER(name) LIKE LOWER($1) OR contact LIKE $1) ORDER BY name ASC LIMIT $2 OFFSET $3`;
      countQuery = `SELECT COUNT(*) FROM patients WHERE is_active = true AND (LOWER(name) LIKE LOWER($1) OR contact LIKE $1)`;
      params = [s, limit, offset];
    } else {
      query = `SELECT * FROM patients WHERE is_active = true ORDER BY updated_at DESC LIMIT $1 OFFSET $2`;
      countQuery = `SELECT COUNT(*) FROM patients WHERE is_active = true`;
      params = [limit, offset];
    }
    const [{ rows }, countRes] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, search && search.trim() ? [`%${search.trim()}%`] : [])
    ]);
    res.json({ patients: rows, total: parseInt(countRes.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/patients/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM patients WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Patient not found' });
    // Get visit count and last visit
    const stats = await pool.query(`SELECT COUNT(*) as visit_count, MAX(visit_date) as last_visit FROM visits WHERE patient_id = $1`, [req.params.id]);
    const totalCharges = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total_charges, COALESCE(SUM(CASE WHEN payment_status = 'pending' THEN amount ELSE 0 END), 0) as pending FROM charges WHERE patient_id = $1`, [req.params.id]);
    res.json({
      ...rows[0],
      visit_count: parseInt(stats.rows[0].visit_count),
      last_visit: stats.rows[0].last_visit,
      total_charges: parseFloat(totalCharges.rows[0].total_charges),
      pending_amount: parseFloat(totalCharges.rows[0].pending)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/patients', async (req, res) => {
  try {
    const { name, dob, gender, contact, email, address, blood_group, allergies, medical_history, notes } = req.body;
    if (!name || !contact) return res.status(400).json({ error: 'Name and contact are required' });
    // Check duplicate contact
    const dup = await pool.query('SELECT id, name FROM patients WHERE contact = $1 AND is_active = true', [contact]);
    if (dup.rows.length) return res.status(409).json({ error: `Patient "${dup.rows[0].name}" already exists with this contact number`, existing_id: dup.rows[0].id });
    const { rows } = await pool.query(
      `INSERT INTO patients (name, dob, gender, contact, email, address, blood_group, allergies, medical_history, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name, dob || null, gender, contact, email, address, blood_group, allergies, medical_history, notes]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/patients/:id', async (req, res) => {
  try {
    const { name, dob, gender, contact, email, address, blood_group, allergies, medical_history, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE patients SET name=$1, dob=$2, gender=$3, contact=$4, email=$5, address=$6,
       blood_group=$7, allergies=$8, medical_history=$9, notes=$10, updated_at=NOW()
       WHERE id=$11 RETURNING *`,
      [name, dob || null, gender, contact, email, address, blood_group, allergies, medical_history, notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Patient not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/patients/:id', async (req, res) => {
  try {
    await pool.query('UPDATE patients SET is_active = false, updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Visits ──────────────────────────────────────────────────────
app.get('/api/patients/:id/visits', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.*, 
        (SELECT json_agg(row_to_json(p)) FROM prescriptions p WHERE p.visit_id = v.id) as prescriptions,
        (SELECT json_agg(row_to_json(c)) FROM charges c WHERE c.visit_id = v.id) as charges
       FROM visits v WHERE v.patient_id = $1 ORDER BY v.visit_date DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/visits/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT v.*, p.name as patient_name, p.contact as patient_contact, p.dob as patient_dob, p.gender as patient_gender, p.allergies as patient_allergies
      FROM visits v JOIN patients p ON v.patient_id = p.id WHERE v.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Visit not found' });
    const prescriptions = await pool.query('SELECT * FROM prescriptions WHERE visit_id = $1', [req.params.id]);
    const charges = await pool.query('SELECT * FROM charges WHERE visit_id = $1', [req.params.id]);
    res.json({ ...rows[0], prescriptions: prescriptions.rows, charges: charges.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/visits', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { patient_id, chief_complaint, examination, diagnosis, notes, bp_systolic, bp_diastolic, pulse, temperature, weight, height, spo2, follow_up_date, medicines, advice, charges } = req.body;

    // Create visit
    const visitRes = await client.query(
      `INSERT INTO visits (patient_id, chief_complaint, examination, diagnosis, notes, bp_systolic, bp_diastolic, pulse, temperature, weight, height, spo2, follow_up_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [patient_id, chief_complaint, examination, diagnosis, notes, bp_systolic||null, bp_diastolic||null, pulse||null, temperature||null, weight||null, height||null, spo2||null, follow_up_date||null]
    );
    const visit = visitRes.rows[0];

    // Create prescription
    if (medicines && medicines.length) {
      await client.query(
        `INSERT INTO prescriptions (visit_id, patient_id, medicines, advice) VALUES ($1,$2,$3,$4)`,
        [visit.id, patient_id, JSON.stringify(medicines), advice || '']
      );
    }

    // Create charges
    if (charges && charges.length) {
      for (const ch of charges) {
        await client.query(
          `INSERT INTO charges (visit_id, patient_id, description, amount, payment_mode, payment_status, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [visit.id, patient_id, ch.description, ch.amount, ch.payment_mode || 'cash', ch.payment_status || 'paid', ch.notes || '']
        );
      }
    }

    // Update patient's updated_at
    await client.query('UPDATE patients SET updated_at = NOW() WHERE id = $1', [patient_id]);

    // Mark today's appointment as completed if exists
    const today = new Date().toISOString().split('T')[0];
    await client.query(`UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE patient_id = $1 AND appointment_date = $2 AND status = 'scheduled'`, [patient_id, today]);

    await client.query('COMMIT');
    res.json(visit);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.put('/api/visits/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { chief_complaint, examination, diagnosis, notes, bp_systolic, bp_diastolic, pulse, temperature, weight, height, spo2, follow_up_date, medicines, advice } = req.body;

    const visitRes = await client.query(
      `UPDATE visits SET chief_complaint=$1, examination=$2, diagnosis=$3, notes=$4,
       bp_systolic=$5, bp_diastolic=$6, pulse=$7, temperature=$8, weight=$9, height=$10, spo2=$11, follow_up_date=$12
       WHERE id=$13 RETURNING *`,
      [chief_complaint, examination, diagnosis, notes, bp_systolic||null, bp_diastolic||null, pulse||null, temperature||null, weight||null, height||null, spo2||null, follow_up_date||null, req.params.id]
    );
    if (!visitRes.rows.length) throw new Error('Visit not found');

    // Update prescription
    await client.query('DELETE FROM prescriptions WHERE visit_id = $1', [req.params.id]);
    if (medicines && medicines.length) {
      await client.query(
        `INSERT INTO prescriptions (visit_id, patient_id, medicines, advice) VALUES ($1,$2,$3,$4)`,
        [req.params.id, visitRes.rows[0].patient_id, JSON.stringify(medicines), advice || '']
      );
    }

    await client.query('COMMIT');
    res.json(visitRes.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ─── Prescription (for print) ────────────────────────────────────
app.get('/api/visits/:id/prescription', async (req, res) => {
  try {
    const visit = await pool.query(`SELECT v.*, p.name as patient_name, p.dob as patient_dob, p.gender as patient_gender, p.contact as patient_contact, p.allergies as patient_allergies
      FROM visits v JOIN patients p ON v.patient_id = p.id WHERE v.id = $1`, [req.params.id]);
    if (!visit.rows.length) return res.status(404).json({ error: 'Visit not found' });
    const rx = await pool.query('SELECT * FROM prescriptions WHERE visit_id = $1', [req.params.id]);
    const settings = await pool.query('SELECT key, value FROM clinic_settings');
    const config = {};
    settings.rows.forEach(r => config[r.key] = r.value);
    res.json({ visit: visit.rows[0], prescription: rx.rows[0] || null, clinic: config });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Charges ─────────────────────────────────────────────────────
app.get('/api/patients/:id/charges', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM charges WHERE patient_id = $1 ORDER BY charge_date DESC', [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/charges', async (req, res) => {
  try {
    const { patient_id, visit_id, description, amount, payment_mode, payment_status, notes } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO charges (patient_id, visit_id, description, amount, payment_mode, payment_status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [patient_id, visit_id || null, description, amount, payment_mode || 'cash', payment_status || 'paid', notes]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/charges/:id', async (req, res) => {
  try {
    const { description, amount, payment_mode, payment_status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE charges SET description=$1, amount=$2, payment_mode=$3, payment_status=$4, notes=$5 WHERE id=$6 RETURNING *`,
      [description, amount, payment_mode, payment_status, notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Charge not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/charges/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM charges WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Appointments ────────────────────────────────────────────────
app.get('/api/appointments', async (req, res) => {
  try {
    const { date, status, patient_id } = req.query;
    let query = `SELECT a.*, p.name as patient_name, p.contact as patient_contact
      FROM appointments a JOIN patients p ON a.patient_id = p.id WHERE 1=1`;
    const params = [];
    if (date) { params.push(date); query += ` AND a.appointment_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND a.status = $${params.length}`; }
    if (patient_id) { params.push(patient_id); query += ` AND a.patient_id = $${params.length}`; }
    query += ' ORDER BY a.appointment_date ASC, a.appointment_time ASC NULLS LAST';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/appointments', async (req, res) => {
  try {
    const { patient_id, appointment_date, appointment_time, reason, notes } = req.body;
    if (!patient_id || !appointment_date) return res.status(400).json({ error: 'Patient and date required' });
    const { rows } = await pool.query(
      `INSERT INTO appointments (patient_id, appointment_date, appointment_time, reason, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [patient_id, appointment_date, appointment_time || null, reason, notes]
    );
    // Join patient info
    const full = await pool.query(`SELECT a.*, p.name as patient_name, p.contact as patient_contact
      FROM appointments a JOIN patients p ON a.patient_id = p.id WHERE a.id = $1`, [rows[0].id]);
    res.json(full.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/appointments/:id', async (req, res) => {
  try {
    const { appointment_date, appointment_time, status, reason, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE appointments SET appointment_date=COALESCE($1, appointment_date), appointment_time=COALESCE($2, appointment_time),
       status=COALESCE($3, status), reason=COALESCE($4, reason), notes=COALESCE($5, notes), updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [appointment_date, appointment_time, status, reason, notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Appointment not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/appointments/:id', async (req, res) => {
  try {
    await pool.query("UPDATE appointments SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Reports ─────────────────────────────────────────────────────
app.get('/api/reports/revenue', async (req, res) => {
  try {
    const { from, to, group_by = 'day' } = req.query;
    const fmt = group_by === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
    let query = `SELECT to_char(charge_date, '${fmt}') as period,
      SUM(CASE WHEN payment_status = 'paid' THEN amount ELSE 0 END) as paid,
      SUM(CASE WHEN payment_status = 'pending' THEN amount ELSE 0 END) as pending,
      SUM(amount) as total,
      COUNT(*) as count
      FROM charges WHERE 1=1`;
    const params = [];
    if (from) { params.push(from); query += ` AND charge_date >= $${params.length}`; }
    if (to) { params.push(to + 'T23:59:59'); query += ` AND charge_date <= $${params.length}`; }
    query += ` GROUP BY period ORDER BY period DESC`;
    const { rows } = await pool.query(query, params);

    // Payment mode breakdown
    let modeQuery = `SELECT payment_mode, SUM(amount) as total, COUNT(*) as count FROM charges WHERE payment_status = 'paid'`;
    const modeParams = [];
    if (from) { modeParams.push(from); modeQuery += ` AND charge_date >= $${modeParams.length}`; }
    if (to) { modeParams.push(to + 'T23:59:59'); modeQuery += ` AND charge_date <= $${modeParams.length}`; }
    modeQuery += ' GROUP BY payment_mode';
    const modes = await pool.query(modeQuery, modeParams);

    // Totals
    let totalQuery = `SELECT COALESCE(SUM(amount), 0) as grand_total,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN amount ELSE 0 END), 0) as total_paid,
      COALESCE(SUM(CASE WHEN payment_status = 'pending' THEN amount ELSE 0 END), 0) as total_pending,
      COUNT(*) as total_transactions FROM charges WHERE 1=1`;
    const totalParams = [];
    if (from) { totalParams.push(from); totalQuery += ` AND charge_date >= $${totalParams.length}`; }
    if (to) { totalParams.push(to + 'T23:59:59'); totalQuery += ` AND charge_date <= $${totalParams.length}`; }
    const totals = await pool.query(totalQuery, totalParams);

    res.json({ periods: rows, modes: modes.rows, summary: totals.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/patients', async (req, res) => {
  try {
    const { from, to } = req.query;
    // New registrations by period
    let regQuery = `SELECT to_char(created_at, 'YYYY-MM-DD') as period, COUNT(*) as count
      FROM patients WHERE is_active = true`;
    const regParams = [];
    if (from) { regParams.push(from); regQuery += ` AND created_at >= $${regParams.length}`; }
    if (to) { regParams.push(to + 'T23:59:59'); regQuery += ` AND created_at <= $${regParams.length}`; }
    regQuery += ` GROUP BY period ORDER BY period DESC`;
    const regs = await pool.query(regQuery, regParams);

    // Gender distribution
    const genderDist = await pool.query(`SELECT COALESCE(gender, 'Not specified') as gender, COUNT(*) as count FROM patients WHERE is_active = true GROUP BY gender`);

    // Age distribution
    const ageDist = await pool.query(`SELECT
      CASE
        WHEN dob IS NULL THEN 'Unknown'
        WHEN EXTRACT(YEAR FROM age(dob)) < 18 THEN '0-17'
        WHEN EXTRACT(YEAR FROM age(dob)) < 30 THEN '18-29'
        WHEN EXTRACT(YEAR FROM age(dob)) < 45 THEN '30-44'
        WHEN EXTRACT(YEAR FROM age(dob)) < 60 THEN '45-59'
        ELSE '60+'
      END as age_group, COUNT(*) as count
      FROM patients WHERE is_active = true GROUP BY age_group ORDER BY age_group`);

    const total = await pool.query('SELECT COUNT(*) FROM patients WHERE is_active = true');

    res.json({ registrations: regs.rows, gender: genderDist.rows, age: ageDist.rows, total: parseInt(total.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/visits', async (req, res) => {
  try {
    const { from, to, search, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let query = `SELECT v.*, p.name as patient_name, p.contact as patient_contact
      FROM visits v JOIN patients p ON v.patient_id = p.id WHERE 1=1`;
    const params = [];
    if (from) { params.push(from); query += ` AND v.visit_date >= $${params.length}`; }
    if (to) { params.push(to + 'T23:59:59'); query += ` AND v.visit_date <= $${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (LOWER(p.name) LIKE LOWER($${params.length}) OR p.contact LIKE $${params.length} OR LOWER(v.diagnosis) LIKE LOWER($${params.length}))`; }
    const countQuery = query.replace('SELECT v.*, p.name as patient_name, p.contact as patient_contact', 'SELECT COUNT(*)');
    params.push(limit); query += ` ORDER BY v.visit_date DESC LIMIT $${params.length}`;
    params.push(offset); query += ` OFFSET $${params.length}`;
    const [{ rows }, countRes] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, params.slice(0, -2))
    ]);
    res.json({ visits: rows, total: parseInt(countRes.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CSV export for reports
app.get('/api/reports/export/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { from, to } = req.query;
    let rows, headers;

    if (type === 'revenue') {
      const result = await pool.query(
        `SELECT c.charge_date, p.name as patient_name, p.contact, c.description, c.amount, c.payment_mode, c.payment_status
         FROM charges c JOIN patients p ON c.patient_id = p.id
         WHERE ($1::date IS NULL OR c.charge_date >= $1) AND ($2::date IS NULL OR c.charge_date <= $2::date + 1)
         ORDER BY c.charge_date DESC`,
        [from || null, to || null]
      );
      rows = result.rows;
      headers = ['Date', 'Patient', 'Contact', 'Description', 'Amount', 'Payment Mode', 'Status'];
    } else if (type === 'visits') {
      const result = await pool.query(
        `SELECT v.visit_date, p.name as patient_name, p.contact, v.chief_complaint, v.diagnosis, v.bp_systolic, v.bp_diastolic, v.pulse, v.temperature, v.weight
         FROM visits v JOIN patients p ON v.patient_id = p.id
         WHERE ($1::date IS NULL OR v.visit_date >= $1) AND ($2::date IS NULL OR v.visit_date <= $2::date + 1)
         ORDER BY v.visit_date DESC`,
        [from || null, to || null]
      );
      rows = result.rows;
      headers = ['Date', 'Patient', 'Contact', 'Complaint', 'Diagnosis', 'BP Sys', 'BP Dia', 'Pulse', 'Temp', 'Weight'];
    } else if (type === 'patients') {
      const result = await pool.query(
        `SELECT name, contact, dob, gender, blood_group, email, address, allergies, created_at FROM patients WHERE is_active = true ORDER BY name`
      );
      rows = result.rows;
      headers = ['Name', 'Contact', 'DOB', 'Gender', 'Blood Group', 'Email', 'Address', 'Allergies', 'Registered'];
    } else {
      return res.status(400).json({ error: 'Invalid report type' });
    }

    // Build CSV
    const escape = v => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s; };
    let csv = headers.join(',') + '\n';
    rows.forEach(row => {
      csv += Object.values(row).map(escape).join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${type}_report.csv`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Patient search for autocomplete ─────────────────────────────
app.get('/api/patients/search/quick', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, name, contact, gender FROM patients WHERE is_active = true AND (LOWER(name) LIKE LOWER($1) OR contact LIKE $1) LIMIT 10`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Clinic Manager running on port ${PORT}`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
