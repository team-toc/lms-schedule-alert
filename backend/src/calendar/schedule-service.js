// 앱 자체 일정 (ADR 0010): 입력 검사 → 내 일정인지 → 앱 일정인지(외부 일정은 읽기 전용) → 저장.
// 다른 사용자 · 없는 · 지운 일정은 모두 404(존재 여부를 드러내지 않음), 내 외부 일정은 403.
// 결과: { schedule } | { deleted: true } | { failure: { status, error, field? } }
import { parseNewSchedule, parseScheduleUpdate } from './schedule-input.js'
import { toScheduleItem } from './schedule-item.js'

const NOT_FOUND = { status: 404, error: 'schedule_not_found' }
const READ_ONLY = { status: 403, error: 'schedule_read_only' }
const badRequest = ({ code, field }) => ({ failure: { status: 400, error: code, field } })

const currentValues = (row) => ({ title: row.title, startAt: row.start_at, endAt: row.end_at, isAllDay: Boolean(row.is_all_day) })

export function createScheduleService({ repository, now }) {
  // 내 앱 일정 행 | { failure }
  async function editable(userId, id) {
    const row = id === null ? null : await repository.findMine(userId, id)
    if (!row) {
      return { failure: NOT_FOUND }
    }
    return row.source === 'app' ? { row } : { failure: READ_ONLY }
  }

  async function create(userId, body) {
    const { value, error } = parseNewSchedule(body)
    if (error) {
      return badRequest(error)
    }
    return { schedule: toScheduleItem(await repository.createAppSchedule(userId, value)) }
  }

  async function update(userId, id, body) {
    const { row, failure } = await editable(userId, id)
    if (failure) {
      return { failure }
    }
    const { value, error } = parseScheduleUpdate(body, currentValues(row))
    if (error) {
      return badRequest(error)
    }
    const updated = await repository.updateAppSchedule(userId, id, value)
    return updated ? { schedule: toScheduleItem(updated) } : { failure: NOT_FOUND }
  }

  async function remove(userId, id) {
    const { failure } = await editable(userId, id)
    if (failure) {
      return { failure }
    }
    return (await repository.deleteAppSchedule(userId, id, now())) ? { deleted: true } : { failure: NOT_FOUND }
  }

  return { create, update, remove }
}
