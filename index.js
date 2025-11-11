const express = require('express');
const app = express();
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const admin = require('firebase-admin');
const NodeCache = require('node-cache');
const AdmZip = require('adm-zip');
const path = require('path');
require('dotenv').config();

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
const cache = new NodeCache({ stdTTL: 300 }); // 5 minutes

// ✅ FIX 1: Firebase setup BEFORE app initialization
let serviceAccount;
try {
  if (process.env.FCM_CREDENTIALS) {
    serviceAccount = JSON.parse(process.env.FCM_CREDENTIALS);
    console.log('✅ FCM credentials loaded from environment');
  } else {
    serviceAccount = require('./firebase-service-account.json');
    console.log('✅ FCM credentials loaded from file');
  }
} catch (error) {
  console.error('⚠️ Firebase credentials not found:', error.message);
}


// ✅ FIX 2: Port configuration - Render assigns its own port
const port = process.env.PORT || 3001;

// ✅ FIX 3: Configure multer BEFORE routes
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') ||
      file.mimetype.includes('pdf') ||
      file.mimetype.includes('document') ||
      file.mimetype.includes('sheet') ||
      file.mimetype.includes('excel') ||
      file.mimetype.includes('csv') ||
      file.mimetype.includes('zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only images, PDFs, Excel files, and ZIP files are allowed'));
    }
  }
});

// ✅ FIX 4: Database pool configuration for Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : false, // Disable SSL for local
});

// ✅ FIX 7: Static files
app.use('/uploads', express.static('uploads'));

// ✅ FIX 8: Content-Type header
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// ✅ FIX 9: Test route - MUST BE BEFORE OTHER ROUTES
app.get('/', (req, res) => {
  res.json({ 
    success: true,
    message: "MyDSchool Backend API is running!",
    timestamp: new Date().toISOString(),
    endpoints: {
      test: '/api/test',
      login: '/api/login',
      students: '/api/admin/students'
    }
  });
});

app.get('/api/test', (req, res) => {
  console.log('📍 /api/test endpoint hit');
  res.json({ 
    success: true,
    message: "Backend connected successfully!",
    timestamp: new Date().toISOString()
  });
});

// ✅ FIX 10: Firebase initialization
if (serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin initialized');
  } catch (error) {
    console.error('❌ Firebase initialization error:', error.message);
  }
} else {
  console.log('⚠️ Firebase Admin not initialized - FCM disabled');
}

// ✅ FIX 11: Database connection test
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error acquiring client', err.stack);
  } else {
    console.log('✅ Database connected successfully');
    release();
  }
});
// ========== HELPER FUNCTION FOR FCM BATCH SENDING ==========
async function sendBatchFCM(tokens, data) {
  if (!tokens || tokens.length === 0) {
    console.log('⚠️ No FCM tokens to send');
    return { success: 0, failed: 0 };
  }

  console.log(`📤 Sending FCM to ${tokens.length} students`);

  // Split into chunks of 500
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) {
    chunks.push(tokens.slice(i, i + 500));
  }

  let successCount = 0;
  let failedCount = 0;

  // Send all chunks
  for (const chunk of chunks) {
    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens: chunk,
        data: data,
        android: {
          priority: 'high'
        },
        apns: {
          headers: {
            'apns-priority': '10'
          }
        }
      });

      successCount += response.successCount;
      failedCount += response.failureCount;

      console.log(`✅ Batch sent: ${response.successCount} success, ${response.failureCount} failed`);
    } catch (err) {
      console.error(`❌ FCM batch error:`, err.message);
      failedCount += chunk.length;
    }
  }

  console.log(`✅ Total FCM sent: ${successCount}/${tokens.length} successful`);
  return { success: successCount, failed: failedCount };
}
// ========== ROUTES START HERE ==========
app.post('/api/login', async (req, res) => {
  try {
    console.log('📍 Login request received');
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required',
        user: null
      });
    }

    // Query user from database
    const result = await pool.query(
      'SELECT id, username, password, role, student_id FROM users WHERE username = $1 AND password = $2',
      [username, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password',
        user: null
      });
    }

    const user = result.rows[0];
    
    // ✅ CRITICAL FIX: Always query the students table to get the correct student_id
    let studentId = null;
    
    if (user.role === 'student') {
      // Query students table using user.id (NOT student_id from users table)
      const studentResult = await pool.query(
        'SELECT id FROM students WHERE user_id = $1',
        [user.id]
      );

      if (studentResult.rows.length > 0) {
        studentId = studentResult.rows[0].id;
        
        console.log(`✅ Login successful:
          - User ID: ${user.id}
          - Username: ${user.username}
          - Student ID from users table: ${user.student_id}
          - Student ID from students table: ${studentId}
        `);
        
        // If they don't match, there's a data inconsistency
        if (user.student_id !== studentId) {
          console.warn(`⚠️ WARNING: Mismatch detected!
            - users.student_id = ${user.student_id}
            - students.id (WHERE user_id=${user.id}) = ${studentId}
            - Using students table value: ${studentId}
          `);
        }
      } else {
        console.error(`❌ No student record found for user_id=${user.id}`);
        return res.status(404).json({
          success: false,
          message: 'Student record not found for this user',
          user: null
        });
      }
    }

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        studentId: studentId  // ✅ Use the value from students table
      }
    });

  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      user: null
    });
  }
});
app.get('/api/setup-admin', async (req, res) => {
  try {
    // Check if admin exists
    const existing = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      ['admin']
    );

    if (existing.rows.length > 0) {
      return res.json({ 
        success: true, 
        message: 'Admin user already exists',
        user: existing.rows[0]
      });
    }

    // Create admin user
    const result = await pool.query(
      'INSERT INTO users (username, password, role, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *',
      ['admin', 'admin@123', 'admin']
    );

    res.json({ 
      success: true, 
      message: 'Admin user created',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Setup error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});
// ========== SECTIONS API ==========
app.get('/api/admin/sections', async (req, res) => {
  try {
    const cacheKey = 'sections_all';
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✅ Cache hit - sections');
      return res.json(cached);
    }

    const result = await pool.query('SELECT * FROM sections ORDER BY created_at DESC');
    
    const response = { success: true, sections: result.rows };
    cache.set(cacheKey, response);
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching sections:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch sections' });
  }
});

app.post('/api/admin/sections', async (req, res) => {
  try {
    const { section_name, start_time, end_time } = req.body;

    if (!section_name || !start_time || !end_time) {
      return res.status(400).json({
        success: false,
        message: 'Section name, start time, and end time are required'
      });
    }

    const existingSection = await pool.query(
      'SELECT * FROM sections WHERE section_name = $1 AND start_time = $2 AND end_time = $3',
      [section_name, start_time, end_time]
    );

    if (existingSection.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'A section with the same name and timing already exists'
      });
    }

    const result = await pool.query(
      'INSERT INTO sections (section_name, start_time, end_time, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [section_name, start_time, end_time]
    );

    cache.del('sections_all');

    res.json({
      success: true,
      message: 'Section added successfully',
      section: result.rows[0]
    });
  } catch (error) {
    console.error('Error adding section:', error);
    res.status(500).json({ success: false, message: 'Failed to add section' });
  }
});

