import { Context, Schema, h, segment, Session, Fragment } from 'koishi'
import { } from 'koishi-plugin-puppeteer'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'node:module'
import { resolve } from 'path'

/**
 * 加载可选依赖（如 sharp），失败返回 null 而不抛出。
 * 注意：不要只写 `(0, eval)('require')` —— 间接 eval 在**全局作用域**求值，
 * 而 Node 的 require 是每个模块包装函数的**局部参数**，在以 require() 方式加载的
 * 模块（Koishi 正是这样加载插件的）里会报 require is not defined，导致逻辑静默失效。
 * 因此依次尝试：模块局部 require → 间接 eval → 基于 cwd 的 createRequire。
 */
function requireOptional(id: string): any {
  const candidates: (() => any)[] = [
    () => (typeof require === 'function' ? require : null),
    () => (0, eval)('require'),
    () => createRequire(process.cwd() + '/index.js'),
  ]
  for (const get of candidates) {
    try {
      const req = get() as NodeRequire | null
      if (req) return req(id)
    } catch { /* 换下一种 */ }
  }
  return null
}

export const name = 'volanta-search'

export const inject = {
  required: ['logger', 'http'],
  optional: ['puppeteer']
}

// 输出格式枚举
const OutputFormat = {
  IMAGE_ONLY: 'imageOnly',
  TEXT_ONLY: 'textOnly',
  BOTH: 'both'
} as const

type OutputFormat = typeof OutputFormat[keyof typeof OutputFormat]

// AI 图片合规识别：默认提示词（模型只需回复 BLOCK 或 PASS）
const DEFAULT_AI_PROMPT = [
  '你是一个图片内容合规审核引擎。请判断这张图片是否包含违反一个中国原则的内容，',
  '包括但不限于：台湾当局使用的旗帜（青天白日满地红旗）、所谓“台湾国旗”图案、',
  '“台独”标语或标志、以及任何把台湾表现为独立国家的旗帜、徽标或宣传文字。',
  '注意：地图底图上常规的地名标注（如 Taiwan、Taipei、Taiwan Strait 等英文地名）、',
  '地理轮廓、航班图标都不算违规内容；航空公司涂装标志不算旗帜。',
  '若存在上述违规内容，只回复 BLOCK；否则只回复 PASS。不要输出任何其他内容。',
].join('')

const AI_BLOCK_NOTICE = '🚫 图片包含违反一个中国原则的内容，已被拦截。'

/**
 * 统一调用 OneBot 接口。
 * adapter-onebot 的 internal 暴露了通用入口 `_get(action, params)`，可以直接调用协议端
 * 实现的任意接口（包含 NapCat 的扩展接口），因此 NapCat 与 LLOneBot 共用同一套
 * OneBot 11 / Go-CQHTTP 的 action 名与参数，不需要再按协议端区分。
 * 仅在通用入口不可用时，才退回方法名探测。
 */
async function oneBotCall(bot: any, action: string, params: Record<string, any>) {
  const internal: any = bot?.internal
  if (typeof internal?._get === 'function') return await internal._get(action, params)
  if (typeof internal?._request === 'function') {
    const response = await internal._request(action, params)
    if (response && typeof response === 'object' && 'retcode' in response) {
      if (response.retcode === 0) return response.data
      throw new Error(`OneBot ${action} failed: retcode=${response.retcode} ${response.message || response.wording || ''}`.trim())
    }
    return response
  }
  const method = action.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  const candidates: Array<{ target: any, fn: Function }> = []
  for (const [target, key] of [[bot, `$${action}`], [bot, action], [bot, method], [internal, `$${action}`], [internal, action], [internal, method]] as const) {
    const fn = (target as any)?.[key]
    if (typeof fn === 'function') candidates.push({ target, fn })
  }
  let lastError: any
  for (const { target, fn } of candidates) {
    try { return await fn.call(target, params) } catch (error) { lastError = error }
  }
  if (lastError) throw lastError
  throw new Error(`OneBot action not available: ${action}`)
}

/** 给 Promise 加超时，避免协议端对未知 action 不返回响应时一直等到适配器的 responseTimeout（默认 1 分钟）。 */
function oneBotWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 调用超时（${ms}ms）`)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

const FORWARD_ATTEMPT_TIMEOUT = 10000

/**
 * 发送合并转发消息。
 * 尝试顺序：
 * 1. Go-CQHTTP 兼容的 `send_group_forward_msg` / `send_private_forward_msg`（NapCat 与 LLOneBot 都支持）；
 * 2. NapCat 统一的 `send_forward_msg`（参数 `message`）；
 * 3. NapCat 统一的 `send_forward_msg`（参数 `messages`）。
 * 每次尝试都带超时，失败后立即尝试下一个。
 */
async function oneBotSendForward(bot: any, groupId: string | null, userId: string | null, nodes: any[]) {
  const attempts: Array<[string, Record<string, any>]> = groupId
    ? [
      ['send_group_forward_msg', { group_id: groupId, messages: nodes }],
      ['send_forward_msg', { message_type: 'group', group_id: groupId, message: nodes }],
      ['send_forward_msg', { message_type: 'group', group_id: groupId, messages: nodes }],
    ]
    : userId
      ? [
        ['send_private_forward_msg', { user_id: userId, messages: nodes }],
        ['send_forward_msg', { message_type: 'private', user_id: userId, message: nodes }],
        ['send_forward_msg', { message_type: 'private', user_id: userId, messages: nodes }],
      ]
      : []
  let lastError: any
  for (const [action, params] of attempts) {
    try {
      return await oneBotWithTimeout(oneBotCall(bot, action, params), FORWARD_ATTEMPT_TIMEOUT, action)
    } catch (error) {
      lastError = error
    }
  }
  if (lastError) throw lastError
  throw new Error('OneBot forward action not available')
}

/**
 * 把 Koishi 的消息元素 / 字符串转换成 OneBot 消息段。
 * OneBot 合并转发节点的 `content` 必须是消息段数组（`{ type, data }`）；
 * 直接塞 Koishi 元素（如 `h.image(buf)`）客户端会显示「该消息类型暂不支持查看」。
 */
function toForwardContent(items: any[]): any[] {
  const segments: any[] = []
  for (const item of items) {
    if (typeof item === 'string') {
      if (item) segments.push({ type: 'text', data: { text: item } })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const type = String(item.type || '')
    if (type === 'text') {
      const text = String(item.attrs?.content ?? '')
      if (text) segments.push({ type: 'text', data: { text } })
      continue
    }
    if (type === 'img' || type === 'image') {
      const src = String(item.attrs?.src ?? item.attrs?.url ?? '')
      if (!src) continue
      // h.image(buffer) 生成的是 data URL，需要转成 OneBot 的 base64:// 协议
      const base64Token = ';base64,'
      const index = src.indexOf(base64Token)
      const file = index > -1 ? `base64://${src.slice(index + base64Token.length)}` : src
      segments.push({ type: 'image', data: { file } })
      continue
    }
    if (type === 'br') {
      segments.push({ type: 'text', data: { text: '\n' } })
      continue
    }
    if (type === 'at') {
      const id = item.attrs?.id ?? item.attrs?.type ?? 'all'
      segments.push({ type: 'at', data: { qq: String(id) } })
      continue
    }
  }
  if (!segments.length) segments.push({ type: 'text', data: { text: ' ' } })
  return segments
}

// 模块级兜底日志：sendFlightForward 位于 apply 之外，拿不到插件 logger，
// 之前的 log() 引用会直接导致 tsc 编译失败，这里改为 console 兜底输出。
function moduleLog(level: 'info' | 'warn' | 'error', message: string, data?: any) {
  try {
    console[level](`[volanta-search] ${message}`, data ?? '')
  } catch { }
}

async function sendFlightForward(session: Session, routeMessage: string, mainMessage: any[]) {
  const bot = session.bot as any
  const isOneBot = session.platform === 'onebot' || bot?.platform === 'onebot'

  if (isOneBot) {
    const groupId = session.isDirect ? null : String(session.guildId || session.channelId || '')
    const userId = session.isDirect ? String(session.userId || session.channelId || '') : null
    // 合并转发节点用机器人自己的账号展示（用他人 QQ 号会被协议端拒绝）
    const selfId = String(bot?.selfId ?? session.userId ?? '10000').match(/\d+/g)?.pop() || '10000'
    const nodes = [
      { type: 'node', data: { user_id: selfId, nickname: 'Volanta', content: toForwardContent([routeMessage]) } },
      { type: 'node', data: { user_id: selfId, nickname: 'Volanta', content: toForwardContent(mainMessage) } },
    ]
    if (groupId || userId) {
      try {
        await oneBotSendForward(bot, groupId, userId, nodes)
        return
      } catch (error: any) {
        moduleLog('warn', 'OneBot 合并转发失败，回退普通发送', { error: error?.message || String(error) })
      }
    }
    // OneBot 转发不可用：逐条普通发送（图片可正常附带）
    await session.send(routeMessage)
    await session.send(mainMessage)
    return
  }

  // 非 OneBot 平台（Discord 等）：合并转发段在部分适配器下无法附带 base64 截图，
  // 直接按节点逐条以普通消息发送，确保截图图片能正常附带。
  await session.send(routeMessage)
  await session.send(mainMessage)
}

export interface Config {
  timeout: number
  dataTimeout: number
  selectionTimeout: number
  screenshotDelay: number
  zoomLevel: number
  outputFormat: OutputFormat
  enableLogging: boolean
  retryCount: number
  userAgent: string
  viewportWidth: number
  viewportHeight: number
  // 新增配置项
  cacheDuration: number
  enableImageOptimization: boolean
  imageQuality: number
  enableAirportChineseName: boolean
  // 机场中文名接口超时
  airportApiTimeout: number
  // 强制刷新配置
  forceRefresh: boolean
  // AI 图片合规识别
  aiEnabled: boolean
  aiApiUrl: string
  aiApiKey: string
  aiModel: string
  aiTimeout: number
  aiPrompt: string
}

export const Config = Schema.object({
  timeout: Schema.number()
    .default(30000)
    .min(5000)
    .max(120000)
    .step(1000)
    .description('请求超时时间(毫秒)'),

  dataTimeout: Schema.number()
    .default(60000)
    .min(10000)
    .max(180000)
    .step(5000)
    .description('汇总航班数据(约3MB JSON)请求超时(毫秒)。上游 Cloudflare 不缓存该文件、每次都回源，网络差时单次下载可能超过 60 秒，建议不低于 60000'),
  
  selectionTimeout: Schema.number()
    .default(60000)
    .min(10000)
    .max(300000)
    .step(1000)
    .description('Volanta航班选择超时时间(毫秒)'),

  screenshotDelay: Schema.number()
    .default(5000)
    .min(1000)
    .max(15000)
    .step(1000)
    .description('点击后等待截图时间(毫秒)'),

  zoomLevel: Schema.number()
    .default(2)
    .min(1)
    .max(3)
    .step(0.5)
    .description('截图缩放倍数(deviceScaleFactor)：>1 时截图像素密度更高、细节更清晰，便于 AI 识别画面里的小图标与文字，群内显示也更清楚；倍数越大截图体积与耗时越大'),

  retryCount: Schema.number()
    .default(2)
    .min(0)
    .max(5)
    .description('失败重试次数'),
  
  viewportWidth: Schema.number()
    .default(1280)
    .min(800)
    .max(1920)
    .description('浏览器视窗宽度'),
  
  viewportHeight: Schema.number()
    .default(720)
    .min(600)
    .max(1080)
    .description('浏览器视窗高度'),
  
  userAgent: Schema.string()
    .default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36')
    .description('浏览器User-Agent'),
  
  outputFormat: Schema.union([
    Schema.const(OutputFormat.IMAGE_ONLY).description('仅输出图片'),
    Schema.const(OutputFormat.TEXT_ONLY).description('仅输出文字'),
    Schema.const(OutputFormat.BOTH).description('文字加图片（推荐）'),
  ]).default(OutputFormat.BOTH).description('输出格式'),
  
  enableLogging: Schema.boolean()
    .default(true)
    .description('启用详细日志记录'),

  cacheDuration: Schema.number()
    .default(30000) // 缩短默认缓存时间到30秒
    .min(5000)
    .max(300000)
    .description('航班数据缓存时间(毫秒)'),
  
  enableImageOptimization: Schema.boolean()
    .default(true)
    .description('启用图片优化'),
  
  imageQuality: Schema.number()
    .default(80)
    .min(50)
    .max(100)
    .description('截图质量(百分比)'),
  
  enableAirportChineseName: Schema.boolean()
    .default(true)
    .description('启用机场中文名称查询'),

  airportApiTimeout: Schema.number()
    .default(5000)
    .min(1000)
    .max(60000)
    .step(500)
    .description('机场中文名称接口超时时间(毫秒)；接口异常后 10 分钟内不再重试'),

  forceRefresh: Schema.boolean()
    .default(true)
    .description('每次查询都强制刷新航班数据'),

  aiEnabled: Schema.boolean()
    .role('switch')
    .default(false)
    .description('启用 AI 图片合规识别：对 Volanta 截图、头像与飞机配图进行识别，拦截违反一个中国原则的图片（如台湾旗帜）'),

  aiApiUrl: Schema.string()
    .default('https://api.openai.com/v1/chat/completions')
    .description('OpenAI 标准格式的 chat/completions 接口完整地址（支持自定义网关）'),

  aiApiKey: Schema.string()
    .role('secret')
    .default('')
    .description('AI 接口密钥（Bearer Token，可留空）'),

  aiModel: Schema.string()
    .default('gpt-4o-mini')
    .description('自定义模型名称（需支持图片输入）'),

  aiTimeout: Schema.number()
    .default(30000)
    .min(5000)
    .max(120000)
    .step(1000)
    .description('AI 识别请求超时时间(毫秒)'),

  aiPrompt: Schema.string()
    .role('textarea')
    .default(DEFAULT_AI_PROMPT)
    .description('审核提示词；模型只需回复 BLOCK（拦截）或 PASS（放行）'),
})

