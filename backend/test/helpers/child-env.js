import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 자식 프로세스가 dotenv로 개발자 .env를 읽지 않도록, 있을 수 없는 경로를 가리킨다(dotenv는 파일이 없으면 조용히 넘어간다)
const NO_DOTENV_FILE = join(tmpdir(), 'lms-schedule-alert-tests-no-dotenv', '.env')

// 자식 프로세스에 넘길 환경변수를 처음부터 만든다. 부모 환경은 OS가 필요로 하는 것(PATH 등)만 물려준다.
export function childProcessEnv(values) {
  const inherited = Object.fromEntries(
    ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
  )
  return { ...inherited, DOTENV_CONFIG_PATH: NO_DOTENV_FILE, ...values }
}