app.delete('/api/admin/sections/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid section ID'
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const classCheck = await client.query(
        'SELECT COUNT(*) as count FROM classes WHERE section_id = $1',
        [id]
      );

      if (parseInt(classCheck.rows[0].count) > 0) {
        return res.status(409).json({
          success: false,
          message: 'Cannot delete section. It is being used by existing classes.'
        });
      }

      const result = await client.query(
        'DELETE FROM sections WHERE id = $1 RETURNING *',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Section not found'
        });
      }

      await client.query('COMMIT');
      cache.del('sections_all');

      res.json({
        success: true,
        message: 'Section deleted successfully'
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error deleting section:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete section'
    });
  }
});

// ========== CLASSES API ==========
app.get('/api/admin/classes', async (req, res) => {
  try {
    const cacheKey = 'classes_all';
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✅ Cache hit - classes');
      return res.json(cached);
    }

    const result = await pool.query(`
      SELECT 
        c.*,
        s.section_name
      FROM classes c 
      LEFT JOIN sections s ON c.section_id = s.id
      ORDER BY c.created_at DESC
    `);

    const response = { success: true, classes: result.rows };
    cache.set(cacheKey, response);
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching classes:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch classes' });
  }
});

app.post('/api/admin/classes', async (req, res) => {
  try {
    const { class_name, section_id, teacher_name } = req.body;

    if (!class_name || !section_id || !teacher_name) {
      return res.status(400).json({
        success: false,
        message: 'Class name, section, and teacher name are required'
      });
    }

    const result = await pool.query(`
      INSERT INTO classes (class_name, section_id, teacher_name)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [class_name, section_id, teacher_name]);

    cache.del('classes_all');

    res.json({
      success: true,
      message: 'Class added successfully',
      class: result.rows[0]
    });

  } catch (error) {
    console.error('Error adding class:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add class',
      error: error.message
    });
  }
});

app.delete('/api/admin/classes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid class ID'
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const studentCheck = await client.query(
        'SELECT COUNT(*) as count FROM students WHERE class_id = $1',
        [id]
      );

      if (parseInt(studentCheck.rows[0].count) > 0) {
        return res.status(409).json({
          success: false,
          message: 'Cannot delete class. It has enrolled students.'
        });
      }

      const result = await client.query(
        'DELETE FROM classes WHERE id = $1 RETURNING *',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Class not found'
        });
      }

      await client.query('COMMIT');
      cache.del('classes_all');

      res.json({
        success: true,
        message: 'Class deleted successfully'
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error deleting class:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete class'
    });
  }
});

// ========== STUDENTS API ==========
app.get('/api/admin/students', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.*,
        u.username,
        u.email,
        c.class_name,
        sec.section_name
      FROM students s 
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN classes c ON s.class_id = c.id 
      LEFT JOIN sections sec ON c.section_id = sec.id
      ORDER BY s.created_at DESC
    `);

    res.json({
      success: true,
      students: result.rows
    });
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch students',
      error: error.message
    });
  }
});

app.get('/api/admin/students/class/:classId', async (req, res) => {
  try {
    const { classId } = req.params;

    if (!classId || isNaN(classId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid class ID'
      });
    }

    const result = await pool.query(`
      SELECT s.id, s.first_name, s.last_name, s.roll_number, s.class_id
      FROM students s 
      WHERE s.class_id = $1
      ORDER BY s.roll_number
    `, [classId]);

    res.json({
      success: true,
      students: result.rows
    });
  } catch (error) {
    console.error('Error fetching students by class:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch students',
      error: error.message
    });
  }
});

app.post('/api/admin/students', upload.single('photo'), async (req, res) => {
  try {
    const {
      class_id, first_name, last_name, roll_number, username, password,
      email, phone, address, date_of_birth, blood_group,
      parent_name, parent_phone, parent_email
    } = req.body;

    const profile_photo = req.file ? req.file.path : null;

    if (!first_name || !last_name || !username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Required fields: first_name, last_name, username, password'
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingUser = await client.query('SELECT id FROM users WHERE username = $1', [username]);
      if (existingUser.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'Username already exists'
        });
      }

      if (class_id && roll_number) {
        const existingRoll = await client.query(
          'SELECT id FROM students WHERE roll_number = $1 AND class_id = $2',
          [roll_number, class_id]
        );
        if (existingRoll.rows.length > 0) {
          return res.status(409).json({
            success: false,
            message: 'Roll number already exists in this class'
          });
        }
      }

      const userResult = await client.query(
        'INSERT INTO users (username, password, email, role, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id',
        [username, password, email || null, 'student']
      );

      const userId = userResult.rows[0].id;

      const studentResult = await client.query(`
        INSERT INTO students (
          user_id, class_id, first_name, last_name, roll_number,
          phone, address, date_of_birth, blood_group,
          parent_name, parent_phone, parent_email, profile_photo,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW()) 
        RETURNING *
      `, [
        userId, class_id || null, first_name, last_name, roll_number || null,
        phone || null, address || null, date_of_birth || null, blood_group || null,
        parent_name || null, parent_phone || null, parent_email || null, profile_photo
      ]);

      const studentId = studentResult.rows[0].id;
        await client.query(
          'UPDATE users SET student_id = $1 WHERE id = $2',
          [studentId, userId]
        );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Student added successfully',
        student: studentResult.rows[0]
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error adding student:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add student',
      error: error.message
    });
  }
});

