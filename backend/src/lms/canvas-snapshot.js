// 사용자 한 명의 Canvas 목록을 전부 받아 저장할 모양으로 정리한다 (ADR 0008).
// 과목 → 과목마다 과제 · 공지 순서로 한 번에 요청 하나씩(문서: 동시 요청 1개면 요청 제한에 거의 안 걸림).
// 하나라도 실패하면 CanvasApiError를 그대로 올린다(일부 결과를 돌려주지 않음).
import { normalizeCourse, normalizeAssignment, normalizeAnnouncement, isBodyTooLarge } from './canvas-normalize.js'

const ANNOUNCEMENT_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export function createSnapshotFetcher({ canvasClient, baseUrl, logger }) {
  const options = { baseUrl }

  // 1 MiB를 넘어 본문을 비운 공지는 경고로 남긴다(공지 id만, 본문은 남기지 않음)
  function warnDroppedBodies(userId, rawAnnouncements) {
    for (const raw of rawAnnouncements) {
      if (isBodyTooLarge(raw?.message)) {
        logger.warn({ event: 'lms_announcement_body_dropped', userId, canvasAnnouncementId: raw.id }, 'announcement body too large, stored as null')
      }
    }
  }

  async function fetchCourse(token, course, { userId, startDate, endDate }) {
    const rawAssignments = await canvasClient.listAssignments(token, course.canvasCourseId)
    const rawAnnouncements = await canvasClient.listAnnouncements(token, course.canvasCourseId, { startDate, endDate })
    warnDroppedBodies(userId, rawAnnouncements)
    return {
      ...course,
      assignments: rawAssignments.map((raw) => normalizeAssignment(raw, options)).filter(Boolean),
      announcements: rawAnnouncements.map((raw) => normalizeAnnouncement(raw, options)).filter(Boolean),
    }
  }

  // 공지 기간 창: 지금 − 30일 ~ 지금. 창 시작은 "사라진 공지" 판단 범위로 함께 돌려준다
  async function fetchSnapshot(token, { userId, at }) {
    const window = { userId, startDate: new Date(at.getTime() - ANNOUNCEMENT_WINDOW_DAYS * DAY_MS), endDate: at }
    const courses = (await canvasClient.listActiveCourses(token)).map((raw) => normalizeCourse(raw)).filter(Boolean)
    const fetched = []
    for (const course of courses) {
      fetched.push(await fetchCourse(token, course, window))
    }
    return { courses: fetched, announcementWindowStart: window.startDate }
  }

  return { fetchSnapshot }
}
