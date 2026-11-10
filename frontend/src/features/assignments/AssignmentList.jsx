
function AssignmentList({ assignments, onSelect }) {
  return (
    <section className="panel">
      <h2>과제 목록</h2>

      {assignments.map((assignment) => (
        <button
          type="button"
          className="assignment-item"
          key={assignment.id}
          onClick={() => onSelect(assignment.id)}
        >
          <strong>{assignment.title}</strong>
          <span>
            {assignment.course} · {assignment.deadline} 마감
          </span>
        </button>
      ))}
    </section>
  )
}

export default AssignmentList