// 定义Volanta API返回的数据结构
interface VolantaPosition {
  latitude: number
  longitude: number
  altitude: number
  altitudeAgl: number
  pitch: number
  bank: number
  headingTrue: number
  groundSpeed: number
  onGround: boolean
  time: string
  network: string
  frameRate: number
  memoryUsedMB: number
  fuelKg: number
  transponder: string
  verticalSpeed: number
  positionType: string
  simZuluTime: string
}

interface VolantaFlight {
  id: string
  callsign: string
  flightNumber: string
  originIcao: string
  destinationIcao: string
  atcRoute: string
  network: string
  networkUserId: string
  networkUserName: string
  isPremium: boolean
  position: VolantaPosition
  connections: {
    ivao: string
    vatsim: string
    pilotEdge: string
    fsCloud: string
  }
  aircraftIcao: string
  privacyOption: string
  aircraftRegistration: string
  simulatorAbbreviation: string
}

// xflysim 机场信息接口
interface XflysimAirportResponse {
  code: number
  data: {
    longitudeDeg: number
    elevationFt: number
    continent: string
    isoRegion: string
    gpsCode: string
    ident: string
    municipality: string
    type: string
    latitudeDeg: number
    municipalityCn: string
    iataCode: string
    cnName: string
    enName: string
    isoCountry: string
  }
  message: string
}

// 绑定数据接口
interface UserBinding {
  qq: string
  networkUserId: string
  networkUserName: string
  bindTime: string
}

interface BindingsData {
  users: UserBinding[]
}

interface VolantaProfileMostLikedScreenshot {
  screenshotId?: string
  flightId?: string
  flight?: Record<string, unknown> | null
  likes?: number
}

interface VolantaProfileResponse {
  id: string
  userName: string
  profileImage: string | null
  profileBio: string | null
  friendsCount: number
  longestStreak: number
  screenshotLikesReceived: number
  mostLikedScreenshots?: VolantaProfileMostLikedScreenshot[]
}

interface VolantaAirportInfoLite {
  icaoCode?: string | null
  name?: string | null
  iataCode?: string | null
}

interface VolantaAircraftInfoLite {
  imageUrl?: string | null
}

interface VolantaRecentFlight {
  id: string
  callsign?: string | null
  flightNumber?: string | null
  origin?: VolantaAirportInfoLite | null
  destination?: VolantaAirportInfoLite | null
  atcRoute?: string | null
  aircraftRegistration?: string | null
  aircraftIcao?: string | null
  aircraftDirectory?: string | null
  aircraft?: VolantaAircraftInfoLite | null
  imageUrl?: string | null
  realBlockTime?: number | null
  updatedAt?: string | null
}

interface VolantaRecentFlightItem {
  flight?: VolantaRecentFlight | null
  summarisedPositions?: unknown[]
}

type ForwardNode = {
  message: Fragment
}

type OneBotSegment = {
  type: string
  data: Record<string, any>
}

type OneBotForwardNode = {
  type: 'node'
  data: {
    user_id: string
    nickname: string
    content: OneBotSegment[]
  }
}

// 机场信息缓存接口
interface AirportInfo {
  icao: string
  cnName: string
  enName: string
  iataCode: string
  municipalityCn: string
  lastUpdated: number
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('volanta-search')
  const bindingsFilePath = resolve(__dirname, 'volanta-bindings.json')
  
  // 机场信息缓存
  const airportCache = new Map<string, AirportInfo>()

  // 机场信息接口失败缓存：icao → 失败时间。接口异常后 10 分钟内跳过重试，
  // 避免机场接口超时（如 xflysim 接口不可用）拖慢每一次航班查询。
  const airportFailCache = new Map<string, number>()
  const AIRPORT_FAIL_TTL = 10 * 60 * 1000
  
  // 航班数据缓存 - 添加强制刷新控制
  type FlightCache = {
    data: VolantaFlight[]
    timestamp: number
    // 数据来自磁盘（上次成功抓取落盘），仅作为上游超时时的兜底
    fromDisk?: boolean
  }

  let flightCache: FlightCache | null = null

  // 汇总航班数据落盘路径：上游只剩内存缓存时，插件重载/koishi 重启后
  // 首次查询一旦遇到上游超时就会直接失败，落盘可让这时候仍有数据可用。
  const flightCacheFilePath = resolve(ctx.baseDir || process.cwd(), 'data', 'volanta-flight-cache.json')
  // 落盘节流：避免 forceRefresh 场景下每 30 秒就写一次 3MB
  const FLIGHT_CACHE_SAVE_INTERVAL = 5 * 60 * 1000
  let lastFlightCacheSavedAt = 0
  // 并发去重：多个查询同时触发时只发一次约 3MB 的上游请求
  let flightFetchInFlight: Promise<VolantaFlight[]> | null = null


  // 详细日志记录函数
  const log = (level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: any) => {
    if (config.enableLogging) {
      const timestamp = new Date().toISOString()
      const formattedMessage = `[${timestamp}] ${message}`
      if (data) {
        logger[level](formattedMessage, data)
      } else {
        logger[level](formattedMessage)
      }
    }
  }

  // AI 图片合规识别结果缓存：key → 是否拦截
  const imageComplianceCache = new Map<string, boolean>()

  /**
   * 调用 OpenAI 标准格式的 chat/completions 接口（自定义网关 + 自定义模型），
   * 对单张图片做合规识别。返回 true=拦截 / false=放行 / null=识别不可用（放行）。
   */
  /** 安全序列化：JSON.stringify 失败或超长时截断，避免日志爆炸。 */
  function stringifyForLog(value: unknown, maxLength = 2000): string {
    try {
      const text = JSON.stringify(value) ?? String(value)
      return text.length > maxLength ? `${text.slice(0, maxLength)}…(共 ${text.length} 字符)` : text
    } catch (error: any) {
      return `<序列化失败: ${error?.message || String(error)}>`
    }
  }

  // 送审 AI 的图片负载上限（base64 字符数）。超过时尝试压缩，避免网关拒收导致整次识别失败放行。
  const AI_MAX_BASE64_LENGTH = 4_000_000

  /**
   * 截图过大时压缩后再送 AI（高 zoomLevel 下 fullPage 截图可能达到数 MB）。
   * sharp 为可选增强依赖：不可用或压缩失败时原样返回，不影响主流程。
   */
  async function prepareImageForAi(buffer: Buffer): Promise<{ data: Buffer; mime: string }> {
    if (buffer.length * 4 / 3 <= AI_MAX_BASE64_LENGTH) return { data: buffer, mime: 'image/png' }
    // 可选增强依赖，不可用时按原图走（requireOptional 保证各种加载方式下都能取到 require）
    const sharp = requireOptional('sharp')
    if (!sharp) {
      log('warn', '送审图片过大但 sharp 不可用，按原图调用 AI', { size: buffer.length })
      return { data: buffer, mime: 'image/png' }
    }
    // 逐级降采样直到 base64 落在网关可接受范围内。
    // 只压一次 jpeg 并不总够：地图截图在高 deviceScaleFactor 下噪点极多，
    // 实测 2560x4000 的 PNG 压成 q85 jpeg 后 base64 仍可能远超阈值；
    // 而一旦网关拒收，requestAiImageCheck 会走异常分支返回 null 直接放行，等于白检。
    const ladder = [
      { width: 2560, quality: 85 },
      { width: 1920, quality: 80 },
      { width: 1280, quality: 75 },
      { width: 960, quality: 70 },
    ]
    let best: { data: Buffer; mime: string } | null = null
    let detail = ''
    for (const step of ladder) {
      try {
        const data = await sharp(buffer)
          .resize({ width: step.width, withoutEnlargement: true })
          .jpeg({ quality: step.quality })
          .toBuffer()
        best = { data, mime: 'image/jpeg' }
        if (data.length * 4 / 3 <= AI_MAX_BASE64_LENGTH) {
          log('info', '送审图片过大，已压缩后再调用 AI', {
            original: buffer.length, compressed: data.length, width: step.width, quality: step.quality,
          })
          return best
        }
        detail = `降至 ${step.width}px/q${step.quality} 后 base64 仍有 ${(data.length * 4 / 3 / 1e6).toFixed(1)}MB`
      } catch (error: any) {
        detail = error?.message || String(error)
        break
      }
    }
    // 取最小的一档交付（比丢几十 MB 的原图上去更可能被接受），失败则退回原图
    if (best) {
      log('warn', '送审图片压缩后仍超限，按最后一档调用 AI', { original: buffer.length, compressed: best.data.length, detail })
      return best
    }
    log('warn', '送审图片压缩失败，按原图调用 AI', { error: detail, size: buffer.length })
    return { data: buffer, mime: 'image/png' }
  }

