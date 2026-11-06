/**
 * 宿主侧通用工具：错误文本、休眠、文件名清洗、模型 JSON 提取、字节格式化。
 */

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    // 不让后台等待拖住进程退出。
    ;(timer as { unref?: () => void }).unref?.()
  })
}

/** 把任意标题压成安全的文件名片段。 */
export function safeFileName(input: string, fallback = 'file'): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return cleaned === '' ? fallback : cleaned
}

/** 固定宽度的运行目录内文件名：frames/ref-03.png。 */
export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 从模型回复里提取第一个 JSON 对象（容忍 ```json 围栏与前后解释文字）。 */
export function extractJsonObject(text: string): string | undefined {
  const source = text ?? ''
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source)
  const body = fenced?.[1] ?? source
  const start = body.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < body.length; index += 1) {
    const char = body[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return body.slice(start, index + 1)
    }
  }
  return undefined
}

/** 解析模型 JSON 回复；失败时抛出带原文片段的错误，便于界面排障。 */
export function parseModelJson(text: string, label: string): Record<string, unknown> {
  const json = extractJsonObject(text)
  try {
    if (json === undefined) throw new Error('没有找到 JSON 对象')
    return coerceObject(JSON.parse(json))
  } catch (error) {
    // 常见情况：模型输出太长被 max_tokens 截断（JSON 没闭合）。尝试补齐后解析。
    const repaired = repairTruncatedJson(text)
    if (repaired !== undefined) {
      try {
        return coerceObject(JSON.parse(repaired))
      } catch {
        // 修复也失败，走下面的报错
      }
    }
    const head = text.slice(0, 200)
    const tail = text.length > 200 ? `…尾部：${text.slice(-200)}` : ''
    throw new Error(`${label}：模型 JSON 解析失败（${messageOf(error)}）${json === undefined ? '，且输出疑似被截断' : ''}；原文前 200 字：${head}${tail}`)
  }
}

function coerceObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
  return value as Record<string, unknown>
}

/**
 * 修复被截断的 JSON：补上未闭合的字符串与括号；若最后一个元素残缺，
 * 回退到最后一个完整的 `}` 再补括号（丢掉的只是最后一条分镜）。
 */
export function repairTruncatedJson(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  const body = text.slice(start)

  const close = (source: string): string | undefined => {
    let inString = false
    let escaped = false
    const stack: string[] = []
    for (const char of source) {
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') { inString = true; continue }
      if (char === '{') stack.push('}')
      else if (char === '[') stack.push(']')
      else if (char === '}' || char === ']') stack.pop()
    }
    if (stack.length === 0 && !inString) return source
    let repaired = source
    if (inString) repaired += '"'
    // 去掉尾部残缺的键值（例如 `"visualPrompt": "画面` 已补引号但仍缺后续）
    repaired = repaired.replace(/,\s*$/, '').replace(/,\s*"[^"]*"\s*:\s*$/, '')
    for (let index = stack.length - 1; index >= 0; index -= 1) repaired += stack[index]
    return repaired
  }

  const simple = close(body)
  if (simple !== undefined) {
    try {
      JSON.parse(simple)
      return simple
    } catch {
      // 继续尝试回退
    }
  }

  // 回退：从后往前找最后一个完整的对象/数组元素，截断后补括号。
  for (let cut = body.length - 1; cut > start; cut -= 1) {
    if (body[cut] !== '}' && body[cut] !== ']') continue
    const candidate = body.slice(0, cut + 1).replace(/,\s*$/, '')
    const repaired = close(candidate)
    if (repaired === undefined) continue
    try {
      JSON.parse(repaired)
      return repaired
    } catch {
      continue
    }
  }
  return undefined
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 把秒数格式化成 m:ss。 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/** 是否本机回环请求（浏览器桥接只对本机开放）。 */
export function isLoopbackRequest(request: {
  socket?: { remoteAddress?: string }
  headers: Record<string, string | string[] | undefined>
}): boolean {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  const hostValue = Array.isArray(host) ? host[0] : host
  if (typeof hostValue !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${hostValue}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const originHeader = request.headers.origin
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}
