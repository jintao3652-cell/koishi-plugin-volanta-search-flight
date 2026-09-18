import { Context, Schema, h, segment, Session, Fragment } from 'koishi'
import { } from 'koishi-plugin-puppeteer'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

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

async function sendFlightForward(session: Session, routeMessage: string, mainMessage: any[]) {
  const bot = session.bot as any
  const groupId = session.isDirect ? null : String(session.guildId || session.channelId || '')
  const userId = session.isDirect ? String(session.userId || session.channelId || '') : null
  // 合并转发节点用机器人自己的账号展示（用他人 QQ 号会被协议端拒绝）
  const selfId = String(bot?.selfId ?? session.userId ?? '10000').match(/\d+/g)?.pop() || '10000'
  const nodes = [
    { type: 'node', data: { user_id: selfId, nickname: 'Volanta', content: toForwardContent([routeMessage]) } },
    { type: 'node', data: { user_id: selfId, nickname: 'Volanta', content: toForwardContent(mainMessage) } },
  ]
  if ((session.platform === 'onebot' || bot?.platform === 'onebot') && (groupId || userId)) {
    try {
      await oneBotSendForward(bot, groupId, userId, nodes)
      return
    } catch {}
  }
  // 非 OneBot 平台，或 OneBot 合并转发失败：回退为 Koishi 原生合并转发
  const forward = segment('message', { forward: true }, [
    segment('message', {}, routeMessage),
    segment('message', {}, ...mainMessage),
  ])
  await session.send(forward)
}

export interface Config {
  timeout: number
  selectionTimeout: number
  screenshotDelay: number
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
  // 强制刷新配置
  forceRefresh: boolean
}