  async function requestAiImageCheck(imageUrl: string, label: string): Promise<boolean | null> {
    let apiUrl = config.aiApiUrl.trim()
    // 兜底：自动补全 OpenAI 兼容的 chat/completions 路径，
    // 避免用户只填到 /v1 而漏掉 /chat/completions 导致 404。
    if (apiUrl && !/\/chat\/completions$/i.test(apiUrl)) {
      apiUrl = apiUrl.replace(/\/+$/, '') + '/chat/completions'
    }
    const model = config.aiModel.trim()
    if (!apiUrl || !model) {
      log('warn', 'AI 图片合规识别已启用但未配置接口地址或模型', { label })
      return null
    }

    const requestBody = {
      model,
      temperature: 0,
      max_tokens: 20,
      messages: [
        { role: 'system', content: '你是图片合规审核引擎，只输出 BLOCK 或 PASS，不输出任何其他内容。' },
        {
          role: 'user',
          content: [
            { type: 'text', text: config.aiPrompt || DEFAULT_AI_PROMPT },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    }
    const apiKey = config.aiApiKey.trim()
    const requestStartTime = Date.now()
    // 请求日志：记录接口地址、模型、提示词长度与图片负载大小（不记录密钥与完整 base64）
    log('info', 'AI 图片合规识别 API 请求', {
      label,
      url: apiUrl,
      model,
      hasApiKey: !!apiKey,
      promptLength: (config.aiPrompt || DEFAULT_AI_PROMPT).length,
      imagePayloadLength: imageUrl.length,
      imagePayloadType: imageUrl.startsWith('data:') ? 'base64-data-url' : 'url',
    })

    try {
      const response: any = await ctx.http.post(apiUrl, requestBody, {
        timeout: config.aiTimeout,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      })
      const duration = Date.now() - requestStartTime
      // 响应日志：完整响应体（超长截断），并单独摘出模型输出与用量信息
      log('info', 'AI 图片合规识别 API 响应', {
        label,
        duration,
        response: stringifyForLog(response),
        content: response?.choices?.[0]?.message?.content,
        finishReason: response?.choices?.[0]?.finish_reason,
        usage: stringifyForLog(response?.usage, 500),
      })

      const content = String(response?.choices?.[0]?.message?.content ?? '').trim().toUpperCase()
      if (!content) {
        log('warn', 'AI 图片合规识别返回空内容', { label, duration, response: stringifyForLog(response) })
        return null
      }
      const blocked = content.includes('BLOCK') || content.includes('YES')
      log('info', 'AI 图片合规识别完成', { label, blocked, duration, content: content.slice(0, 50) })
      return blocked
    } catch (error: any) {
      // 识别服务不可用时放行并记录，避免 AI 故障导致整个查询不可用。
      // 同时记录错误响应体，便于排查网关返回的具体错误。
      log('error', 'AI 图片合规识别调用失败，本次放行', {
        label,
        url: apiUrl,
        model,
        duration: Date.now() - requestStartTime,
        error: error.message,
        status: error?.response?.status ?? error?.status,
        responseData: stringifyForLog(error?.response?.data),
      })
      return null
    }
  }

  /**
   * 图片合规识别入口：buffer 或 URL 二选一。
   * 远程图片优先下载为 base64（避免自定义网关无法访问外链），失败则直接传 URL。
   * 结果按 cacheKey 缓存，避免同一图片反复调用 AI。
   */
  async function checkImageCompliance(
    source: { buffer?: Buffer, url?: string },
    cacheKey: string,
    label: string,
  ): Promise<boolean | null> {
    if (!config.aiEnabled) return null
    if (imageComplianceCache.has(cacheKey)) return imageComplianceCache.get(cacheKey)

    let imageUrl: string | null = null
    if (source.buffer) {
      const prepared = await prepareImageForAi(source.buffer)
      imageUrl = `data:${prepared.mime};base64,${prepared.data.toString('base64')}`
    } else if (source.url) {
      try {
        const data = await ctx.http.get(source.url, {
          timeout: config.timeout,
          responseType: 'arraybuffer',
          headers: { 'User-Agent': config.userAgent },
        })
        const buf = Buffer.from(data as ArrayBuffer)
        // 同样过一遍体积治理：远程图也可能几 MB，超限会让网关拒收后静默放行
        const prepared = await prepareImageForAi(buf)
        imageUrl = `data:${prepared.mime};base64,${prepared.data.toString('base64')}`
      } catch (error: any) {
        log('warn', '下载待审核图片失败，改为直接传 URL 给 AI', { label, url: source.url, error: error.message })
        imageUrl = source.url
      }
    }
    if (!imageUrl) return null

    const verdict = await requestAiImageCheck(imageUrl, label)
    if (verdict !== null) {
      if (imageComplianceCache.size > 500) imageComplianceCache.clear()
      imageComplianceCache.set(cacheKey, verdict)
    }
    return verdict
  }

  // 读取绑定数据
  function readBindings(): BindingsData {
    log('debug', '开始读取绑定数据', { filePath: bindingsFilePath })
    
    try {
      if (existsSync(bindingsFilePath)) {
        log('debug', '绑定文件存在，正在读取内容')
        const data = readFileSync(bindingsFilePath, 'utf8')
        log('debug', '绑定文件读取成功，开始解析JSON')
        const bindings = JSON.parse(data)
        log('debug', '绑定数据解析成功', { userCount: bindings.users?.length || 0 })
        return bindings
      } else {
        log('debug', '绑定文件不存在，返回空数据')
      }
    } catch (error: any) {
      log('error', '读取绑定数据失败', { error: error.message, stack: error.stack })
    }
    log('debug', '返回默认空绑定数据')
    return { users: [] }
  }

  // 保存绑定数据
  function saveBindings(bindings: BindingsData): void {
    log('debug', '开始保存绑定数据', { userCount: bindings.users.length })
    
    try {
      log('debug', '序列化绑定数据为JSON')
      const jsonData = JSON.stringify(bindings, null, 2)
      log('debug', '开始写入绑定文件', { filePath: bindingsFilePath })
      writeFileSync(bindingsFilePath, jsonData, 'utf8')
      log('info', '绑定数据保存成功', { filePath: bindingsFilePath, userCount: bindings.users.length })
    } catch (error: any) {
      log('error', '保存绑定数据失败', { 
        error: error.message, 
        stack: error.stack,
        filePath: bindingsFilePath 
      })
    }
  }

  // 添加或更新用户绑定
  function addOrUpdateBinding(qq: string, networkUserId: string, networkUserName: string): void {
    log('debug', '开始添加或更新用户绑定', { qq, networkUserId, networkUserName })
    
    const bindings = readBindings()
    const existingIndex = bindings.users.findIndex(user => user.qq === qq)
    
    const newBinding: UserBinding = {
      qq,
      networkUserId,
      networkUserName,
      bindTime: new Date().toISOString()
    }
    
    if (existingIndex >= 0) {
      log('debug', '找到现有绑定，准备更新', { 
        existingIndex, 
        oldUser: bindings.users[existingIndex].networkUserName,
        newUser: networkUserName 
      })
      bindings.users[existingIndex] = newBinding
      log('info', '用户绑定更新成功', { qq, networkUserName })
    } else {
      log('debug', '未找到现有绑定，准备添加新绑定')
      bindings.users.push(newBinding)
      log('info', '用户绑定添加成功', { qq, networkUserName })
    }
    
    saveBindings(bindings)
  }

  // 获取用户绑定信息
  function getUserBinding(qq: string): UserBinding | null {
    log('debug', '开始获取用户绑定信息', { qq })
    
    const bindings = readBindings()
    const binding = bindings.users.find(user => user.qq === qq)
    
    if (binding) {
      log('debug', '找到用户绑定信息', { 
        qq, 
        networkUserId: binding.networkUserId,
        networkUserName: binding.networkUserName 
      })
      return binding
    } else {
      log('debug', '未找到用户绑定信息', { qq })
      return null
    }
  }

  /**
   * 解析被@用户的展示昵称。
   * OneBot 的 at 段通常没有 name 属性，回退链：
   * 1. 消息里自带的 name（at 标签 / 回复消息）；
   * 2. 平台群成员接口（getGuildMember，OneBot 适配器映射 get_group_member_info 的群名片/昵称）；
   * 3. OneBot 陌生人资料（get_stranger_info）；
   * 4. 兜底直接展示 QQ 号，而不是「未知用户」。
   */
  async function resolveMentionName(session: Session, userId: string, fallbackName?: string | null): Promise<string> {
    const fallback = fallbackName && fallbackName !== '未知用户' ? String(fallbackName).trim() : ''
    if (fallback) return fallback

    const bot: any = session?.bot
    const guildId = session?.guildId || session?.channelId

    try {
      if (typeof bot?.getGuildMember === 'function' && guildId) {
        const member = await bot.getGuildMember(guildId, userId)
        const name = member?.nickname || member?.username || member?.user?.nickname || member?.user?.name
        if (name) return String(name)
      }
    } catch (error: any) {
      log('debug', '获取被@用户群名片失败', { userId, error: error?.message })
    }

    try {
      const internal: any = bot?.internal
      if (typeof internal?._get === 'function' && /^\d+$/.test(String(userId))) {
        const info = await internal._get('get_stranger_info', { user_id: userId })
        const name = info?.nickname || info?.nick
        if (name) return String(name)
      }
    } catch (error: any) {
      log('debug', '获取被@用户昵称（陌生人接口）失败', { userId, error: error?.message })
    }

    return userId ? String(userId) : '未知用户'
  }

  /**
   * 提取 HTTP 错误的根因描述。cordis-http 的 "fetch ... failed" 只是把
   * undici 的真实原因（超时/DNS/连接重置等）藏在 error.cause 里，
   * 直接展示 message 无法定位问题。
   */
  function describeHttpError(error: any): string {
    const parts: string[] = []
    const message = String(error?.message || error || 'unknown error')
    parts.push(message)
    const cause = error?.cause ?? error?.errors?.[0]?.cause ?? error?.errors?.[0]
    if (cause) {
      const code = cause?.code || cause?.name
      const causeMessage = cause?.message || String(cause)
      if (code && !message.includes(code)) parts.push(`(${code})`)
      if (causeMessage && causeMessage !== message && !message.includes(causeMessage)) parts.push(causeMessage)
    }
    const status = error?.response?.status ?? error?.status
    if (status && !parts.some(p => p.includes(String(status)))) parts.push(`HTTP ${status}`)
    return parts.filter(Boolean).join(' ').slice(0, 300)
  }

  async function requestVolanta<T>(url: string): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= config.retryCount; attempt++) {
      try {
        return await ctx.http.get(url, {
          timeout: config.timeout,
          headers: {
            'User-Agent': config.userAgent,
            'Accept': 'application/json, text/plain, */*',
          },
        }) as T
      } catch (error) {
        lastError = error
        if (attempt >= config.retryCount) break
        const delay = 1000 * 2 ** attempt
        log('warn', 'Volanta request failed; retrying.', { url, attempt: attempt + 1, delay, reason: describeHttpError(error) })
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    // 把根因带进最终抛出的错误，命令层的「查询失败: ...」能直接看到原因
    throw new Error(describeHttpError(lastError))
  }

  async function fetchProfileByNetworkUserName(networkUserName: string): Promise<VolantaProfileResponse | null> {
    const trimmedUserName = networkUserName?.trim()
    if (!trimmedUserName) {
      log('warn', '获取Volanta用户资料时用户名为空')
      return null
    }

    const encodedUserName = encodeURIComponent(trimmedUserName)
    const profileUrl = `https://api.volanta.app/api/v1/Profiles/${encodedUserName}`

    log('debug', '开始请求Volanta用户资料', {
      networkUserName: trimmedUserName,
      profileUrl,
    })

    try {
      const response = await requestVolanta<VolantaProfileResponse>(profileUrl)

      if (!response || typeof response !== 'object') {
        log('warn', 'Volanta用户资料返回格式异常', {
          networkUserName: trimmedUserName,
          responseType: typeof response,
        })
        return null
      }

      log('info', '成功获取Volanta用户资料', {
        networkUserName: trimmedUserName,
        responseUserName: response.userName,
      })
      return response
    } catch (error: any) {
      const status = error?.response?.status ?? error?.status
      const code = error?.code

      if (status === 404 || code === 404 || String(error?.message || '').includes('404')) {
        log('info', 'Volanta用户资料不存在', { networkUserName: trimmedUserName })
        return null
      }

      log('error', '请求Volanta用户资料失败', {
        networkUserName: trimmedUserName,
        status,
        code,
        error: error.message,
        stack: error.stack,
      })
      throw error
    }
  }

  function buildProfileInfoMessage(profile: VolantaProfileResponse): { summary: string } {
    const userName = profile.userName || '未知'
    const profileBio = profile.profileBio && profile.profileBio.trim() ? profile.profileBio.trim() : '暂无简介'
    const friendsCount = typeof profile.friendsCount === 'number' ? profile.friendsCount : '未知'
    const longestStreak = typeof profile.longestStreak === 'number' ? profile.longestStreak : '未知'
    const likesReceived = typeof profile.screenshotLikesReceived === 'number' ? profile.screenshotLikesReceived : '未知'

    const summary = `👤 Volanta信息
用户名: ${userName}
个人简介: ${profileBio}
好友数量: ${friendsCount}
最长飞行天数: ${longestStreak}
收到点赞数: ${likesReceived}`

    return {
      summary,
    }
  }

  async function fetchRecentFlightsByUserKey(userKey: string): Promise<VolantaRecentFlight[]> {
    const trimmedUserKey = userKey?.trim()
    if (!trimmedUserKey) {
      return []
    }

    const requestUrl = `https://api.volanta.app/api/v1/Flights/user/${encodeURIComponent(trimmedUserKey)}`
    log('debug', '开始请求Volanta最近航班', {
      userKey: trimmedUserKey,
      requestUrl,
    })

    try {
      const response = await requestVolanta<VolantaRecentFlightItem[] | VolantaRecentFlight[]>(requestUrl)

      if (!Array.isArray(response)) {
        log('warn', 'Volanta最近航班返回非数组', {
          userKey: trimmedUserKey,
          responseType: typeof response,
        })
        return []
      }

      const flights = response
        .map((item) => {
          if (item && typeof item === 'object' && 'flight' in item) {
            return (item as VolantaRecentFlightItem).flight || null
          }
          return item as VolantaRecentFlight
        })
        .filter((item): item is VolantaRecentFlight => !!item && typeof item === 'object')

      log('info', '获取Volanta最近航班成功', {
        userKey: trimmedUserKey,
        flightCount: flights.length,
      })
      return flights
    } catch (error: any) {
      const status = error?.response?.status ?? error?.status
      const code = error?.code

      if (status === 404 || code === 404 || String(error?.message || '').includes('404')) {
        log('info', 'Volanta最近航班接口未找到用户', { userKey: trimmedUserKey })
        return []
      }

      log('error', '请求Volanta最近航班失败', {
        userKey: trimmedUserKey,
        status,
        code,
        error: error.message,
        stack: error.stack,
      })
      throw error
    }
  }

  function formatBlockTimeFromSeconds(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return '未知'
    }
    const totalSeconds = Math.round(value)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    return `${totalSeconds} 秒 (${hours}小时${minutes}分${seconds}秒)`
  }

  function formatAirportTriplet(airport?: VolantaAirportInfoLite | null): string {
    const icao = airport?.icaoCode?.trim() || '未知'
    const name = airport?.name?.trim() || '未知'
    const iata = airport?.iataCode?.trim() || '未知'
    return `${icao} / ${name} / ${iata}`
  }

  function buildRecentFlightMessage(flight: VolantaRecentFlight, index: number, total: number): string {
    const callsign = flight.callsign?.trim() || '未知'
    const flightNumber = flight.flightNumber?.trim() || '未知'
    const atcRoute = flight.atcRoute?.trim() || '暂无航路信息'
    const aircraftRegistration = flight.aircraftRegistration?.trim() || '未知'
    const aircraftIcao = flight.aircraftIcao?.trim() || '未知'
    const aircraftDirectory = flight.aircraftDirectory?.trim() || '未知'
    const blockTime = formatBlockTimeFromSeconds(flight.realBlockTime)

    return `🧾 最近航班 ${index + 1}/${total}
呼号: ${callsign}
航班号: ${flightNumber}
出发地: ${formatAirportTriplet(flight.origin)}
目的地: ${formatAirportTriplet(flight.destination)}
飞行航路: ${atcRoute}
飞机: ${aircraftRegistration} / ${aircraftIcao} (${aircraftDirectory})
本次飞行时长（以轮挡时间计算）: ${blockTime}`
  }

  function extractOneBotTargetId(value?: string): string | null {
    if (!value) return null
    const text = String(value).trim()
    if (!text) return null
    const matches = text.match(/\d+/g)
    if (!matches?.length) return null
    return matches[matches.length - 1]
  }

  function toOneBotImageFile(src: string): string {
    // Some upstream records contain a Markdown link instead of a raw image URL.
    // OneBot accepts the URL itself in `file`, not `[URL](URL)`.
    const markdownLink = src.trim().match(/^!?\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/i)
    if (markdownLink) src = markdownLink[1]

    const base64Token = ';base64,'
    const index = src.indexOf(base64Token)
    if (index > -1) {
      const base64 = src.slice(index + base64Token.length)
      return `base64://${base64}`
    }
    return src
  }

  function toOneBotSegments(message: Fragment): OneBotSegment[] {
    const segments = segment.normalize(message) as any[]
    const result: OneBotSegment[] = []

    for (const item of segments) {
      if (!item || typeof item !== 'object') continue

      const type = String(item.type || '')
      if (type === 'text') {
        const text = String(item.attrs?.content ?? '')
        if (text) result.push({ type: 'text', data: { text } })
        continue
      }

      if (type === 'img' || type === 'image') {
        const src = String(item.attrs?.src ?? item.attrs?.url ?? '')
        if (src) {
          result.push({ type: 'image', data: { file: toOneBotImageFile(src) } })
        }
        continue
      }

      if (type === 'br') {
        result.push({ type: 'text', data: { text: '\n' } })
      }
    }

    if (result.length > 0) return result
    return [{ type: 'text', data: { text: ' ' } }]
  }

  function toOneBotForwardNodes(session: Session, nodes: ForwardNode[]): OneBotForwardNode[] {
    const userId = extractOneBotTargetId((session.bot as any)?.selfId || session.userId) || '10000'
    const nickname = 'Volanta'
    return nodes.map((node) => ({
      type: 'node',
      data: {
        user_id: userId,
        nickname,
        content: toOneBotSegments(node.message),
      },
    }))
  }

  async function sendMergedForwardNodes(session: Session, nodes: ForwardNode[]): Promise<boolean> {
    if (!session || nodes.length === 0) return false

    const bot = session.bot as any
    if ((session.platform === 'onebot' || bot?.platform === 'onebot') && bot) {
      try {
        const messages = toOneBotForwardNodes(session, nodes)
        const groupId = session.isDirect ? null : extractOneBotTargetId(session.guildId || session.channelId)
        const userId = session.isDirect ? extractOneBotTargetId(session.userId || session.channelId) : null
        if (groupId || userId) {
          // NapCat 使用统一的 send_forward_msg，LLOneBot 使用 send_group/private_forward_msg，
          // oneBotSendForward 会依次尝试，两者都可用。
          await oneBotSendForward(bot, groupId, userId, messages)
          return true
        }
      } catch (error: any) {
        log('warn', 'OneBot合并转发失败，回退普通发送', {
          error: error?.message || String(error),
        })
      }
    }

    if (session.platform === 'onebot' || (session.bot as any)?.platform === 'onebot') {
      // A direct OneBot forward attempt above has already failed. The generic
      // encoder uses the same API, so fall back to regular messages instead.
      for (const node of nodes) {
        await session.send(node.message)
      }
      return true
    }

    try {
      const forwardMessage = segment('message', { forward: true }, nodes.map((node) => segment('message', {}, node.message)))
      await session.send(forwardMessage)
      return true
    } catch (error: any) {
      log('warn', '通用合并转发失败，回退普通发送', {
        error: error?.message || String(error),
      })
    }

    for (const node of nodes) {
      await session.send(node.message)
    }
    return true
  }

  // 获取机场中文名称
  async function getAirportChineseName(icao: string): Promise<{ cnName: string; iataCode: string } | null> {
    log('debug', '开始获取机场中文名称', { icao })
    
    if (!icao || icao === '未知' || icao === 'null') {
      log('debug', 'ICAO代码无效，跳过获取中文名称', { icao })
      return null
    }

    // 接口近期失败时跳过本次获取：避免机场接口异常（如超时）拖慢每一次查询。
    // 中文名只是附加信息，失败 10 分钟内直接降级为纯 ICAO 输出。
    const failedAt = airportFailCache.get(icao)
    if (failedAt && Date.now() - failedAt < AIRPORT_FAIL_TTL) {
      log('debug', '机场信息接口近期失败，跳过本次获取', {
        icao,
        failAge: Date.now() - failedAt,
        failTtl: AIRPORT_FAIL_TTL,
      })
      return null
    }

    // 检查缓存
    const cached = airportCache.get(icao)
    if (cached && Date.now() - cached.lastUpdated < 24 * 60 * 60 * 1000) { // 缓存24小时
      log('debug', '使用缓存的机场信息', { 
        icao, 
        cnName: cached.cnName,
        cacheAge: Date.now() - cached.lastUpdated 
      })
      return {
        cnName: cached.cnName,
        iataCode: cached.iataCode
      }
    } else if (cached) {
      log('debug', '缓存已过期，重新获取机场信息', { 
        icao,
        cacheAge: Date.now() - cached.lastUpdated 
      })
    }

    // 疑似抖动（偶发超时/网络错误）时立即重试一次；重试仍失败才进入失败缓存
    const maxAttempts = 2
    let lastError: any
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          log('info', '机场信息接口疑似抖动，重试一次', { icao, attempt })
          await new Promise(res => setTimeout(res, 500))
        }
        log('debug', '开始请求xflysim机场API', {
          icao,
          attempt,
          url: `https://api.xflysim.com/pilot/api/realTimeMap/airports/${icao}`
        })

        const response = await ctx.http.get(`https://api.xflysim.com/pilot/api/realTimeMap/airports/${icao}`, {
          // 机场中文名是附加信息，使用独立的短超时，避免接口异常时拖慢整个查询
          timeout: config.airportApiTimeout,
          headers: {
            'User-Agent': config.userAgent
          }
        }) as XflysimAirportResponse

        log('debug', '收到xflysim API响应', {
          icao,
          attempt,
          code: response.code,
          hasData: !!response.data
        })

        if (response.code === 20000 && response.data) {
          const airportInfo: AirportInfo = {
            icao,
            cnName: response.data.cnName,
            enName: response.data.enName,
            iataCode: response.data.iataCode,
            municipalityCn: response.data.municipalityCn,
            lastUpdated: Date.now()
          }

          // 更新缓存
          log('debug', '更新机场信息缓存', {
            icao,
            cnName: response.data.cnName,
            iataCode: response.data.iataCode
          })
          airportCache.set(icao, airportInfo)
          // 请求成功，清除失败标记
          airportFailCache.delete(icao)

          log('info', '成功获取机场中文名称', {
            icao,
            cnName: response.data.cnName,
            attempt
          })
          return {
            cnName: response.data.cnName,
            iataCode: response.data.iataCode
          }
        } else {
          log('warn', '获取机场信息API返回错误', {
            icao,
            code: response.code,
            message: response.message
          })
          return null
        }
      } catch (error: any) {
        lastError = error
        log('warn', '获取机场信息请求失败', {
          icao,
          attempt,
          error: error.message,
          timeout: config.airportApiTimeout
        })
      }
    }

