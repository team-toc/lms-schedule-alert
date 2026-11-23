function ensureSupported() {
  if (!window.isSecureContext ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)) {
    throw new Error('이 브라우저에서는 푸시 알림을 사용할 수 없습니다.')
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.message || `푸시 알림 요청 실패 (${response.status})`)
  }

  return response.status === 204
    ? null
    : response.json()
}

function decodePublicKey(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')

  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

export async function getPushStatus() {
  if (!window.isSecureContext ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)) {
    return 'unsupported'
  }

  if (Notification.permission === 'denied') return 'denied'

  const registration = await navigator.serviceWorker.getRegistration('/')
  const subscription = await registration?.pushManager.getSubscription()

  return subscription ? 'enabled' : 'disabled'
}

export async function enablePushNotifications() {
  ensureSupported()

  // 반드시 사용자가 버튼을 누른 동작에서 호출
  const permission = await Notification.requestPermission()

  if (permission !== 'granted') {
    throw new Error('브라우저 알림 권한이 허용되지 않았습니다.')
  }

  const { publicKey } = await api('/api/push/public-key')

  if (typeof publicKey !== 'string' || !publicKey) {
    throw new Error('서버의 푸시 공개키를 확인할 수 없습니다.')
  }

  const registration = await navigator.serviceWorker.register('/sw.js', {
    scope: '/',
  })

  const readyRegistration = await navigator.serviceWorker.ready
  const worker = readyRegistration || registration

  let subscription = await worker.pushManager.getSubscription()

  if (!subscription) {
    subscription = await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodePublicKey(publicKey),
    })
  }

  try {
    await api('/api/push/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    })
  } catch (error) {
    await subscription.unsubscribe().catch(() => {})
    throw error
  }

  return 'enabled'
}

export async function disablePushNotifications() {
  if (!('serviceWorker' in navigator)) return

  const registration = await navigator.serviceWorker.getRegistration('/')
  const subscription = await registration?.pushManager.getSubscription()

  if (!subscription) return

  let serverError = null

  try {
    await api('/api/push/subscriptions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    })
  } catch (error) {
    serverError = error
  }

  const unsubscribed = await subscription.unsubscribe()

  if (!unsubscribed) {
    throw new Error('브라우저 푸시 구독을 해제하지 못했습니다.')
  }

  if (serverError) {
    throw serverError
  }
}
