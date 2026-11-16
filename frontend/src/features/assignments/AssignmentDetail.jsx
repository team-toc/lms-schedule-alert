
function AssignmentDetail({ assignment, onBack }) {
  if (!assignment) {
    return <p>과제를 찾을 수 없습니다.</p>
  }

  return (
    <section className="panel">
      <button type="button" className="back-button" onClick={onBack}>
        ← 목록으로
      </button>

      <h2>{assignment.title}</h2>
      <p>과목: {assignment.course}</p>
      <p>마감일: {assignment.deadline}</p>

      <h3>과제 내용</h3>
      <p>{assignment.description}</p>
    </section>
  )
}

export default AssignmentDetail