app.put('/api/admin/students/:id', upload.single('photo'), async (req, res) => {
  try {
    const studentId = req.params.id;
    const {
      class_id, first_name, last_name, roll_number,
      phone, address, date_of_birth, blood_group,
      parent_name, parent_phone, parent_email, email
    } = req.body;

    const profile_photo = req.file ? req.file.path : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const updateStudentQuery = `
        UPDATE students
        SET 
          class_id = $1,
          first_name = $2,
          last_name = $3,
          roll_number = $4,
          phone = $5,
          address = $6,
          date_of_birth = $7,
          blood_group = $8,
          parent_name = $9,
          parent_phone = $10,
          parent_email = $11,
          profile_photo = COALESCE($12, profile_photo),
          updated_at = NOW()
        WHERE id = $13
        RETURNING *;
      `;

      const studentResult = await client.query(updateStudentQuery, [
        class_id || null, first_name, last_name, roll_number || null,
        phone || null, address || null, date_of_birth || null, blood_group || null,
        parent_name || null, parent_phone || null, parent_email || null,
        profile_photo, studentId
      ]);

      if (email) {
        await client.query(
          'UPDATE users SET email = $1, updated_at = NOW() WHERE id = (SELECT user_id FROM students WHERE id = $2)',
          [email, studentId]
        );
      }

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Student updated successfully',
        student: studentResult.rows[0]
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error updating student:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update student',
      error: error.message
    });
  }
});

app.delete('/api/admin/students/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid student ID'
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const studentInfo = await client.query(
        'SELECT s.*, u.username FROM students s JOIN users u ON s.user_id = u.id WHERE s.id = $1',
        [id]
      );

      if (studentInfo.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Student not found'
        });
      }

      const student = studentInfo.rows[0];
      const userId = student.user_id;

      await client.query('DELETE FROM students WHERE id = $1', [id]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);

      await client.query('COMMIT');

      res.json({
        success: true,
        message: `Student ${student.first_name} ${student.last_name} deleted successfully`
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error deleting student:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete student'
    });
  }
});

// ========== BULK UPLOAD (Excel Only) ==========
app.post('/api/admin/students/bulk-upload', upload.single('excelFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Excel file is required'
      });
    }

    const workbook = XLSX.readFile(req.file.path);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(worksheet);

    console.log('=== BULK UPLOAD START ===');
    console.log('Total rows:', data.length);

    if (!data.length) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        success: false,
        message: 'Excel file is empty'
      });
    }

    const mapField = (row, variations) => {
      const rowKeys = Object.keys(row);
      for (const variation of variations) {
        for (const key of rowKeys) {
          if (key.trim().toLowerCase() === variation.trim().toLowerCase()) {
            const val = String(row[key]).trim();
            if (val && val !== 'undefined' && val !== 'null') return val;
          }
        }
      }
      return null;
    };

    const convertExcelDate = (excelDate) => {
      if (!excelDate) return null;
      if (typeof excelDate === 'string') {
        if (/^\d{4}-\d{2}-\d{2}$/.test(excelDate)) return excelDate;
      }
      if (!isNaN(excelDate)) {
        const date = XLSX.SSF.parse_date_code(parseInt(excelDate));
        if (date) {
          return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
        }
      }
      return null;
    };

    const results = [];
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNum = i + 2;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const first_name = mapField(row, ['firstname', 'first name', 'first_name']);
        const last_name = mapField(row, ['lastname', 'last name', 'last_name']);
        const username = mapField(row, ['username', 'user name']);
        const password = mapField(row, ['password', 'pass']);
        const email = mapField(row, ['email', 'e-mail']);
        let class_id_str = mapField(row, ['classid', 'class', 'class id', 'class_id']);
        const roll_number = mapField(row, ['rollnumber', 'roll number', 'roll_no']);
        const phone = mapField(row, ['phone', 'mobile', 'contact']);
        const address = mapField(row, ['address']);
        const date_of_birth = mapField(row, ['dateofbirth', 'dob', 'birth date']);
        const formatted_dob = convertExcelDate(date_of_birth);
        const blood_group = mapField(row, ['bloodgroup', 'blood group']);
        const parent_name = mapField(row, ['parentname', 'parent name', 'guardian']);
        const parent_phone = mapField(row, ['parentphone', 'parent phone']);
        const parent_email = mapField(row, ['parentemail', 'parent email']);

        let class_id = null;

        if (class_id_str) {
          class_id_str = class_id_str.trim();

          if (/^\d+$/.test(class_id_str)) {
            class_id = parseInt(class_id_str);
          } else {
            const classResult = await client.query(
              'SELECT id FROM classes WHERE LOWER(class_name) = LOWER($1)',
              [class_id_str]
            );
            if (classResult.rows.length > 0) {
              class_id = classResult.rows[0].id;
            } else {
              await client.query('ROLLBACK');
              errors.push(`Row ${rowNum}: Class '${class_id_str}' not found`);
              client.release();
              continue;
            }
          }
        }

        if (!first_name || !last_name || !username || !password) {
          throw new Error('Missing required fields');
        }

        const existingUser = await client.query('SELECT id FROM users WHERE username = $1', [username]);
        if (existingUser.rows.length > 0) {
          throw new Error(`Username '${username}' already exists`);
        }

        if (class_id && roll_number) {
          const existingRoll = await client.query(
            'SELECT id FROM students WHERE roll_number = $1 AND class_id = $2',
            [roll_number, class_id]
          );
          if (existingRoll.rows.length > 0) {
            throw new Error(`Roll number '${roll_number}' already exists in class`);
          }
        }

        const userResult = await client.query(
          `INSERT INTO users (username, password, email, role, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id`,
          [username, password, email || null, 'student']
        );
        const userId = userResult.rows[0].id;

        const studentResult = await client.query(
          `INSERT INTO students (
            user_id, class_id, first_name, last_name, roll_number, 
            phone, address, date_of_birth, blood_group,
            parent_name, parent_phone, parent_email, 
            created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
          RETURNING *`,
          [
            userId, class_id || null, first_name, last_name, roll_number || null,
            phone || null, address || null, formatted_dob || null, blood_group || null,
            parent_name || null, parent_phone || null, parent_email || null
          ]
        );

        await client.query('COMMIT');
        results.push(studentResult.rows[0]);
        console.log(`✅ Row ${rowNum} imported successfully`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`❌ Error row ${rowNum}:`, err.message);
        errors.push(`Row ${rowNum}: ${err.message}`);
      } finally {
        client.release();
      }
    }

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    console.log('=== BULK UPLOAD COMPLETE ===');
    console.log(`Successful: ${results.length}, Failed: ${errors.length}`);

    return res.json({
      success: true,
      message: `Imported ${results.length}/${data.length} students`,
      data: { imported: results.length, failed: errors.length, errorDetails: errors }
    });

  } catch (error) {
    console.error('❌ Error in bulk upload:', error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.status(500).json({
      success: false,
      message: 'Failed to upload students',
      error: error.message
    });
  }
});

