import mysql from 'mysql2/promise'

const CONNECTION_LIMIT = 10

export function createPool(dbConfig) {
  const pool = mysql.createPool({
    ...dbConfig,
    connectionLimit: CONNECTION_LIMIT,
    charset: 'utf8mb4_unicode_ci',
    // JS Date ↔ DB DATETIME 변환을 UTC로 고정
    timezone: 'Z',
    dateStrings: false,
  })
  // 서버 설정과 상관없이 세션 시간대를 UTC로 맞춘다
  pool.pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'")
  })
  return pool
}