    // 重试后仍失败：记录失败标记，10 分钟内不再重试该机场，避免超时反复拖慢查询
    airportFailCache.set(icao, Date.now())
    log('error', '获取机场信息重试后仍失败，短期内不再重试', {
      icao,
      attempts: maxAttempts,
      error: lastError?.message,
      timeout: config.airportApiTimeout,
      failTtl: AIRPORT_FAIL_TTL,
      stack: lastError?.stack
    })
    return null
  }


    async function formatAirportLabel(icao?: string): Promise<string> {
    if (!icao || icao === '未知' || icao === 'null') {
      return '未知'
    }
    try {
      const data = await getAirportChineseName(icao)
      return data ? `${icao} (${data.cnName})` : icao
    } catch (error: any) {
      log('warn', 'Volanta航班获取机场中文名失败', {
        icao,
        error: error.message
      })
      return icao
    }
  }

  /**
   * 从磁盘恢复上次成功抓取的汇总航班数据。
   * 只作为兜底数据（不参与缓存有效期判断），用于上游超时/插件重载后的首次查询。
   */
  function loadFlightCacheFromDisk(): void {
    try {
      if (!existsSync(flightCacheFilePath)) return
      const raw = JSON.parse(readFileSync(flightCacheFilePath, 'utf8'))
      if (!raw || !Array.isArray(raw.data) || !raw.data.length) return
      flightCache = {
        data: raw.data as VolantaFlight[],
        timestamp: typeof raw.savedAt === 'number' ? raw.savedAt : Date.now(),
        fromDisk: true,
      }
      log('info', '已从磁盘加载航班数据兜底缓存', {
        flights: flightCache.data.length,
        age: Date.now() - flightCache.timestamp,
        file: flightCacheFilePath,
      })
    } catch (error: any) {
      log('warn', '读取磁盘航班数据缓存失败', { error: error?.message || String(error) })
    }
  }

  /** 成功抓取后把汇总数据落盘（节流），供下次启动/上游超时兜底。 */
  function saveFlightCacheToDisk(data: VolantaFlight[]): void {
    const now = Date.now()
    if (now - lastFlightCacheSavedAt < FLIGHT_CACHE_SAVE_INTERVAL) return
    lastFlightCacheSavedAt = now
    try {
      mkdirSync(resolve(flightCacheFilePath, '..'), { recursive: true })
      writeFileSync(flightCacheFilePath, JSON.stringify({ savedAt: now, data }), 'utf8')
      log('debug', '航班数据已落盘', { flights: data.length, file: flightCacheFilePath })
    } catch (error: any) {
      log('warn', '航班数据落盘失败', { error: error?.message || String(error) })
    }
  }

  // 启动时先把上次的数据装载为兜底缓存
  loadFlightCacheFromDisk()

  // 检查缓存是否有效
  function isCacheValid(cache: FlightCache | null): cache is FlightCache {
    if (!cache || config.forceRefresh) {
      log('debug', '检查航班数据缓存有效性', {
        hasCache: !!cache,
        forceRefresh: config.forceRefresh,
        cacheAge: cache ? Date.now() - cache.timestamp : 'N/A',
        cacheDuration: config.cacheDuration,
        isValid: false,
      })
      return false
    }

    const isValid = Date.now() - cache.timestamp < config.cacheDuration
    
    log('debug', '检查航班数据缓存有效性', {
      hasCache: !!cache,
      forceRefresh: config.forceRefresh,
      cacheAge: Date.now() - cache.timestamp,
      cacheDuration: config.cacheDuration,
      isValid
    })
    
    return isValid
  }

  // 获取所有航班数据的函数 - 强制刷新版本
  async function fetchAllFlights(forceRefresh: boolean = false): Promise<VolantaFlight[]> {
    log('debug', '开始获取所有航班数据', { forceRefresh, configForceRefresh: config.forceRefresh })

    // 检查缓存是否有效（考虑强制刷新设置）
    const cachedFlight = flightCache
    if (!forceRefresh && isCacheValid(cachedFlight)) {
      log('debug', '使用缓存的航班数据', { 
        flightCount: cachedFlight.data.length,
        cacheAge: Date.now() - cachedFlight.timestamp 
      })
      return cachedFlight.data
    }

    log('debug', '需要从API获取航班数据', { 
      reason: forceRefresh ? '强制刷新' : '缓存无效',
      cacheExists: !!flightCache 
    })

    // 并发去重：同时到来的多个查询共用同一次下载，避免重复拉取约 3MB
    if (flightFetchInFlight) {
      log('info', '已有航班数据请求在进行中，复用该请求')
      return flightFetchInFlight
    }
    flightFetchInFlight = fetchAllFlightsFromApi()
    try {
      return await flightFetchInFlight
    } finally {
      flightFetchInFlight = null
    }
  }

  /** 真正发起上游请求的部分（含重试与兜底），由 fetchAllFlights 负责并发去重。 */
  async function fetchAllFlightsFromApi(): Promise<VolantaFlight[]> {
    // 该 JSON 约 3MB，上游 Cloudflare（cf-cache-status: DYNAMIC）不缓存、每次回源，
    // 网络抖动时单次下载可能 30~60 秒，因此单独使用 dataTimeout。
    const dataTimeout = Math.max(config.dataTimeout || 0, config.timeout || 0, 60000)

    for (let attempt = 1; attempt <= config.retryCount + 1; attempt++) {
      try {
        log('info', `开始第 ${attempt} 次尝试获取航班数据`, { timeout: dataTimeout })
        
        const requestStartTime = Date.now()
        log('debug', '发送HTTP请求到Volanta API')
        
        const response = await ctx.http.get('https://webassets.volanta.app/volanta-flight-positions.json', {
          timeout: dataTimeout,
          headers: {
            'User-Agent': config.userAgent
          }
        })

        const requestDuration = Date.now() - requestStartTime
        log('debug', '收到Volanta API响应', { 
          duration: requestDuration,
          responseType: typeof response,
          isArray: Array.isArray(response) 
        })

        let flights: VolantaFlight[] = []
        
        if (Array.isArray(response)) {
          log('debug', 'API返回数组格式数据', { arrayLength: response.length })
          flights = response
        } else if (response && typeof response === 'object') {
          log('debug', 'API返回对象格式数据，开始解析', { 
            keys: Object.keys(response),
            hasFlights: 'flights' in response,
            hasData: 'data' in response 
          })
          
          if (Array.isArray(response.flights)) {
            log('debug', '从flights字段提取航班数据', { count: response.flights.length })
            flights = response.flights
          } else if (Array.isArray(response.data)) {
            log('debug', '从data字段提取航班数据', { count: response.data.length })
            flights = response.data
          } else {
            log('debug', '从对象值中提取航班数据')
            flights = Object.values(response).filter(item => 
              item && typeof item === 'object' && 'callsign' in item
            ) as VolantaFlight[]
          }
        } else {
          log('warn', 'API返回未知格式数据', { responseType: typeof response })
        }

        log('info', '成功获取航班数据', { 
          flightCount: flights.length,
          attempt,
          duration: requestDuration 
        })
        
        // 更新缓存
        flightCache = {
          data: flights,
          timestamp: Date.now()
        }
        // 落盘兜底（节流），供插件重载/上游超时时使用
        saveFlightCacheToDisk(flights)
        
        log('debug', '更新航班数据缓存', { 
          flightCount: flights.length,
          timestamp: flightCache.timestamp 
        })
        
        return flights
        
      } catch (error: any) {
        const isTimeout = /timeout|ETIMEDOUT|aborted/i.test(error?.message || '')
        log('error', `第 ${attempt} 次获取航班数据失败`, { 
          attempt,
          timeout: dataTimeout,
          isTimeout,
          error: error.message,
          stack: error.stack 
        })

        // 超时基本都是上游/链路拥塞，重试同样要等满一个超时周期（会让用户干等几分钟），
        // 因此超时直接放弃剩余重试、走兜底缓存。
        if (attempt === config.retryCount + 1 || isTimeout) {
          if (isTimeout && attempt < config.retryCount + 1) {
            log('warn', '上游请求超时，跳过剩余重试直接使用兜底数据', { attempt })
          }
          // 有缓存数据则返回缓存（含磁盘兜底数据）
          if (flightCache) {
            log('warn', '所有尝试失败，使用过期的缓存数据作为备选', { 
              cacheAge: Date.now() - flightCache.timestamp,
              flightCount: flightCache.data.length,
              fromDisk: !!flightCache.fromDisk,
            })
            return flightCache.data
          }
          log('error', '所有尝试失败且无缓存数据可用', { attempts: attempt, error: error.message })
          // 超时类错误给用户一句可读的提示，避免直接抛出 'request timeout'
          if (isTimeout) {
            const friendly = new Error(
              `Volanta 实时数据接口响应超时（上游 Cloudflare 每次回源、网络较慢），已尝试 ${attempt} 次仍失败，请稍后重试`
            )
            ;(friendly as any).cause = error
            throw friendly
          }
          throw error
        }
        
        const retryDelay = 2000 * attempt
        log('debug', `等待 ${retryDelay}ms 后重试`, { nextAttempt: attempt + 1 })
        await new Promise(resolve => setTimeout(resolve, retryDelay))
      }
    }
    
    log('warn', '所有重试尝试完成但未获取到数据，返回空数组')
    return []
  }

  // 通过呼号获取航班数据 - 强制刷新版本
  async function fetchFlightByCallsign(callsign: string, forceRefresh: boolean = false): Promise<VolantaFlight | null> {
    log('debug', '开始通过呼号搜索航班', { callsign, forceRefresh })
    
    const flights = await fetchAllFlights(forceRefresh)
    
    log('debug', '在所有航班中搜索指定呼号', { 
      totalFlights: flights.length,
      searchCallsign: callsign.toUpperCase() 
    })
    
    const flight = flights.find(f => 
      f.callsign && f.callsign.toUpperCase() === callsign.toUpperCase()
    )
    
    if (flight) {
      log('info', '通过呼号找到航班', { 
        callsign, 
        flightId: flight.id,
        userName: flight.networkUserName 
      })
      return flight
    } else {
      log('warn', '通过呼号未找到航班', { callsign, totalFlights: flights.length })
      return null
    }
  }

  // 通过用户名获取航班数据 - 强制刷新版本
  async function fetchFlightByUsername(username: string, forceRefresh: boolean = false): Promise<VolantaFlight | null> {
    log('debug', '开始通过用户名搜索航班', { username, forceRefresh })
    
    const flights = await fetchAllFlights(forceRefresh)
    
    log('debug', '在所有航班中搜索包含用户名的航班', { 
      totalFlights: flights.length,
      searchUsername: username.toLowerCase() 
    })
    
    const flight = flights.find(f => 
      f.networkUserName && f.networkUserName.toLowerCase().includes(username.toLowerCase())
    )
    
    if (flight) {
      log('info', '通过用户名找到航班', { 
        username, 
        flightId: flight.id,
        callsign: flight.callsign,
        matchedUserName: flight.networkUserName 
      })
      return flight
    } else {
      log('warn', '通过用户名未找到航班', { username, totalFlights: flights.length })
      return null
    }
  }

  // "volanta查询 <关键词>"可直接使用呼号、Volanta 用户名或航班号。
  // 精确匹配优先，避免用户名包含关系抢走同名的呼号/航班号查询；仍保留
  // 原本的用户名包含匹配，以兼容旧用法。
  async function fetchFlightByQuery(query: string, forceRefresh: boolean = false): Promise<VolantaFlight | null> {
    const normalized = query.trim().toUpperCase()
    if (!normalized) return null

    log('debug', '开始按通用关键词搜索航班', { query, forceRefresh })
    const flights = await fetchAllFlights(forceRefresh)
    const fieldOf = (flight: VolantaFlight, field: 'callsign' | 'networkUserName' | 'flightNumber') =>
      String(flight[field] ?? '').trim().toUpperCase()
    const exactMatchers: Array<{ type: '呼号' | '用户名' | '航班号', field: 'callsign' | 'networkUserName' | 'flightNumber' }> = [
      { type: '呼号', field: 'callsign' },
      { type: '用户名', field: 'networkUserName' },
      { type: '航班号', field: 'flightNumber' },
    ]

    for (const matcher of exactMatchers) {
      const flight = flights.find(item => fieldOf(item, matcher.field) === normalized)
      if (!flight) continue
      log('info', '通用关键词精确匹配到航班', {
        query,
        matchType: matcher.type,
        flightId: flight.id,
        callsign: flight.callsign,
        userName: flight.networkUserName,
        flightNumber: flight.flightNumber,
      })
      return flight
    }

    const partialUsernameMatch = flights.find(item => fieldOf(item, 'networkUserName').includes(normalized))
    if (partialUsernameMatch) {
      log('info', '通用关键词按用户名包含匹配到航班', {
        query,
        flightId: partialUsernameMatch.id,
        callsign: partialUsernameMatch.callsign,
        userName: partialUsernameMatch.networkUserName,
      })
      return partialUsernameMatch
    }

    log('warn', '通用关键词未找到航班', { query, totalFlights: flights.length })
    return null
  }

  // 通过networkUserId获取航班数据 - 强制刷新版本
  async function fetchFlightByNetworkUserId(networkUserId: string, forceRefresh: boolean = false): Promise<VolantaFlight | null> {
    log('debug', '开始通过networkUserId搜索航班', { networkUserId, forceRefresh })
    
    const flights = await fetchAllFlights(forceRefresh)
    
    log('debug', '在所有航班中搜索指定networkUserId', { 
      totalFlights: flights.length,
      searchNetworkUserId: networkUserId 
    })
    
    const flight = flights.find(f => 
      f.networkUserId && f.networkUserId === networkUserId
    )
    
    if (flight) {
      log('info', '通过networkUserId找到航班', { 
        networkUserId, 
        flightId: flight.id,
        callsign: flight.callsign,
        userName: flight.networkUserName 
      })
      return flight
    } else {
      log('warn', '通过networkUserId未找到航班', { networkUserId, totalFlights: flights.length })
      return null
    }
  }

  // 截图函数
  async function captureFlightScreenshot(flight: VolantaFlight): Promise<Buffer | null> {
    log('debug', '开始截图流程', {
      flightId: flight.id,
      callsign: flight.callsign
    })
    
    if (!ctx.puppeteer) {
      log('error', 'Puppeteer服务未安装，无法截图')
      return null
    }

    const maxAttempts = Math.max(1, (config.retryCount || 0) + 1)
    // 截图缩放倍数（deviceScaleFactor）：放大截图像素密度，让画面里的小图标/文字
    // 在 AI 识别时有更多像素可用，群内查看也更清晰。
    const deviceScaleFactor = Math.max(1, config.zoomLevel || 1)

    // Volanta 是 SPA，domcontentloaded 时 React 往往尚未渲染。轮询等待页面出现
    // 实际文本内容，可以显著降低「固定等待不够长导致的空白截图」概率。
    const waitForContent = async (page: any): Promise<boolean> => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const textLength = await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0)
        if (textLength >= 100) return true
        await new Promise(res => setTimeout(res, 500))
      }
      return false
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let blankDetected = false
      let page: any = null
      try {
        log('debug', 'Puppeteer服务可用，开始创建页面', { attempt, maxAttempts })
        page = await ctx.puppeteer.page()

        // 跟踪加载失败的资源，便于诊断白屏原因
        const failedRequests: string[] = []
        page.on?.('requestfailed', (request: any) => {
          if (failedRequests.length < 20) {
            failedRequests.push(`${request.failure()?.errorText || 'failed'} ${String(request.url()).slice(0, 120)}`)
          }
        })

        log('debug', '设置页面视窗', {
          width: config.viewportWidth,
          height: config.viewportHeight,
          deviceScaleFactor: deviceScaleFactor,
        })
        await page.setViewport({
          width: Math.max(320, config.viewportWidth),
          height: Math.max(320, config.viewportHeight),
          deviceScaleFactor,
        })
        
        log('debug', '设置User-Agent', { userAgent: config.userAgent })
        await page.setUserAgent(config.userAgent)
        
        const flightUrl = `https://fly.volanta.app/flights/${flight.id}/stats`
        log('info', '导航到航班页面', { url: flightUrl })
        
        await page.goto(flightUrl, { 
          waitUntil: 'domcontentloaded',
          timeout: config.timeout 
        })

        const contentReady = await waitForContent(page)
        if (!contentReady) log('warn', '页面内容等待超时，继续截图流程', { attempt })
        
        log('debug', '页面加载完成，等待3秒确保内容渲染')
        await new Promise(res => setTimeout(res, 3000))
        
        // 尝试点击定位按钮（把地图居中到航班当前位置）
        // 说明：
        // - XPath 选中的可能是 <a> 里的 <img>，直接 click img 未必触发 Angular 绑定
        //   在 <a> 上的点击处理器，因此统一冒泡点击其父级 <a>；
        // - 按钮可能晚于页面文本渲染，使用轮询（最长 8 秒）而不是只查一次；
        // - page.evaluate 返回 DOM 节点会被序列化成空对象，因此查找与点击必须在
        //   evaluate 内部一次完成，只向 Node 侧返回布尔值。
        const locateButtonXPaths = [
          '/html/body/app-root/div/app-flight-view/div/div/app-flight-card-header/div/ul[3]/li[2]/a/img',
          '/html/body/app-root/div/app-flight-view/div/div/app-flight-card-header/div/ul[3]/li[2]/a',
        ]
        log('debug', '尝试查找定位按钮', { xpaths: locateButtonXPaths })

        const clickLocateButton = async (targetPage: any, xpaths: string[], waitMs: number): Promise<boolean> => {
          const deadline = Date.now() + waitMs
          while (Date.now() < deadline) {
            const clicked = await targetPage.evaluate((selectors: string[]) => {
              for (const xpath of selectors) {
                try {
                  const result = document.evaluate(
                    xpath,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null,
                  )
                  const node = result.singleNodeValue as HTMLElement | null
                  if (!node) continue
                  // 优先点击承载点击处理器的 <a>，其次才是命中的元素本身
                  const target = ((node as any).closest?.('a') as HTMLElement) || node
                  const rect = target.getBoundingClientRect()
                  const options: MouseEventInit = {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2,
                  }
                  // 完整的鼠标事件序列，兼容监听 mousedown/mouseup 的框架
                  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const) {
                    const EventCtor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
                    target.dispatchEvent(new EventCtor(type, options))
                  }
                  return true
                } catch {
                  continue
                }
              }
              return false
            }, xpaths).catch((error: any) => {
              log('warn', '定位按钮点击执行出错', { error: error?.message || String(error) })
              return false
            })
            if (clicked) return true
            await new Promise(res => setTimeout(res, 500))
          }
          return false
        }

        try {
          const clicked = await clickLocateButton(page, locateButtonXPaths, 8000)
          if (clicked) {
            log('info', '定位按钮已点击，等待地图重新居中')
          } else {
            log('warn', '未找到定位按钮，跳过地图定位', { xpaths: locateButtonXPaths })
          }
        } catch (error: any) {
          log('warn', '点击定位按钮失败，继续截图', { error: error.message })
        }

        log('debug', '定位操作完成，等待2秒')
        await new Promise(res => setTimeout(res, 2000))
        
        log('info', `等待地图加载 ${config.screenshotDelay}ms`)
        await new Promise(res => setTimeout(res, config.screenshotDelay))

        // Wait for all document images to decode and for two paint frames, so slow
        // image loads do not leave blank placeholders in the screenshot.
        await page.evaluate(async () => {
          const images = Array.from(document.images)
          await Promise.all(images.map(async (image) => {
            if (!image.complete) {
              await Promise.race([
                new Promise<void>((resolve) => {
                  image.addEventListener('load', () => resolve(), { once: true })
                  image.addEventListener('error', () => resolve(), { once: true })
                }),
                new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
              ])
            }
            if (image.naturalWidth > 0) {
              try {
                await image.decode()
              } catch {
                // A broken image must not block the whole screenshot.
              }
            }
          }))
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        })

        const contentWidth = await page.evaluate(() => Math.ceil(Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
        )))
        await page.setViewport({
          width: Math.min(Math.max(320, config.viewportWidth, contentWidth), 4096),
          height: Math.max(320, config.viewportHeight),
          deviceScaleFactor,
        })
        await page.evaluate(() => window.dispatchEvent(new Event('resize')))
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        
        // 渲染健康检查：页面 JS 加载失败时 React 无法渲染，整页截图会接近纯白
        const renderState = await page.evaluate(() => ({
          textLength: (document.body?.innerText || '').trim().length,
          images: document.images.length,
          imagesLoaded: Array.from(document.images).filter(img => img.naturalWidth > 0).length,
        }))

        log('debug', '开始截图')
        const screenshotStartTime = Date.now()
        const screenshot = await page.screenshot({ 
          type: 'png',
          fullPage: true
        }) as Buffer
        const screenshotDuration = Date.now() - screenshotStartTime

        // 空白检测：页面完全未渲染时整页 PNG 体积极小（正常渲染远大于该阈值）
        if (screenshot.length < 20000 && renderState.textLength < 50) {
          blankDetected = true
          log('warn', '截图疑似空白页面（页面未完成渲染）', {
            size: screenshot.length,
            renderState,
            failedRequests,
            attempt,
            maxAttempts,
          })
        } else {
          log('info', '截图完成', {
            duration: screenshotDuration,
            size: screenshot.length,
            deviceScaleFactor,
            attempt,
          })
          return screenshot
        }
      } catch (error: any) {
        // 偶发的导航超时 / 协议错误 / 页面创建失败同样纳入重试，
        // 而不是直接放弃整个截图。
        log('error', '截图过程中发生错误', { 
          error: error.message,
          stack: error.stack,
          attempt,
          maxAttempts,
        })
      } finally {
        if (page) {
          log('debug', '关闭页面')
          // 关闭失败不应掩盖真正的截图错误。
          await page.close().catch((error: any) => log('warn', '关闭页面失败', { error: error?.message }))
        }
      }

      if (attempt < maxAttempts) {
        const delay = 1000 * attempt
        log('info', blankDetected ? '空白截图，正在重试' : '截图失败，正在重试', {
          nextAttempt: attempt + 1,
          maxAttempts,
          delay,
        })
        await new Promise(res => setTimeout(res, delay))
      }
    }
    return null
  }

  // 构建航班信息文本（增强版，包含机场中文名称）
  async function buildFlightInfo(flight: VolantaFlight): Promise<{ baseInfo: string; routeInfo: string }> {
    log('debug', '开始构建航班信息文本', { 
      callsign: flight.callsign,
      flightId: flight.id 
    })
    
    const formatNumber = (num: number, decimals: number = 2) => 
      num ? num.toFixed(decimals) : '未知'
    
    const formatString = (str: string) => 
      str && str !== 'null' ? str : '未知'
    
    const position = flight.position

    // 获取机场中文名称（如果启用）
    let originInfo = formatString(flight.originIcao)
    let destinationInfo = formatString(flight.destinationIcao)
    
    if (config.enableAirportChineseName) {
      log('debug', '启用机场中文名称查询', { 
        originIcao: flight.originIcao,
        destinationIcao: flight.destinationIcao 
      })
      
      try {
        // 并行获取起飞机场和目的机场的中文名称
        log('debug', '开始并行获取机场中文名称')
        const [originData, destinationData] = await Promise.allSettled([
          flight.originIcao && flight.originIcao !== '未知' && flight.originIcao !== 'null' 
            ? getAirportChineseName(flight.originIcao) 
            : Promise.resolve(null),
          flight.destinationIcao && flight.destinationIcao !== '未知' && flight.destinationIcao !== 'null'
            ? getAirportChineseName(flight.destinationIcao)
            : Promise.resolve(null)
        ])

        log('debug', '机场中文名称获取完成', { 
          originStatus: originData.status,
          destinationStatus: destinationData.status 
        })

        if (originData.status === 'fulfilled' && originData.value) {
          originInfo = `${flight.originIcao} (${originData.value.cnName})`
          log('debug', '起飞机场中文名称设置成功', { originInfo })
        } else {
          log('debug', '起飞机场中文名称获取失败', { 
            reason: originData.status === 'rejected' ? originData.reason : '无数据' 
          })
        }

        if (destinationData.status === 'fulfilled' && destinationData.value) {
          destinationInfo = `${flight.destinationIcao} (${destinationData.value.cnName})`
          log('debug', '目的机场中文名称设置成功', { destinationInfo })
        } else {
          log('debug', '目的机场中文名称获取失败', { 
            reason: destinationData.status === 'rejected' ? destinationData.reason : '无数据' 
          })
        }
      } catch (error: any) {
        log('warn', '获取机场中文名称失败，使用原始ICAO代码', { error: error.message })
      }
    } else {
      log('debug', '机场中文名称查询已禁用')
    }

    // 构建基本信息（不包含航路）
    const baseInfo = `🛫 航班信息 - ${flight.callsign}

📋 基本信息：
├─ 航班号: ${formatString(flight.flightNumber)}
├─ 机型: ${formatString(flight.aircraftIcao)}
├─ 起飞机场: ${originInfo}
└─ 目的机场: ${destinationInfo}

📍 实时位置：
├─ 纬度: ${formatNumber(position.latitude, 4)}°
├─ 经度: ${formatNumber(position.longitude, 4)}°
├─ 高度: ${position.altitude} 英尺
├─ 航向: ${formatNumber(position.headingTrue, 1)}°
├─ 地速: ${formatNumber(position.groundSpeed, 1)} 节
└─ 垂直速度: ${formatNumber(position.verticalSpeed, 1)} 英尺/分钟`

    // 构建航路信息
    const routeInfo = flight.atcRoute && flight.atcRoute !== 'null' ? flight.atcRoute : '暂无航路信息'

    log('debug', '航班信息文本构建完成', { 
      baseInfoLength: baseInfo.length,
      routeInfoLength: routeInfo.length 
    })
    
    return {
      baseInfo,
      routeInfo
    }
  }

  // 构建回复消息
  async function buildReplyMessage(flight: VolantaFlight, screenshot: Buffer | null): Promise<{ mainMessage: any[], routeMessage: string }> {
    log('debug', '开始构建回复消息', { 
      outputFormat: config.outputFormat,
      hasScreenshot: !!screenshot 
    })
    
    const { baseInfo, routeInfo } = await buildFlightInfo(flight)

    // AI 图片合规识别：截图命中违规内容时拦截图片，仅保留文字信息
    let imageBlocked = false
    if (screenshot) {
      const verdict = await checkImageCompliance(
        { buffer: screenshot },
        `screenshot:${flight.id}`,
        `航班截图 ${flight.callsign || flight.id}`,
      )
      if (verdict === true) {
        imageBlocked = true
        log('warn', '航班截图命中违规内容，已拦截', { flightId: flight.id, callsign: flight.callsign })
      }
    }
    const effectiveScreenshot = imageBlocked ? null : screenshot

    let mainMessage: any[]
    switch (config.outputFormat) {
      case OutputFormat.IMAGE_ONLY:
        log('debug', '使用IMAGE_ONLY输出格式')
        mainMessage = effectiveScreenshot
          ? [h.image(effectiveScreenshot, 'image/png')]
          : [imageBlocked ? AI_BLOCK_NOTICE : '截图失败，请稍后重试。']
        break

      case OutputFormat.TEXT_ONLY:
        log('debug', '使用TEXT_ONLY输出格式')
        mainMessage = [baseInfo]
        break

      case OutputFormat.BOTH:
      default:
        log('debug', '使用BOTH输出格式')
        if (effectiveScreenshot) {
          mainMessage = [h.image(effectiveScreenshot, 'image/png'), '\n' + baseInfo]
        } else if (imageBlocked) {
          mainMessage = [`${AI_BLOCK_NOTICE}\n${baseInfo}`]
        } else {
          mainMessage = ['截图失败，以下是航班信息：\n' + baseInfo]
        }
        break
    }
    
    log('debug', '回复消息构建完成', { 
      mainMessageType: 'array',
      mainElementCount: mainMessage.length,
      hasRouteInfo: !!routeInfo
    })
    
    return {
      mainMessage,
      routeMessage: routeInfo
    }
  }

    // 命令2: 绑定 <networkUserName> - 添加强制刷新
  // 命令1.5: volanta航班 <flightNumber> - 通过航班号查询 Volanta 航班
  const volantaFlightCmd = ctx.command('volanta航班 <flightNumber>', '通过航班号查询 Volanta 航班')
    .option('en', '-en 使用英文输出')
    .action(async ({ session, options }, flightNumber) => {
      if (!session) {
        log('warn', 'volanta航班命令缺少会话对象')
        return '无法获取会话信息，请稍后再试'
      }

      if (!flightNumber || !flightNumber.trim()) {
        log('warn', 'volanta航班命令缺少航班号')
        return '请填写要查询的航班号'
      }

      const searchFlightNumber = flightNumber.trim().toUpperCase()
      log('info', 'volanta航班查询请求', {
        userId: session.userId,
        flightNumber: searchFlightNumber
      })

      let progressMessageIds: string[] = []
      const recallProgress = async () => {
        const channelId = session.channelId
        if (!progressMessageIds.length || !channelId || !session.bot?.deleteMessage) return
        await Promise.all(progressMessageIds.map(messageId =>
          session.bot.deleteMessage(channelId, messageId).catch(() => undefined)
        ))
        progressMessageIds = []
      }

      try {
        progressMessageIds = await session.send(session.platform === 'discord' || options?.en ? `Searching Volanta flight ${searchFlightNumber}, please wait...` : `正在查询 Volanta 航班 ${searchFlightNumber}，请稍候...`)

        const flights = await fetchAllFlights(config.forceRefresh)
        const matchedFlights = flights.filter(flight =>
          flight.flightNumber && flight.flightNumber.toUpperCase() === searchFlightNumber
        )

        log('info', 'volanta航班查询命中数量', {
          searchFlightNumber,
          matchCount: matchedFlights.length
        })

        if (!matchedFlights.length) {
          await recallProgress()
          return `未找到航班号为 ${searchFlightNumber} 的 Volanta 航班`
        }

        let selectedFlight: VolantaFlight | null = null

        if (matchedFlights.length === 1) {
          selectedFlight = matchedFlights[0]
        } else {
          const summaries = await Promise.all(matchedFlights.map(async (flight, index) => {
            const originLabel = await formatAirportLabel(flight.originIcao)
            const destinationLabel = await formatAirportLabel(flight.destinationIcao)
            const userLabel = flight.networkUserName || flight.networkUserId || '未知用户'
            const callsignLabel = flight.callsign || '无呼号'
            return {
              flight,
              summary: `${index + 1}. ${userLabel} (${callsignLabel}) - ${originLabel} → ${destinationLabel}`
            }
          }))

          const selectionLines = [
            `找到 ${summaries.length} 条 ${searchFlightNumber} 的匹配记录：`,
            ...summaries.map(item => item.summary),
            '请回复序号选择航班，或发送"取消"退出。'
          ]
          await session.send(selectionLines.join('\n'))

          const choice = await session.prompt(config.selectionTimeout)
          if (!choice) {
            await recallProgress()
            return `选择超时（${Math.round(config.selectionTimeout / 1000)} 秒）`
          }

          const normalizedChoice = choice.trim()
          if (!normalizedChoice) {
            await recallProgress()
            return '选择内容为空'
          }

          if (/^(取消|cancel|exit)$/i.test(normalizedChoice)) {
            await recallProgress()
            return '已取消'
          }

          const selectedIndex = parseInt(normalizedChoice, 10) - 1
          if (Number.isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= summaries.length) {
            await recallProgress()
            return '选择无效'
          }

          selectedFlight = summaries[selectedIndex].flight
        }

        if (!selectedFlight) {
          log('warn', 'volanta航班选择结果为空', { flightNumber: searchFlightNumber })
          await recallProgress()
          return '未能完成航班选择'
        }

        if (selectedFlight.privacyOption !== 'Public') {
          log('info', 'volanta航班受隐私保护', {
            flightNumber: searchFlightNumber,
            privacyOption: selectedFlight.privacyOption
          })
          await recallProgress()
          return `航班 ${searchFlightNumber} 设置了隐私，无法直接展示`
        }

        let screenshot: Buffer | null = null
        if (config.outputFormat !== OutputFormat.TEXT_ONLY) {
          log('debug', 'volanta航班查询截图')
          screenshot = await captureFlightScreenshot(selectedFlight)
        }

        const { mainMessage, routeMessage } = await buildReplyMessage(selectedFlight, screenshot)
        log('info', 'volanta航班查询完成')

        await recallProgress()
        await sendFlightForward(session, routeMessage, mainMessage)
      } catch (error: any) {
        await recallProgress()
        log('error', 'volanta航班查询失败', {
          flightNumber: searchFlightNumber,
          error: error.message,
          stack: error.stack
        })
        return `查询失败：${error.message}`
      }
    })


  const bindCmd = ctx.command('volanta绑定 <networkUserName>', '绑定当前用户到Volanta用户名')
    .action(async ({ session }, networkUserName) => {
      if (!session) {
        log('warn', '绑定命令缺少session上下文')
        return '❌ 无法获取会话信息，请稍后重试。'
      }

      log('info', '收到绑定命令请求', { 
        userId: session.userId,
        networkUserName,
        channelId: session.channelId 
      })
      
      if (!networkUserName) {
        log('warn', '绑定命令缺少用户名参数')
        return '请输入要绑定的Volanta用户名。'
      }

      const qq = session.userId
      if (!qq) {
        log('warn', '绑定命令缺少用户ID')
        return '❌ 无法识别您的用户ID，请在私聊或群聊中重试。'
      }
      log('info', '开始处理绑定请求', { qq, networkUserName })
      
      try {
        await session.send(`正在搜索用户 ${networkUserName} 的信息，请稍候...`)

        // 强制刷新Volanta数据
        const flight = await fetchFlightByUsername(networkUserName, config.forceRefresh)
        
        if (!flight) {
          log('info', '未找到指定用户名的航班', { networkUserName })
          return `❌ 未找到用户名包含 "${networkUserName}" 的航班，该用户可能当前没有在飞行。\n\n💡 提示：绑定需要用户当前正在飞行中。`
        }

        if (!flight.networkUserId || !flight.networkUserName) {
          log('warn', '找到的航班信息不完整', { 
            hasNetworkUserId: !!flight.networkUserId,
            hasNetworkUserName: !!flight.networkUserName 
          })
          return `❌ 找到的航班信息不完整，无法绑定。`
        }

        log('info', '找到有效用户信息，准备绑定', { 
          qq,
          networkUserId: flight.networkUserId,
          networkUserName: flight.networkUserName 
        })

        // 保存绑定信息
        addOrUpdateBinding(qq, flight.networkUserId, flight.networkUserName)
        
        return `✅ 绑定成功！您的QQ号已绑定到 Volanta 用户: ${flight.networkUserName} (ID: ${flight.networkUserId})`
        
      } catch (error: any) {
        log('error', '处理绑定请求时发生错误', { 
          networkUserName,
          error: error.message,
          stack: error.stack 
        })
        return `❌ 绑定失败: ${error.message}`
      }
    })

  // 命令3: 查询 [@用户/networkUserName] - 修复@用户查询逻辑