// ========== BULK UPLOAD (ZIP with Photos) ==========
app.post('/api/admin/students/bulk-upload-zip', upload.single('zipFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'ZIP file is required'
      });
    }

    console.log('=== ZIP BULK UPLOAD START ===');
    const zipPath = req.file.path;
    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries();

    let excelEntry = zipEntries.find(entry =>
      entry.entryName.match(/\.(xlsx|xls)$/i) &&
      !entry.entryName.startsWith('__MACOSX') &&
      !entry.isDirectory
    );

    if (!excelEntry) {
      fs.unlinkSync(zipPath);
      return res.status(400).json({
        success: false,
        message: 'No Excel file found in ZIP'
      });
    }

    console.log('✅ Found Excel file:', excelEntry.entryName);

    const excelBuffer = zip.readFile(excelEntry);
    const workbook = XLSX.read(excelBuffer);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(worksheet);

    console.log('Total rows:', data.length);

    if (!data.length) {
      fs.unlinkSync(zipPath);
      return res.status(400).json({
        success: false,
        message: 'Excel file is empty'
      });
    }

    const mapField = (row, variations) => {
      const rowKeys = Object.keys(row);
      for (const variation of variations) {
        for (const key of rowKeys) {
          if (key.trim().toLowerCase() === variation.trim().toLowerCase()) {
            const val = String(row[key]).trim();
            if (val && val !== 'undefined' && val !== 'null') return val;
          }
        }
      }
      return null;
    };

    const convertExcelDate = (excelDate) => {
      if (!excelDate) return null;
      if (typeof excelDate === 'string') {
        if (/^\d{4}-\d{2}-\d{2}$/.test(excelDate)) return excelDate;
      }
      if (!isNaN(excelDate)) {
        const date = XLSX.SSF.parse_date_code(parseInt(excelDate));
        if (date) {
          return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
        }
      }
      return null;
    };

    const results = [];
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNum = i + 2;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const first_name = mapField(row, ['firstname', 'first name', 'first_name']);
        const last_name = mapField(row, ['lastname', 'last name', 'last_name']);
        const username = mapField(row, ['username', 'user name']);
        const password = mapField(row, ['password', 'pass']);
        const email = mapField(row, ['email', 'e-mail']);
        let class_id_str = mapField(row, ['classid', 'class', 'class id', 'class_id']);
        const roll_number = mapField(row, ['rollnumber', 'roll number', 'roll_no']);
        const phone = mapField(row, ['phone', 'mobile', 'contact']);
        const address = mapField(row, ['address']);
        const date_of_birth = mapField(row, ['dateofbirth', 'dob', 'birth date']);
        const formatted_dob = convertExcelDate(date_of_birth);
        const blood_group = mapField(row, ['bloodgroup', 'blood group']);
        const parent_name = mapField(row, ['parentname', 'parent name', 'guardian']);
        const parent_phone = mapField(row, ['parentphone', 'parent phone']);
        const parent_email = mapField(row, ['parentemail', 'parent email']);

        const photo_filename = mapField(row, [
          'photo', 'photo_filename', 'Photos', 'photofilename',
          'image', 'picture', 'photo_file', 'filename'
        ]);

        console.log(`\n📝 Processing Row ${rowNum}: ${username}`);
        console.log(`   Photo filename: ${photo_filename}`);

        let class_id = null;
        if (class_id_str) {
          class_id_str = class_id_str.trim();
          if (/^\d+$/.test(class_id_str)) {
            class_id = parseInt(class_id_str);
          } else {
            const classResult = await client.query(
              'SELECT id FROM classes WHERE LOWER(class_name) = LOWER($1)',
              [class_id_str]
            );
            if (classResult.rows.length > 0) {
              class_id = classResult.rows[0].id;
            } else {
              await client.query('ROLLBACK');
              errors.push(`Row ${rowNum}: Class '${class_id_str}' not found`);
              client.release();
              continue;
            }
          }
        }

        if (!first_name || !last_name || !username || !password) {
          throw new Error('Missing required fields');
        }

        const existingUser = await client.query('SELECT id FROM users WHERE username = $1', [username]);
        if (existingUser.rows.length > 0) {
          throw new Error(`Username '${username}' already exists`);
        }

        if (class_id && roll_number) {
          const existingRoll = await client.query(
            'SELECT id FROM students WHERE roll_number = $1 AND class_id = $2',
            [roll_number, class_id]
          );
          if (existingRoll.rows.length > 0) {
            throw new Error(`Roll number '${roll_number}' already exists`);
          }
        }

        let profile_photo = null;
        if (photo_filename) {
          const photoEntry = zipEntries.find(entry => {
            const entryName = entry.entryName.toLowerCase();
            const searchName = photo_filename.toLowerCase();
            return entryName.includes(searchName) &&
              !entry.isDirectory &&
              !entryName.startsWith('__MACOSX');
          });

          if (photoEntry) {
            try {
              const photoBuffer = zip.readFile(photoEntry);
              const ext = path.extname(photoEntry.entryName);
              const newFilename = `${Date.now()}-${username}${ext}`;
              const photoPath = path.join('uploads', newFilename);

              fs.writeFileSync(photoPath, photoBuffer);
              profile_photo = photoPath;
              console.log(`   ✅ Photo extracted: ${photoPath}`);
            } catch (photoErr) {
              console.log(`   ⚠️ Failed to extract photo: ${photoErr.message}`);
            }
          } else {
            console.log(`   ⚠️ Photo not found in ZIP: ${photo_filename}`);
          }
        }

        const userResult = await client.query(
          `INSERT INTO users (username, password, email, role, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id`,
          [username, password, email || null, 'student']
        );
        const userId = userResult.rows[0].id;

        const studentResult = await client.query(
          `INSERT INTO students (
            user_id, class_id, first_name, last_name, roll_number, 
            phone, address, date_of_birth, blood_group,
            parent_name, parent_phone, parent_email, profile_photo, 
            created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
          RETURNING *`,
          [
            userId, class_id || null, first_name, last_name, roll_number || null,
            phone || null, address || null, formatted_dob || null, blood_group || null,
            parent_name || null, parent_phone || null, parent_email || null, profile_photo
          ]
        );

        await client.query('COMMIT');
        results.push(studentResult.rows[0]);
        console.log(`✅ Row ${rowNum} imported successfully`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`❌ Error row ${rowNum}:`, err.message);
        errors.push(`Row ${rowNum}: ${err.message}`);
      } finally {
        client.release();
      }
    }

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    console.log('\n=== ZIP BULK UPLOAD COMPLETE ===');
    console.log(`Successful: ${results.length}, Failed: ${errors.length}`);

    return res.json({
      success: true,
      message: `Imported ${results.length}/${data.length} students with photos`,
      data: {
        imported: results.length,
        failed: errors.length,
        errorDetails: errors,
        photosUploaded: results.filter(r => r.profile_photo).length
      }
    });

  } catch (error) {
    console.error('❌ Error in ZIP bulk upload:', error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.status(500).json({
      success: false,
      message: 'Failed to upload students from ZIP',
      error: error.message
    });
  }
});

