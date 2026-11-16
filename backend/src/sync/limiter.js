// 동시 실행 상한 제한기 (ADR 0008 · 0010). 동시에 max개까지만 task를 실행하고 나머지는 들어온 순서대로 기다리게 한다.
// Canvas · iCloud 실행기가 같은 제한기를 넘겨받으면 둘을 합친 동기화 수가 상한을 넘지 않는다(DB 풀 몫을 지키려고).
export function createLimiter(max) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= max || queue.length === 0) {
      return
    }
    active += 1
    const { task, resolve, reject } = queue.shift()
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1
        next()
      })
  }
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject })
      next()
    })
}
