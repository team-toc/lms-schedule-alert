// 감지한 변경을 알림으로 기록 (ADR 0009 2 · 3절). 동기화 반영과 같은 트랜잭션의 연결(connection)로만 쓴다.
// 읽지 않은 같은 알림(사용자 · 대상 · 종류)이 있으면 새로 넣지 않고 "후" 값과 감지 시각만 바꾼다.
// 합친 결과 전 = 후(되돌림)면 그 알림을 지운다. 사라진 과제가 다시 보이면 안 읽은 "사라짐"을 지우고 "새 과제"도 만들지 않는다.

const INSERT = `INSERT INTO notifications
  (user_id, kind, assignment_id, announcement_id, before_due_at, after_due_at, before_title, after_title, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

// merge: 안 읽은 알림이 있을 때 바꾸는 값. due · title은 되돌림이면 지운다, touch는 감지 시각만
const KIND_RULES = {
  assignment_created: { merge: 'createdDue' },
  assignment_due_changed: { merge: 'due' },
  assignment_title_changed: { merge: 'title' },
  assignment_removed: { merge: 'touch' },
  announcement_created: { merge: 'touch' },
  announcement_updated: { merge: 'updatedTitle' },
}

const time = (date) => (date ? date.getTime() : null)

function target(change) {
  return change.assignmentId !== null ? { column: 'assignment_id', id: change.assignmentId } : { column: 'announcement_id', id: change.announcementId }
}

// column은 위 두 상수 중 하나(입력값 아님)
async function findUnread(connection, userId, { column, id }, kind) {
  const [rows] = await connection.query(
    `SELECT id, before_due_at, before_title FROM notifications WHERE user_id = ? AND ${column} = ? AND kind = ? AND read_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE`,
    [userId, id, kind],
  )
  return rows[0] ?? null
}

const deleteById = (connection, id) => connection.query('DELETE FROM notifications WHERE id = ?', [id])

// 안 읽은 알림에 합친다. 결과: true(기록됨) | false(되돌림이라 지움)
async function mergeInto(connection, existing, change, now) {
  const { merge } = KIND_RULES[change.kind]
  if (merge === 'due' && time(existing.before_due_at) === time(change.afterDueAt)) {
    await deleteById(connection, existing.id)
    return false
  }
  if (merge === 'title' && existing.before_title === change.afterTitle) {
    await deleteById(connection, existing.id)
    return false
  }
  if (merge === 'due' || merge === 'createdDue') {
    await connection.query('UPDATE notifications SET after_due_at = ?, detected_at = ? WHERE id = ?', [change.afterDueAt, now, existing.id])
  } else if (merge === 'title' || merge === 'updatedTitle') {
    await connection.query('UPDATE notifications SET after_title = ?, detected_at = ? WHERE id = ?', [change.afterTitle, now, existing.id])
  } else {
    await connection.query('UPDATE notifications SET detected_at = ? WHERE id = ?', [now, existing.id])
  }
  return true
}

async function writeOne(connection, { userId, change, now }) {
  const where = target(change)
  if (change.kind === 'assignment_created') {
    const removed = await findUnread(connection, userId, where, 'assignment_removed')
    if (removed) {
      await deleteById(connection, removed.id)
      return false
    }
  }
  const existing = await findUnread(connection, userId, where, change.kind)
  if (existing) {
    return mergeInto(connection, existing, change, now)
  }
  const { kind, assignmentId, announcementId, beforeDueAt, afterDueAt, beforeTitle, afterTitle } = change
  await connection.execute(INSERT, [userId, kind, assignmentId, announcementId, beforeDueAt, afterDueAt, beforeTitle, afterTitle, now])
  return true
}

// 결과: 기록(새로 넣거나 합침)한 알림 수
export async function writeNotifications(connection, { userId, changes, now }) {
  let recorded = 0
  for (const change of changes) {
    if (await writeOne(connection, { userId, change, now })) {
      recorded += 1
    }
  }
  return recorded
}