// ========== STUDENT PROFILE API WITH CACHING ==========
app.get('/api/student/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const cacheKey = `profile_${userId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✅ Cache hit - profile');
      return res.json(cached);
    }

    console.log('=== FETCHING PROFILE ===');

    if (!userId || isNaN(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID'
      });
    }

    let result = await pool.query(`
      SELECT 
        s.*,
        u.username,
        u.email,
        c.class_name,
        c.id as class_id,
        sec.section_name
      FROM students s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN classes c ON s.class_id = c.id
      LEFT JOIN sections sec ON c.section_id = sec.id
      WHERE s.user_id = $1
    `, [userId]);

    if (result.rows.length === 0) {
      result = await pool.query(`
        SELECT 
          s.*,
          u.username,
          u.email,
          c.class_name,
          c.id as class_id,
          sec.section_name
        FROM students s
        LEFT JOIN users u ON s.user_id = u.id
        LEFT JOIN classes c ON s.class_id = c.id
        LEFT JOIN sections sec ON c.section_id = sec.id
        WHERE s.id = $1
      `, [userId]);
    }

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Student profile not found'
      });
    }

    const response = {
      success: true,
      profile: result.rows[0]
    };
    
    cache.set(cacheKey, response);
    res.json(response);
    
  } catch (error) {
    console.error('❌ Error fetching profile:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch profile: ' + error.message
    });
  }
});

app.post('/api/student/profile/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;

    if (!studentId || isNaN(studentId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid student ID',
        profile: null
      });
    }

    const { address, phone, blood_group, email, parent_phone, parent_email } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let studentCheck = await client.query(
        'SELECT id, user_id FROM students WHERE user_id = $1',
        [studentId]
      );

      if (studentCheck.rows.length === 0) {
        studentCheck = await client.query(
          'SELECT id, user_id FROM students WHERE id = $1',
          [studentId]
        );
      }

      if (studentCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Student profile not found',
          profile: null
        });
      }

      const actualUserId = studentCheck.rows[0].user_id;

      await client.query(`
        UPDATE students SET 
          address = $1,
          phone = $2,
          blood_group = $3,
          parent_phone = $4,
          parent_email = $5,
          updated_at = NOW()
        WHERE user_id = $6
      `, [address || null, phone || null, blood_group || null, parent_phone || null, parent_email || null, actualUserId]);

      if (email) {
        await client.query(`
          UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2
        `, [email, actualUserId]);
      }

      await client.query('COMMIT');

      const updatedProfile = await client.query(`
        SELECT 
          s.*,
          u.username,
          u.email,
          c.class_name,
          c.id as class_id,
          sec.section_name
        FROM students s 
        JOIN users u ON s.user_id = u.id 
        LEFT JOIN classes c ON s.class_id = c.id
        LEFT JOIN sections sec ON c.section_id = sec.id
        WHERE u.id = $1
      `, [actualUserId]);

      cache.del(`profile_${studentId}`);

      res.json({
        success: true,
        message: 'Profile updated successfully',
        profile: updatedProfile.rows[0]
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile: ' + error.message,
      profile: null
    });
  }
});

