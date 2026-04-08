const mysql = require('mysql2/promise')

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'arg_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
})

// Test connection on startup
pool.getConnection()
  .then(conn => { console.log('✅ MySQL connected'); conn.release() })
  .catch(err => console.error('❌ MySQL connection failed:', err.message))

module.exports = pool
