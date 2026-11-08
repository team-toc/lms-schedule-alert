// 코드 규칙: 파일 300줄, 함수 50줄, 파라미터 5개, 순환 복잡도 10 이하
export default [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      complexity: ['error', 10],
      'max-lines': ['error', { max: 300 }],
      'max-lines-per-function': ['error', { max: 50 }],
      'max-params': ['error', 5],
    },
  },
  {
    // 테스트 파일의 describe 블록은 여러 it을 묶는 그릇이라 함수 길이 규칙에서 뺀다.
    // ESLint가 describe 콜백만 골라 뺄 수 없어 테스트 파일 전체에서 이 규칙 하나만 끈다(헬퍼는 그대로 적용).
    files: ['test/**/*.test.js'],
    rules: { 'max-lines-per-function': 'off' },
  },
]