app.post('/api/student/profile/:studentId/photo', upload.single('photo'), async (req, res) => {
  try {
    const { studentId } = req.params;

    if (!studentId || isNaN(studentId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid student ID',
        profile: null
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No photo file provided',
        profile: null
      });
    }

    const profile_photo = req.file.path;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let studentCheck = await client.query(
        'SELECT id, user_id FROM students WHERE user_id = $1',
        [studentId]
      );

      if (studentCheck.rows.length === 0) {
        studentCheck = await client.query(
          'SELECT id, user_id FROM students WHERE id = $1',
          [studentId]
        );
      }

      if (studentCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Student profile not found',
          profile: null
        });
      }

      const actualUserId = studentCheck.rows[0].user_id;

      await client.query(`
        UPDATE students SET 
          profile_photo = $1,
          updated_at = NOW()
        WHERE user_id = $2
      `, [profile_photo, actualUserId]);

      await client.query('COMMIT');

      const updatedProfile = await client.query(`
        SELECT 
          s.*,
          u.username,
          u.email,
          c.class_name,
          c.id as class_id,
          sec.section_name
        FROM students s 
        JOIN users u ON s.user_id = u.id 
        LEFT JOIN classes c ON s.class_id = c.id
        LEFT JOIN sections sec ON c.section_id = sec.id
        WHERE u.id = $1
      `, [actualUserId]);

      cache.del(`profile_${studentId}`);

      res.json({
        success: true,
        message: 'Profile photo updated successfully',
        profile: updatedProfile.rows[0]
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error updating profile photo:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile photo: ' + error.message,
      profile: null
    });
  }
});

app.put('/api/student/profile/:userId', upload.single('photo'), async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId || isNaN(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID'
      });
    }

    const {
      class_id, first_name, last_name, roll_number, username, password,
      email, phone, address, date_of_birth, blood_group,
      parent_name, parent_phone, parent_email
    } = req.body;

    const profile_photo = req.file ? req.file.path : null;

    if (!first_name || !last_name || !username) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, and username are required'
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const studentCheck = await client.query(
        'SELECT id FROM students WHERE user_id = $1',
        [userId]
      );

      if (studentCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Student profile not found'
        });
      }

      const currentUser = await client.query(
        'SELECT username FROM users WHERE id = $1',
        [userId]
      );

      if (currentUser.rows[0].username !== username) {
        const usernameCheck = await client.query(
          'SELECT id FROM users WHERE username = $1 AND id != $2',
          [username, userId]
        );

        if (usernameCheck.rows.length > 0) {
          return res.status(409).json({
            success: false,
            message: 'Username already exists'
          });
        }
      }

      if (roll_number && class_id) {
        const rollCheck = await client.query(
          'SELECT id FROM students WHERE roll_number = $1 AND class_id = $2 AND user_id != $3',
          [roll_number, class_id, userId]
        );

        if (rollCheck.rows.length > 0) {
          return res.status(409).json({
            success: false,
            message: 'Roll number already exists in this class'
          });
        }
      }

      let userUpdateQuery = 'UPDATE users SET username = $1, email = $2, updated_at = NOW()';
      let userParams = [username, email || null, userId];

      if (password && password.trim() !== '') {
        userUpdateQuery = 'UPDATE users SET username = $1, email = $2, password = $3, updated_at = NOW()';
        userParams = [username, email || null, password, userId];
      }

    userUpdateQuery += ` WHERE id = $${userParams.length} RETURNING *`;

      await client.query(userUpdateQuery, userParams);

      const studentUpdateQuery = `
        UPDATE students SET 
          class_id = $1,
          first_name = $2,
          last_name = $3,
          roll_number = $4,
          phone = $5,
          address = $6,
          date_of_birth = $7,
          blood_group = $8,
          parent_name = $9,
          parent_phone = $10,
          parent_email = $11,
          profile_photo = COALESCE($12, profile_photo),
          updated_at = NOW()
        WHERE user_id = $13 
        RETURNING *
      `;

      await client.query(studentUpdateQuery, [
        class_id || null, first_name, last_name, roll_number || null,
        phone || null, address || null, date_of_birth || null, blood_group || null,
        parent_name || null, parent_phone || null, parent_email || null,
        profile_photo, userId
      ]);

      await client.query('COMMIT');

      const updatedProfile = await client.query(`
        SELECT 
          s.*,
          u.username,
          u.email,
          c.class_name,
          c.id as class_id,
          sec.section_name
        FROM students s 
        JOIN users u ON s.user_id = u.id 
        LEFT JOIN classes c ON s.class_id = c.id
        LEFT JOIN sections sec ON c.section_id = sec.id
        WHERE u.id = $1
      `, [userId]);

      cache.del(`profile_${userId}`);

      res.json({
        success: true,
        message: 'Profile updated successfully',
        profile: updatedProfile.rows[0]
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error updating profile:', error);

    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Duplicate entry detected'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update profile',
      error: error.message
    });
  }
});