export const Config = Schema.object({
  timeout: Schema.number()
    .default(30000)
    .min(5000)
    .max(120000)
    .step(1000)
    .description('请求超时时间(毫秒)'),
  
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
  
  forceRefresh: Schema.boolean()
    .default(true)
    .description('每次查询都强制刷新航班数据'),
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

function isBlockedAircraftRegistration(registration: unknown): boolean {
  return /^B-\d{5}$/i.test(String(registration ?? '').trim())
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
  
  // 航班数据缓存 - 添加强制刷新控制
  type FlightCache = {
    data: VolantaFlight[]
    timestamp: number
  }
  let flightCache: FlightCache | null = null

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
        log('warn', 'Volanta request failed; retrying.', { url, attempt: attempt + 1, delay })
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    throw lastError
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

    try {
      log('debug', '开始请求xflysim机场API', { 
        icao,
        url: `https://api.xflysim.com/pilot/api/realTimeMap/airports/${icao}` 
      })
      
      const response = await ctx.http.get(`https://api.xflysim.com/pilot/api/realTimeMap/airports/${icao}`, {
        timeout: config.timeout,
        headers: {
          'User-Agent': config.userAgent
        }
      }) as XflysimAirportResponse

      log('debug', '收到xflysim API响应', { 
        icao,
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
        
        log('info', '成功获取机场中文名称', { 
          icao, 
          cnName: response.data.cnName 
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
      log('error', '获取机场信息时发生错误', { 
        icao, 
        error: error.message,
        stack: error.stack 
      })
      return null
    }
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
    
    for (let attempt = 1; attempt <= config.retryCount + 1; attempt++) {
      try {
        log('info', `开始第 ${attempt} 次尝试获取航班数据`)
        
        const requestStartTime = Date.now()
        log('debug', '发送HTTP请求到Volanta API')
        
        const response = await ctx.http.get('https://webassets.volanta.app/volanta-flight-positions.json', {
          timeout: config.timeout,
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
        
        log('debug', '更新航班数据缓存', { 
          flightCount: flights.length,
          timestamp: flightCache.timestamp 
        })
        
        return flights
        
      } catch (error: any) {
        log('error', `第 ${attempt} 次获取航班数据失败`, { 
          attempt,
          error: error.message,
          stack: error.stack 
        })
        
        if (attempt === config.retryCount + 1) {
          // 最后一次失败时，如果有缓存数据则返回缓存
          if (flightCache) {
            log('warn', '所有尝试失败，使用过期的缓存数据作为备选', { 
              cacheAge: Date.now() - flightCache.timestamp,
              flightCount: flightCache.data.length 
            })
            return flightCache.data
          }
          log('error', '所有尝试失败且无缓存数据可用')
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
  async function captureFlightScreenshot(flight: VolantaFlight, attempt: number = 1): Promise<Buffer | null> {
    if (isBlockedAircraftRegistration(flight.aircraftRegistration)) {
      log('info', '注册号匹配图片拦截规则，已跳过 Volanta 截图', {
        flightId: flight.id,
        callsign: flight.callsign,
        aircraftRegistration: flight.aircraftRegistration,
      })
      return null
    }
    log('debug', '开始截图流程', { 
      flightId: flight.id,
      callsign: flight.callsign 
    })
    
    if (!ctx.puppeteer) {
      log('error', 'Puppeteer服务未安装，无法截图')
      return null
    }

    log('debug', 'Puppeteer服务可用，开始创建页面')
    const page = await ctx.puppeteer.page()

    // 跟踪加载失败的资源，便于诊断白屏原因
    const failedRequests: string[] = []
    ;(page as any).on?.('requestfailed', (request: any) => {
      if (failedRequests.length < 20) {
        failedRequests.push(`${request.failure()?.errorText || 'failed'} ${String(request.url()).slice(0, 120)}`)
      }
    })

    const maxAttempts = Math.max(1, (config.retryCount || 0) + 1)
    let blankDetected = false

    try {
      log('debug', '设置页面视窗', { 
        width: config.viewportWidth, 
        height: config.viewportHeight 
      })
      await page.setViewport({ 
        width: Math.max(320, config.viewportWidth), 
        height: Math.max(320, config.viewportHeight) 
      })
      
      log('debug', '设置User-Agent', { userAgent: config.userAgent })
      await page.setUserAgent(config.userAgent)
      
      const flightUrl = `https://fly.volanta.app/flights/${flight.id}/stats`
      log('info', '导航到航班页面', { url: flightUrl })
      
      await page.goto(flightUrl, { 
        waitUntil: 'domcontentloaded',
        timeout: config.timeout 
      })
      
      log('debug', '页面加载完成，等待3秒确保内容渲染')
      await new Promise(res => setTimeout(res, 3000))
      
      // 尝试点击关注按钮
      const followButtonXPath = '/html/body/app-root/div/app-flight-view/div/div/app-flight-card-header/div/ul[3]/li[2]/a/img'
      log('debug', '尝试查找关注按钮', { xpath: followButtonXPath })
      
      try {
        const findElementByXPath = async (xpath: string) => {
          return await page.evaluate((xpath) => {
            const result = document.evaluate(
              xpath, 
              document, 
              null, 
              XPathResult.FIRST_ORDERED_NODE_TYPE, 
              null
            )
            return result.singleNodeValue
          }, xpath)
        }
        
        const followButton = await findElementByXPath(followButtonXPath)
        
        if (followButton) {
          log('info', '找到关注按钮，正在点击')
          await page.evaluate((xpath) => {
            const result = document.evaluate(
              xpath, 
              document, 
              null, 
              XPathResult.FIRST_ORDERED_NODE_TYPE, 
              null
            )
            const element = result.singleNodeValue as HTMLElement
            if (element) {
              element.click()
            }
          }, followButtonXPath)
          log('debug', '关注按钮点击完成，等待2秒')
          await new Promise(res => setTimeout(res, 2000))
        } else {
          log('debug', '未找到关注按钮，继续截图')
        }
      } catch (error: any) {
        log('warn', '点击关注按钮失败，继续截图', { error: error.message })
      }
      
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
          size: screenshot.length 
        })
        return screenshot
      }
      
    } catch (error: any) {
      log('error', '截图过程中发生错误', { 
        error: error.message,
        stack: error.stack 
      })
      return null
    } finally {
      log('debug', '关闭页面')
      await page.close()
    }

    // 空白重试：网络抖动导致页面 JS 未加载时通常重试即可恢复
    if (blankDetected && attempt < maxAttempts) {
      log('info', '空白截图，正在重试', { nextAttempt: attempt + 1, maxAttempts })
      return captureFlightScreenshot(flight, attempt + 1)
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
    if (isBlockedAircraftRegistration(flight.aircraftRegistration)) {
      return { mainMessage: [baseInfo], routeMessage: routeInfo }
    }
    
    let mainMessage: any[]
    switch (config.outputFormat) {
      case OutputFormat.IMAGE_ONLY:
        log('debug', '使用IMAGE_ONLY输出格式')
        mainMessage = screenshot ? [h.image(screenshot, 'image/png')] : ['截图失败，请稍后重试。']
        break
      
      case OutputFormat.TEXT_ONLY:
        log('debug', '使用TEXT_ONLY输出格式')
        mainMessage = [baseInfo]
        break
      
      case OutputFormat.BOTH:
      default:
        log('debug', '使用BOTH输出格式')
        if (screenshot) {
          mainMessage = [h.image(screenshot, 'image/png'), '\n' + baseInfo]
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

        if (profile.profileImage && profile.profileImage !== 'null') {
          try {
            await session.send(h.image(profile.profileImage))
          } catch (error: any) {
            // Remote image fetching is performed by the OneBot implementation
            // and may fail independently of the profile query. Keep sending
            // the textual profile rather than failing the whole command.
            log('warn', 'Failed to send Volanta profile image; continuing without it.', {
              error: error?.message || String(error),
            })
          }
        }
        await session.send(summary)

        await session.send(`正在查询 ${networkUserName} 的最近航班，请稍候...`)
        let recentFlights = await fetchRecentFlightsByUserKey(queryKey!)
        if (!recentFlights.length && networkUserName && queryKey !== networkUserName) {
          recentFlights = await fetchRecentFlightsByUserKey(networkUserName)
        }

        if (!recentFlights.length) {
          return `ℹ️ ${networkUserName} 暂无可用的最近航班记录。`
        }

        const sortedFlights = [...recentFlights]
          .sort((a, b) => {
            const ta = Date.parse(a.updatedAt || '') || 0
            const tb = Date.parse(b.updatedAt || '') || 0
            return tb - ta
          })
          .slice(0, 5)

        const nodes: ForwardNode[] = sortedFlights.map((flight, index) => {
          const text = buildRecentFlightMessage(flight, index, sortedFlights.length)
          const imageUrl = flight.aircraft?.imageUrl || flight.imageUrl || null
          const isOneBot = session.platform === 'onebot' || (session.bot as any)?.platform === 'onebot'
          if (!isOneBot && imageUrl && imageUrl !== 'null' && !isBlockedAircraftRegistration(flight.aircraftRegistration)) {
            return { message: [text, '\n', h.image(imageUrl)] as Fragment }
          }
          return { message: text as Fragment }
        })

        await sendMergedForwardNodes(session, nodes)
      } catch (error: any) {
        log('error', 'volanta信息查询失败', {
          queryKey,
          networkUserName,
          error: error.message,
          stack: error.stack,
        })
        return `❌ 查询失败: ${error.message}`
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
    selectionTimeout: config.selectionTimeout,
    screenshotDelay: config.screenshotDelay,
    retryCount: config.retryCount
  })
}