const queryCmd = ctx.command('volanta查询 [target]', '查询被@用户、呼号、用户名、航班号或自己的飞行状态')
  .action(async ({ session }, target) => {
    if (!session) {
      log('warn', 'volanta查询命令缺少session上下文')
      return '❌ 无法获取会话信息，请稍后重试。'
    }

    log('info', '收到volanta查询命令请求', { 
      userId: session.userId,
      target,
      channelId: session.channelId,
      message: session.event.message?.content 
    })
    
    // 检查是否有@用户 - 修复解析逻辑
    let targetUserId: string | null = null
    let targetUserName: string | null = null
    let searchTarget: string | null = null
    
    // 修复：处理target参数中的at标签
    try {
      // 首先检查target参数是否包含at标签
      if (target && typeof target === 'string' && target.includes('<at')) {
        log('debug', 'target参数包含at标签，开始解析', { target })
        
        // 解析at标签中的id和name
        const atMatch = target.match(/<at id="([^"]+)"(?:\s+name="([^"]*)")?\/?>/)
        if (atMatch) {
          targetUserId = atMatch[1]
          targetUserName = atMatch[2] || '未知用户'
          log('debug', '从target参数解析到@用户', { 
            targetUserId, 
            targetUserName,
            fullMatch: atMatch[0] 
          })
        }
      }
      
      // 如果没有从target参数解析到，尝试其他方法
      if (!targetUserId) {
        // 方法1: 通过 session.elements 解析
        if (session.elements) {
          for (const element of session.elements) {
            if (element.type === 'at' && element.attrs?.id) {
              targetUserId = element.attrs.id
              targetUserName = element.attrs.name || '未知用户'
              log('debug', '通过session.elements解析到@用户', { 
                targetUserId, 
                targetUserName 
              })
              break
            }
          }
        }
        
        // 方法2: 通过 session.quote 获取被回复的用户
        const quotedUser = session.quote?.user
        if (!targetUserId && quotedUser?.id) {
          targetUserId = quotedUser.id
          targetUserName = quotedUser.name || '未知用户'
          log('debug', '通过回复消息找到目标用户', { 
            targetUserId, 
            targetUserName 
          })
        }
      }
      
      log('debug', '@用户解析最终结果', { 
        targetUserId, 
        targetUserName,
        hasTarget: !!target,
        targetType: typeof target
      })
      
    } catch (error: any) {
      log('error', '解析@用户失败', { 
        error: error.message,
        stack: error.stack 
      })
    }
    
    // 如果有@用户，优先使用@用户
    if (targetUserId) {
      log('info', '处理@用户查询请求', {
        targetUserId,
        targetUserName
      })

      try {
        // at 段通常没有 name 属性，先解析真实昵称，避免输出「未知用户」
        targetUserName = await resolveMentionName(session, targetUserId, targetUserName)
        log('info', '被@用户昵称解析完成', { targetUserId, targetUserName })

        await session.send(`正在查询 ${targetUserName} 的飞行状态，请稍候...`)

        // 检查用户是否已绑定 - 使用被@用户的QQ号获取绑定
        log('debug', '开始查找被@用户的绑定信息', { 
          targetUserId,
          currentBindings: readBindings().users.map(u => ({ qq: u.qq, name: u.networkUserName }))
        })
        
        const binding = getUserBinding(targetUserId)
        
        if (!binding) {
          log('warn', '被@用户未绑定Volanta账户', { 
            targetUserId, 
            targetUserName,
            availableBindings: readBindings().users.map(u => u.qq) 
          })
          return `❌ ${targetUserName} 尚未绑定Volanta账户。\n\n💡 请先使用"绑定 <用户名>"命令进行绑定。`
        }

        log('info', '找到被@用户的绑定信息', { 
          targetUserId,
          targetUserName,
          networkUserId: binding.networkUserId,
          networkUserName: binding.networkUserName 
        })

        // 强制刷新Volanta数据
        log('debug', '开始通过networkUserId查询航班', { 
          networkUserId: binding.networkUserId,
          forceRefresh: config.forceRefresh 
        })
        const flight = await fetchFlightByNetworkUserId(binding.networkUserId, config.forceRefresh)
        
        if (!flight) {
          log('info', '被@用户当前没有在飞行', { 
            targetUserName,
            networkUserName: binding.networkUserName,
            networkUserId: binding.networkUserId 
          })
          return `ℹ️ ${targetUserName} (Volanta用户: ${binding.networkUserName}) 当前没有在飞行。\n\n💡 该用户已绑定但当前不在飞行状态。`
        }

        if (flight.privacyOption !== 'Public') {
          log('info', '被@用户的航班设置为非公开', { 
            targetUserName,
            privacyOption: flight.privacyOption,
            callsign: flight.callsign 
          })
          return `🔒 ${targetUserName} 的航班设置为非公开，无法查看详细信息。`
        }

        log('info', '成功找到被@用户的航班信息', { 
          targetUserName,
          callsign: flight.callsign,
          flightId: flight.id 
        })

        let screenshot: Buffer | null = null
        
        if (config.outputFormat !== OutputFormat.TEXT_ONLY) {
          log('debug', '开始为被@用户截图')
          screenshot = await captureFlightScreenshot(flight)
        }

        const { mainMessage, routeMessage } = await buildReplyMessage(flight, screenshot)
        log('info', '准备发送被@用户航班信息')
        
        // 先发送提示消息
        await sendFlightForward(session, routeMessage, mainMessage)
        
      } catch (error: any) {
        log('error', '处理@用户查询请求时发生错误', { 
          targetUserId,
          targetUserName,
          error: error.message,
          stack: error.stack 
        })
        return `❌ 查询失败: ${error.message}`
      }
    } 
    // 如果没有@用户，但有参数，则按用户名查询
    else if (target) {
      // 如果target是at标签但没解析成功，尝试从中提取用户名
      if (typeof target === 'string' && target.includes('<at')) {
        const nameMatch = target.match(/name="([^"]*)"/)
        if (nameMatch && nameMatch[1]) {
          searchTarget = nameMatch[1]
          log('debug', '从at标签中提取用户名', { searchTarget })
        } else {
          searchTarget = target
        }
      } else {
        searchTarget = target
      }
      
      searchTarget = searchTarget?.trim() || null
      log('info', '处理关键词查询请求', { searchTarget })
      
      try {
        await session.send(`正在搜索 ${searchTarget} 的 Volanta 航班，请稍候...`)

        // 强制刷新Volanta数据
        const progressIds = await session.send(`正在搜索 ${searchTarget} 的 Volanta 航班，请稍候...`)
        const flight = await fetchFlightByQuery(searchTarget || '', config.forceRefresh)
        
        if (!flight) {
          log('info', '未找到指定关键词的航班', { searchTarget })
          return `❌ 未找到与 "${searchTarget}" 匹配的 Volanta 在飞航班（可使用呼号、用户名或航班号）。`
        }

        if (flight.privacyOption !== 'Public') {
          log('info', '找到航班但隐私设置为非公开', { 
            callsign: flight.callsign,
            privacyOption: flight.privacyOption 
          })
          return `🔒 航班 ${flight.callsign} 的隐私设置为非公开，无法查看详细信息。`
        }

        let screenshot: Buffer | null = null
        
        if (config.outputFormat !== OutputFormat.TEXT_ONLY) {
        log('debug', '开始为关键词查询截图')
          screenshot = await captureFlightScreenshot(flight)
        }

        const { mainMessage, routeMessage } = await buildReplyMessage(flight, screenshot)
        log('info', '准备发送关键词查询结果')
        
        // 先发送航路信息
        await sendFlightForward(session, routeMessage, mainMessage)
        const channelId = session.guildId || session.channelId || session.userId
        if (channelId && progressIds?.length && session.bot?.deleteMessage) {
          await Promise.all(progressIds.map(id => session.bot.deleteMessage(channelId, id).catch(() => undefined)))
        }
        
      } catch (error: any) {
        log('error', '处理关键词查询请求时发生错误', { 
          searchTarget,
          error: error.message,
          stack: error.stack 
        })
        return `❌ 查询失败: ${error.message}`
      }
    }
    // 既没有@用户也没有参数，查询自己的绑定信息
    else {
      const currentUserId = session.userId
      if (!currentUserId) {
        log('warn', '查询当前用户时缺少用户ID')
        return '❌ 无法识别您的用户ID，请在私聊或群聊中重试。'
      }
      log('info', '处理当前用户查询请求', { currentUserId })
      
      try {
        // 检查当前用户是否已绑定
        const binding = getUserBinding(currentUserId)
        
        if (!binding) {
          log('info', '当前用户未绑定Volanta账户', { currentUserId })
          return `❌ 您尚未绑定Volanta账户。\n\n💡 请先使用"绑定 <用户名>"命令进行绑定。`
        }

        log('debug', '找到当前用户绑定信息', { 
          currentUserId,
          networkUserId: binding.networkUserId,
          networkUserName: binding.networkUserName 
        })

        await session.send(`正在查询您的飞行状态，请稍候...`)

        // 强制刷新Volanta数据
        const flight = await fetchFlightByNetworkUserId(binding.networkUserId, config.forceRefresh)
        
        if (!flight) {
          log('info', '当前用户没有在飞行', { 
            currentUserId,
            networkUserName: binding.networkUserName 
          })
          return `ℹ️ 您 (Volanta用户: ${binding.networkUserName}) 当前没有在飞行。\n\n💡 您已绑定但当前不在飞行状态。`
        }

        if (flight.privacyOption !== 'Public') {
          log('info', '当前用户的航班设置为非公开', { 
            currentUserId,
            privacyOption: flight.privacyOption 
          })
          return `🔒 您的航班设置为非公开，无法查看详细信息。`
        }

        let screenshot: Buffer | null = null
        
        if (config.outputFormat !== OutputFormat.TEXT_ONLY) {
          log('debug', '开始为当前用户截图')
          screenshot = await captureFlightScreenshot(flight)
        }

        const { mainMessage, routeMessage } = await buildReplyMessage(flight, screenshot)
        log('info', '准备发送当前用户航班信息')
        
        // 先发送提示消息
        await sendFlightForward(session, routeMessage, mainMessage)
        
      } catch (error: any) {
        log('error', '处理当前用户查询请求时发生错误', { 
          currentUserId,
          error: error.message,
          stack: error.stack 
        })
        return `❌ 查询失败: ${error.message}`
      }
    }
  })

  ctx.command('volanta信息 [target]', '查询Volanta用户资料（支持@已绑定用户或直接输入用户名）')
    .action(async ({ session }, target) => {
      if (!session) {
        log('warn', 'volanta信息命令缺少session上下文')
        return '❌ 无法获取会话信息，请稍后重试。'
      }

      log('info', '收到volanta信息命令请求', {
        userId: session.userId,
        target,
        channelId: session.channelId,
      })

      let targetUserId: string | null = null
      let targetUserName: string | null = null
      let networkUserName: string | null = null
      let queryKey: string | null = null

      try {
        if (target && typeof target === 'string' && target.includes('<at')) {
          const atMatch = target.match(/<at id="([^"]+)"(?:\s+name="([^"]*)")?\/?>/)
          if (atMatch) {
            targetUserId = atMatch[1]
            targetUserName = atMatch[2] || '未知用户'
          }
        }

        if (!targetUserId && session.elements) {
          for (const element of session.elements) {
            if (element.type === 'at' && element.attrs?.id) {
              targetUserId = element.attrs.id
              targetUserName = element.attrs.name || '未知用户'
              break
            }
          }
        }

        if (!targetUserId) {
          const quotedUser = session.quote?.user
          if (quotedUser?.id) {
            targetUserId = quotedUser.id
            targetUserName = quotedUser.name || '未知用户'
          }
        }
      } catch (error: any) {
        log('error', '解析volanta信息命令目标失败', {
          target,
          error: error.message,
          stack: error.stack,
        })
      }

      if (targetUserId) {
        // at 段通常没有 name 属性，先解析真实昵称，避免输出「未知用户」
        targetUserName = await resolveMentionName(session, targetUserId, targetUserName)
        const binding = getUserBinding(targetUserId)
        if (!binding) {
          return `❌ ${targetUserName || '该用户'} 尚未绑定Volanta账户。\n\n💡 请先使用"volanta绑定 <用户名>"命令进行绑定。`
        }
        networkUserName = binding.networkUserName || null
        queryKey = binding.networkUserId || binding.networkUserName || null
      } else if (typeof target === 'string' && target.trim()) {
        if (target.includes('<at')) {
          const nameMatch = target.match(/name="([^"]*)"/)
          networkUserName = nameMatch?.[1]?.trim() || null
        } else {
          networkUserName = target.trim()
        }
      } else if (session.userId) {
        const selfBinding = getUserBinding(session.userId)
        networkUserName = selfBinding?.networkUserName || null
        queryKey = selfBinding?.networkUserId || selfBinding?.networkUserName || null
      }

      if (!networkUserName && !queryKey) {
        return '❌ 请提供Volanta用户名，或@一个已绑定Volanta账户的用户。'
      }

      try {
        const lookupName = networkUserName || queryKey!
        await session.send(`正在查询 Volanta 用户 ${lookupName} 的资料，请稍候...`)
        const profile = await fetchProfileByNetworkUserName(lookupName)

        if (!profile) {
          return `❌ 未找到 Volanta 用户 ${lookupName} 的资料。`
        }

        networkUserName = profile.userName || networkUserName || lookupName
        queryKey = queryKey || profile.id || networkUserName

        const { summary } = buildProfileInfoMessage(profile)

        // 大合并转发：头像 + 用户信息 + 最近航班打包为一条合并转发消息
        const allNodes: ForwardNode[] = []

        // 节点1：头像（AI 合规识别，命中违规内容时拦截）
        if (profile.profileImage && profile.profileImage !== 'null') {
          const verdict = await checkImageCompliance(
            { url: profile.profileImage },
            `avatar:${profile.id}`,
            `头像 ${profile.userName || profile.id}`,
          )
          if (verdict === true) {
            log('warn', '用户头像命中违规内容，已拦截', { profileId: profile.id })
            allNodes.push({ message: `🚫 该用户头像包含违反一个中国原则的内容，已被拦截。` })
          } else {
            allNodes.push({ message: h.image(profile.profileImage) })
          }
        }

        // 节点2：用户信息
        allNodes.push({ message: summary })

        // 节点3+：最近航班
        let recentFlights = await fetchRecentFlightsByUserKey(queryKey!)
        if (!recentFlights.length && networkUserName && queryKey !== networkUserName) {
          recentFlights = await fetchRecentFlightsByUserKey(networkUserName)
        }

        if (!recentFlights.length) {
          allNodes.push({ message: `ℹ️ ${networkUserName} 暂无可用的最近航班记录。` })
        } else {
          const sortedFlights = [...recentFlights]
            .sort((a, b) => {
              const ta = Date.parse(a.updatedAt || '') || 0
              const tb = Date.parse(b.updatedAt || '') || 0
              return tb - ta
            })
            .slice(0, 5)

          for (const flight of sortedFlights) {
            const index = sortedFlights.indexOf(flight)
            const text = buildRecentFlightMessage(flight, index, sortedFlights.length)
            const imageUrl = flight.aircraft?.imageUrl || flight.imageUrl || null
            if (imageUrl && imageUrl !== 'null') {
              // AI 合规识别：命中违规配图时仅保留文字并附拦截提示
              const verdict = await checkImageCompliance(
                { url: imageUrl },
                `aircraft:${imageUrl}`,
                `配图 ${flight.callsign || flight.aircraftRegistration || flight.id || imageUrl.slice(0, 60)}`,
              )
              if (verdict === true) {
                log('warn', '飞机配图命中违规内容，已拦截', { flightId: flight.id, imageUrl: imageUrl.slice(0, 120) })
                allNodes.push({ message: `${text}\n${AI_BLOCK_NOTICE}` })
                continue
              }
              allNodes.push({ message: [text, '\n', h.image(imageUrl)] as Fragment })
              continue
            }
            allNodes.push({ message: text })
          }
        }

        await sendMergedForwardNodes(session, allNodes)
      } catch (error: any) {
        log('error', 'volanta信息查询失败', {
          queryKey,
          networkUserName,
          error: error.message,
          stack: error.stack,
        })
        // 降级：资料/航班接口（api.volanta.app）不可用时，尝试从实时航班数据
        // （webassets.volanta.app，不同主机）获取该用户的在飞信息，至少给出基本状态。
        const reason = describeHttpError(error)
        try {
          const fallbackFlight = networkUserName
            ? await fetchFlightByUsername(networkUserName, false)
            : null
          if (fallbackFlight) {
            const { baseInfo } = await buildFlightInfo(fallbackFlight)
            return `⚠️ Volanta 资料接口暂时不可用（${reason}），以下为实时航班信息：\n\n${baseInfo}`
          }
        } catch (fallbackError: any) {
          log('warn', 'volanta信息降级查询实时航班也失败', { error: fallbackError.message })
        }
        return `❌ 查询失败: ${reason}`
      }
    })

  // 命令4: volanta教程 [@用户] - 列出 Volanta 所有命令的作用、用法与示例，并艾特目标
  ctx.command('volanta教程 [target]', '输出 Volanta 命令用法/示例速查')
    .action(async ({ session }, target) => {
      if (!session) {
        log('warn', 'volanta教程命令缺少session上下文')
        return '❌ 无法获取会话信息，请稍后重试。'
      }

      const mention = (() => {
        if (typeof target === 'string' && target.includes('<at')) {
          return target
        }
        if (!session.userId) {
          return ''
        }
        const safeName = (session.username || 'Volanta 用户').replace(/["<>]/g, '')
        return `<at id="${session.userId}" name="${safeName}" />`
      })()

      const commandList = [
        {
          usage: 'volanta教程 [@用户]',
          description: '艾特目标后优先提醒该用户，默认艾特自己，并列出每个命令的作用与示例。',
          example: 'volanta教程'
        },
        {
          usage: 'volanta航班 <flightNumber>',
          description: '通过航班号查询 Volanta 在飞航班，若同号多条会列出序号、用户名与起降机场（含中文名）。',
          example: 'volanta航班 CA150'
        },
        {
          usage: 'volanta绑定 <networkUserName>',
          description: '把当前QQ与指定的 Volanta 用户名绑定，后续查询可直接用 volanta查询。★',
          example: 'volanta绑定 VolantaPilot123'
        },
        {
          usage: 'volanta查询 [@用户/callsign/username/flightNumber]',
          description: '查询@的用户、呼号、Volanta 用户名、航班号或自己的飞行状态。',
          example: 'volanta查询 CCA150'
        },
        {
          usage: 'volanta信息 [@用户/networkUserName]',
          description: '查询Volanta资料并附带最近5次航班（合并转发），支持@已绑定用户或直接输入用户名。',
          example: 'volanta信息 Lukas2809'
        },
        {
          usage: 'volanta刷新',
          description: '强制刷新一遍 Volanta 航班数据缓存，通常用于察看新近加入的航班。',
          example: 'volanta刷新'
        }
      ]

      const header = mention ? `${mention} Volanta 指令速查：` : 'Volanta 指令速查：'
      const lines = [
        header,
        '',
        ...commandList.map(item => `- \`${item.usage}\`：${item.description} 示例：\`${item.example}\``)
      ]

      return session.send(lines.join('\n'))
    })

  // 新增命令：强制刷新航班数据
  ctx.command('volanta刷新', '强制刷新Volanta航班数据')
    .action(async ({ session }) => {
      if (!session) {
        log('warn', 'volanta刷新命令缺少session上下文')
        return '❌ 无法获取会话信息，请稍后重试。'
      }

      log('info', '收到强制刷新命令请求', { userId: session.userId })
      
      try {
        await session.send('正在强制刷新Volanta航班数据，请稍候...')
        
        // 强制刷新数据
        const flights = await fetchAllFlights(true)
        
        log('info', '强制刷新完成', { flightCount: flights.length })
        return `✅ 航班数据刷新成功！当前共有 ${flights.length} 个航班在飞行中。`
      } catch (error: any) {
        log('error', '强制刷新航班数据失败', { 
          error: error.message,
          stack: error.stack 
        })
        return `❌ 刷新失败: ${error.message}`
      }
    })

  // 插件启动日志
  log('info', 'Volanta搜索插件已启动', {
    version: '1.0.0',
    outputFormat: config.outputFormat,
    enableLogging: config.enableLogging,
    hasPuppeteer: !!ctx.puppeteer,
    enableAirportChineseName: config.enableAirportChineseName,
    forceRefresh: config.forceRefresh,
    cacheDuration: config.cacheDuration,
    timeout: config.timeout,
    dataTimeout: config.dataTimeout,
    selectionTimeout: config.selectionTimeout,
    screenshotDelay: config.screenshotDelay,
    zoomLevel: config.zoomLevel,
    retryCount: config.retryCount,
    aiEnabled: config.aiEnabled,
    aiModel: config.aiEnabled ? config.aiModel : undefined,
  })
}