// ========== ASSIGNMENTS API WITH FCM BATCHING ==========
app.get('/api/admin/assignments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, c.class_name, s.section_name 
      FROM assignments a 
      JOIN classes c ON a.class_id = c.id 
      LEFT JOIN sections s ON c.section_id = s.id 
      ORDER BY a.created_at DESC
    `);
    res.json({ success: true, assignments: result.rows });
  } catch (error) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch assignments' });
  }
});

app.post('/api/admin/assignments', upload.single('assignmentFile'), async (req, res) => {
  try {
    const { class_id, title, description } = req.body;
    const file_path = req.file ? req.file.path : null;

    if (!title || title.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Title is required'
      });
    }

    if (!class_id) {
      return res.status(400).json({
        success: false,
        message: 'Class is required'
      });
    }

    const result = await pool.query(
      'INSERT INTO assignments (class_id, title, description, file_path, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
      [class_id, title, description, file_path]
    );

    const assignment = result.rows[0];

    // Fetch FCM tokens
    const fcmTokensQuery = await pool.query(
      'SELECT fcm_token FROM students WHERE class_id = $1 AND fcm_token IS NOT NULL',
      [class_id]
    );

    const tokens = fcmTokensQuery.rows.map(row => row.fcm_token);

    // Send FCM using batch helper
    if (tokens.length > 0) {
      await sendBatchFCM(tokens, {
        type: 'assignment',
        title: '📘 New Assignment Posted',
        body: title,
        message: title
      });
    } else {
      console.log('⚠️ No FCM tokens found for this class');
    }

    cache.flushAll();
    console.log('🗑️ Cache cleared after new assignment');
    
    res.json({ success: true, message: 'Assignment created successfully', assignment });

  } catch (error) {
    console.error('Error creating assignment:', error);
    res.status(500).json({ success: false, message: 'Failed to create assignment' });
  }
});

app.delete('/api/admin/assignments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existingAssignment = await pool.query('SELECT * FROM assignments WHERE id = $1', [id]);
    if (existingAssignment.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Assignment not found'
      });
    }
    await pool.query('DELETE FROM assignments WHERE id = $1', [id]);
    
    cache.flushAll();

    res.json({
      success: true,
      message: 'Assignment deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting assignment:', error);
    res.status(500).json({ success: false, message: 'Failed to delete assignment' });
  }
});

app.put('/api/admin/assignments/:id', upload.single('assignmentFile'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid assignment ID'
      });
    }

    const { class_id, title, description } = req.body;
    const file_path = req.file ? req.file.path : null;

    if (!class_id || !title) {
      return res.status(400).json({
        success: false,
        message: 'Class and title are required'
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingAssignment = await client.query(
        'SELECT * FROM assignments WHERE id = $1',
        [id]
      );

      if (existingAssignment.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Assignment not found'
        });
      }

      const updateQuery = `
        UPDATE assignments SET 
          class_id = $1, 
          title = $2, 
          description = $3,
          file_path = COALESCE($4, file_path),
          created_at = NOW()
        WHERE id = $5
        RETURNING *
      `;

      const result = await client.query(updateQuery, [
        class_id, title, description, file_path, id
      ]);

      await client.query('COMMIT');

      cache.flushAll();
      console.log('🗑️ Cache cleared after assignment update');
      
      res.json({
        success: true,
        message: 'Assignment updated successfully',
        assignment: result.rows[0]
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error updating assignment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update assignment'
    });
  }
});

// ========== NOTIFICATIONS API WITH FCM BATCHING ==========
app.get('/api/admin/notifications', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT n.*, c.class_name, s.section_name 
      FROM notifications n 
      LEFT JOIN classes c ON n.class_id = c.id 
      LEFT JOIN sections s ON c.section_id = s.id 
      ORDER BY n.created_at DESC
    `);
    res.json({ success: true, notifications: result.rows });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
  }
});

app.post('/api/admin/notifications', upload.single('notificationFile'), async (req, res) => {
  try {
    const { title, description, message, class_id, recipient_type, selected_students } = req.body;
    const file_path = req.file ? req.file.path : null;

    if (!title || !description || !class_id || !recipient_type) {
      return res.status(400).json({
        success: false,
        message: 'Title, description, class, and recipient type are required'
      });
    }

    let studentsArray = null;
    if (selected_students) {
      try {
        studentsArray = JSON.parse(selected_students);
      } catch (e) {
        studentsArray = selected_students;
      }
    }

    if (recipient_type === 'particular' && (!studentsArray || studentsArray.length === 0)) {
      return res.status(400).json({
        success: false,
        message: 'Please select at least one student for particular notifications'
      });
    }

    const result = await pool.query(`
      INSERT INTO notifications (title, description, message, class_id, recipient_type, selected_students, file_path, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING *
    `, [title, description, message, class_id, recipient_type, studentsArray, file_path, 1]);

    // Send FCM
    try {
      let fcmTokensQuery;

      if (recipient_type === 'all') {
        fcmTokensQuery = await pool.query(
          'SELECT fcm_token FROM students WHERE class_id = $1 AND fcm_token IS NOT NULL',
          [class_id]
        );
        console.log(`📤 Sending notification to ALL students in class ${class_id}`);
      } else if (recipient_type === 'particular') {
        fcmTokensQuery = await pool.query(
          'SELECT fcm_token FROM students WHERE id = ANY($1) AND class_id = $2 AND fcm_token IS NOT NULL',
          [studentsArray, class_id]
        );
        console.log(`📤 Sending notification to ${studentsArray.length} PARTICULAR students`);
      }

      const tokens = fcmTokensQuery.rows.map(row => row.fcm_token);

      if (tokens.length > 0) {
        await sendBatchFCM(tokens, {
          type: 'notification',
          title: '📌 New Notification',
          body: description,
          message: description
        });
      } else {
        console.log('⚠️ No FCM tokens found');
      }

    } catch (fcmError) {
      console.error('❌ FCM Error:', fcmError);
    }

    cache.flushAll();
    console.log('🗑️ Cache cleared after new notification');
    
    res.json({
      success: true,
      message: 'Notification created successfully',
      notification: result.rows[0]
    });

  } catch (error) {
    console.error('Error creating notification:', error);
    res.status(500).json({ success: false, message: 'Failed to create notification' });
  }
});

app.put('/api/admin/notifications/:id', upload.single('notificationFile'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid notification ID'
      });
    }

    const { title, description, message, class_id, recipient_type, selected_students } = req.body;
    const file_path = req.file ? req.file.path : null;

    if (!title || !description || !class_id || !recipient_type) {
      return res.status(400).json({
        success: false,
        message: 'Title, description, class, and recipient type are required'
      });
    }

    let studentsArray = null;
    if (selected_students) {
      try {
        studentsArray = typeof selected_students === 'string' ? JSON.parse(selected_students) : selected_students;
      } catch (e) {
        studentsArray = selected_students;
      }
    }

    if (recipient_type === 'particular' && (!studentsArray || studentsArray.length === 0)) {
      return res.status(400).json({
        success: false,
        message: 'Please select at least one student for particular notifications'
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingNotification = await client.query(
        'SELECT * FROM notifications WHERE id = $1',
        [id]
      );

      if (existingNotification.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Notification not found'
        });
      }

      const updateQuery = `
        UPDATE notifications SET 
          title = $1, 
          description = $2, 
          message = $3, 
          class_id = $4, 
          recipient_type = $5, 
          selected_students = $6,
          file_path = COALESCE($7, file_path),
          created_at = NOW()
        WHERE id = $8 
        RETURNING *
      `;

      const result = await client.query(updateQuery, [
        title, description, message, class_id, recipient_type,
        studentsArray, file_path, id
      ]);

      await client.query('COMMIT');
      
      cache.flushAll();
      console.log('🗑️ Cache cleared after notification update');
      
      res.json({
        success: true,
        message: 'Notification updated successfully',
        notification: result.rows[0]
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error updating notification:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update notification'
    });
  }
});

