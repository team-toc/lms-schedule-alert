const SERVER_ERROR_MESSAGE = '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function login(email, password) {
  let response
  try {
    response = await fetch('/api/auth/email/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  } catch {
    return { ok: false, message: SERVER_ERROR_MESSAGE }
  }

  const data = await readJson(response)

  if (response.ok) {
    return { ok: true, user: data }
  }

  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After'))
    if (seconds > 0) {
      const minutes = Math.ceil(seconds / 60)
      return {
        ok: false,
        message: `로그인 시도가 너무 많습니다. ${minutes}분 후 다시 시도해 주세요.`,
      }
    }
  }

  return { ok: false, message: data?.message || SERVER_ERROR_MESSAGE }
}

export async function fetchCurrentUser() {
  let response
  try {
    response = await fetch('/api/auth/me')
  } catch {
    return { status: 'error', message: SERVER_ERROR_MESSAGE }
  }

  if (response.status === 200) {
    const user = await readJson(response)
    if (user) {
      return { status: 'authenticated', user }
    }
    return { status: 'error', message: SERVER_ERROR_MESSAGE }
  }

  if (response.status === 401) {
    return { status: 'unauthenticated' }
  }

  const data = await readJson(response)
  return { status: 'error', message: data?.message || SERVER_ERROR_MESSAGE }
}

export async function logout() {
  let response
  try {
    response = await fetch('/api/auth/logout', { method: 'POST' })
  } catch {
    return { ok: false, message: SERVER_ERROR_MESSAGE }
  }

  if (response.status === 204 || response.status === 401) {
    return { ok: true }
  }

  const data = await readJson(response)
  return { ok: false, message: data?.message || SERVER_ERROR_MESSAGE }
}