app.delete('/api/admin/notifications/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid notification ID'
      });
    }

    const result = await pool.query(
      'DELETE FROM notifications WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    cache.flushAll();

    res.json({
      success: true,
      message: 'Notification deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete notification'
    });
  }
});

// ========== STUDENT ROUTES WITH PAGINATION ==========
app.get('/api/student/notifications/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    const cacheKey = `notifications_${studentId}_page${page}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✅ Cache hit - notifications');
      return res.json(cached);
    }

    console.log('Fetching notifications for student:', studentId, `Page: ${page}`);

    if (!studentId || isNaN(studentId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid student ID',
        data: null
      });
    }

    let studentRecord = await pool.query(
      'SELECT id, class_id, user_id FROM students WHERE user_id = $1',
      [studentId]
    );

    if (studentRecord.rows.length === 0) {
      studentRecord = await pool.query(
        'SELECT id, class_id, user_id FROM students WHERE id = $1',
        [studentId]
      );
    }

    if (studentRecord.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Student record not found',
        data: null
      });
    }

    const student = studentRecord.rows[0];
    const classId = student.class_id;
    const actualStudentId = student.id;

    if (!classId) {
      return res.json({
        success: true,
        data: [],
        page,
        hasMore: false,
        message: 'Student not assigned to any class'
      });
    }

    const query = `
      SELECT 
        n.*,
        c.class_name,
        s.section_name,
        false as "isRead"
      FROM notifications n
      LEFT JOIN classes c ON n.class_id = c.id
      LEFT JOIN sections s ON c.section_id = s.id
      WHERE 
        n.class_id = $2
        AND (
          n.recipient_type = 'all'
          OR (n.recipient_type = 'particular' AND $1 = ANY(n.selected_students))
        )
      ORDER BY n.created_at DESC
      LIMIT $3 OFFSET $4
    `;

    const result = await pool.query(query, [actualStudentId, classId, limit, offset]);

    console.log(`✅ Found ${result.rows.length} notifications`);

    const response = {
      success: true,
      data: result.rows,
      page,
      hasMore: result.rows.length === limit,
      message: 'Notifications fetched successfully'
    };
    
    cache.set(cacheKey, response);
    res.json(response);
  
  } catch (error) {
    console.error('Error fetching student notifications:', error);
    res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to fetch notifications: ' + error.message
    });
  }
});

app.get('/api/student/assignments/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    const cacheKey = `assignments_${studentId}_page${page}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✅ Cache hit - assignments');
      return res.json(cached);
    }

    console.log('=== FETCHING ASSIGNMENTS ===');
    console.log('Input studentId:', studentId, `Page: ${page}`);

    if (!studentId || isNaN(studentId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid student ID',
        data: null
      });
    }

    let studentQuery = await pool.query(
      'SELECT id, class_id, user_id, first_name FROM students WHERE user_id = $1',
      [studentId]
    );

    if (studentQuery.rows.length === 0) {
      studentQuery = await pool.query(
        'SELECT id, class_id, user_id, first_name FROM students WHERE id = $1',
        [studentId]
      );
    }

    if (studentQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Student record not found',
        data: null
      });
    }

    const student = studentQuery.rows[0];

    if (!student.class_id) {
      return res.json({
        success: true,
        data: [],
        page,
        hasMore: false,
        message: 'Student not assigned to any class'
      });
    }

    const assignmentsQuery = `
      SELECT 
        a.id,
        a.class_id,
        a.title,
        a.description,
        a.file_path,
        a.created_at,
        c.class_name,
        s.section_name
      FROM assignments a
      LEFT JOIN classes c ON a.class_id = c.id
      LEFT JOIN sections s ON c.section_id = s.id
      WHERE a.class_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await pool.query(assignmentsQuery, [student.class_id, limit, offset]);

    console.log(`✅ Found ${result.rows.length} assignments`);

    const response = {
      success: true,
      data: result.rows,
      page,
      hasMore: result.rows.length === limit,
      message: 'Assignments fetched successfully'
    };
    
    cache.set(cacheKey, response);
    res.json(response);

  } catch (error) {
    console.error('❌ Error fetching assignments:', error);
    res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to fetch assignments: ' + error.message
    });
  }
});

// FCM TOKEN ENDPOINT 
app.post('/api/student/:studentId/fcm-token', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { fcm_token } = req.body;

    console.log(`📤 FCM Token Update Request`);
    console.log(`   Student ID: ${studentId}`);
    console.log(`   Token: ${fcm_token ? fcm_token.substring(0, 20) + '...' : 'null'}`);

    if (!fcm_token) {
      return res.status(400).json({
        success: false,
        message: 'FCM token is required',
        data: null
      });
    }

    const result = await pool.query(
      'UPDATE students SET fcm_token = $1, updated_at = NOW() WHERE id = $2 RETURNING id, first_name, last_name',
      [fcm_token, studentId]
    );

    if (result.rows.length === 0) {
      console.log(`❌ Student ${studentId} not found`);
      return res.status(404).json({
        success: false,
        message: 'Student not found',
        data: null
      });
    }

    const student = result.rows[0];
    console.log(`✅ FCM token updated for ${student.first_name} ${student.last_name}`);

    res.json({
      success: true,
      message: 'FCM token updated successfully',
      data: 'Token saved'
    });

  } catch (error) {
    console.error('❌ Error updating FCM token:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update FCM token: ' + error.message,
      data: null
    });
  }
});

// ========== 404 HANDLER (MUST BE LAST) ==========
app.use('*', (req, res) => {
  console.log('❌ 404 - Route not found:', req.originalUrl);
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.originalUrl
  });
});
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err.stack);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ✅ FIX 14: Server listener - MUST bind to 0.0.0.0 for Render
app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Backend server running on port ${port}`);
  console.log(`✅ Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✅ CORS enabled for: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
});