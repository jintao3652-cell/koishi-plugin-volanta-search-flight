import { Context, Schema, h } from 'koishi'
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

export interface Config {
  timeout: number
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
  let flightCache: {
    data: VolantaFlight[]
    timestamp: number
  } | null = null

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
    } catch (error) {
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
    } catch (error) {
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
    } catch (error) {
      log('error', '获取机场信息时发生错误', { 
        icao, 
        error: error.message,
        stack: error.stack 
      })
      return null
    }
  }

  // 检查缓存是否有效
  function isCacheValid(): boolean {
    const isValid = flightCache && 
                   !config.forceRefresh && 
                   Date.now() - flightCache.timestamp < config.cacheDuration
    
    log('debug', '检查航班数据缓存有效性', { 
      hasCache: !!flightCache,
      forceRefresh: config.forceRefresh,
      cacheAge: flightCache ? Date.now() - flightCache.timestamp : 'N/A',
      cacheDuration: config.cacheDuration,
      isValid 
    })
    
    return isValid
  }

  // 获取所有航班数据的函数 - 强制刷新版本
  async function fetchAllFlights(forceRefresh: boolean = false): Promise<VolantaFlight[]> {
    log('debug', '开始获取所有航班数据', { forceRefresh, configForceRefresh: config.forceRefresh })
    
    // 检查缓存是否有效（考虑强制刷新设置）
    if (!forceRefresh && isCacheValid()) {
      log('debug', '使用缓存的航班数据', { 
        flightCount: flightCache.data.length,
        cacheAge: Date.now() - flightCache.timestamp 
      })
      return flightCache.data
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
        
      } catch (error) {
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

    log('debug', 'Puppeteer服务可用，开始创建页面')
    const page = await ctx.puppeteer.page()
    
    try {
      log('debug', '设置页面视窗', { 
        width: config.viewportWidth, 
        height: config.viewportHeight 
      })
      await page.setViewport({ 
        width: config.viewportWidth, 
        height: config.viewportHeight 
      })
      
      log('debug', '设置User-Agent', { userAgent: config.userAgent })
      await page.setUserAgent(config.userAgent)
      
      log('debug', '启用请求拦截以优化性能')
      await page.setRequestInterception(true)
      page.on('request', (req) => {
        const resourceType = req.resourceType()
        if (['image', 'font', 'media'].includes(resourceType)) {
          log('debug', `拦截资源请求: ${resourceType}`, { url: req.url() })
          req.abort()
        } else {
          req.continue()
        }
      })

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
      } catch (error) {
        log('warn', '点击关注按钮失败，继续截图', { error: error.message })
      }
      
      log('info', `等待地图加载 ${config.screenshotDelay}ms`)
      await new Promise(res => setTimeout(res, config.screenshotDelay))
      
      log('debug', '开始截图')
      const screenshotStartTime = Date.now()
      const screenshot = await page.screenshot({ 
        type: 'png',
        fullPage: false
      }) as Buffer
      const screenshotDuration = Date.now() - screenshotStartTime
      
      log('info', '截图完成', { 
        duration: screenshotDuration,
        size: screenshot.length 
      })
      return screenshot
      
    } catch (error) {
      log('error', '截图过程中发生错误', { 
        error: error.message,
        stack: error.stack 
      })
      return null
    } finally {
      try {
        log('debug', '清理页面事件监听器')
        page.off('request')
        await page.setRequestInterception(false)
      } catch (e) {
        log('debug', '清理页面事件监听器时发生错误', { error: e.message })
      }
      log('debug', '关闭页面')
      await page.close()
    }
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
      } catch (error) {
        log('warn', '获取机场中文名称失败，使用原始ICAO代码', { error: error.message })
      }
    } else {
      log('debug', '机场中文名称查询已禁用')
    }

    // 构建基本信息（不包含航路）
    const baseInfo = `🛫 航班信息 - ${flight.callsign}

📋 基本信息：
├─ 航班号: ${formatString(flight.flightNumber)}
├─ 用户名: ${formatString(flight.networkUserName)}
├─ 机型: ${formatString(flight.aircraftIcao)}
├─ 注册号: ${formatString(flight.aircraftRegistration)}
├─ 起飞机场: ${originInfo}
├─ 目的机场: ${destinationInfo}
├─ 模拟器: ${formatString(flight.simulatorAbbreviation)}
└─ 网络: ${formatString(flight.network)}

📍 实时位置：
├─ 纬度: ${formatNumber(position.latitude, 4)}°
├─ 经度: ${formatNumber(position.longitude, 4)}°
├─ 高度: ${position.altitude} 英尺 (AGL: ${position.altitudeAgl} 英尺)
├─ 航向: ${formatNumber(position.headingTrue, 1)}°
├─ 地速: ${formatNumber(position.groundSpeed, 1)} 节
├─ 垂直速度: ${formatNumber(position.verticalSpeed, 1)} 英尺/分钟
├─ 应答机: ${formatString(position.transponder)}
└─ 状态: ${position.onGround ? '在地面' : '在空中'}`

    // 构建航路信息
    const routeInfo = `🛣️ 航路信息：
${flight.atcRoute && flight.atcRoute !== 'null' ? flight.atcRoute : '暂无航路信息'}`

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

  // 命令1: volanta <callsign/flightNumber> - 添加强制刷新
  const volantaCmd = ctx.command('volanta <callsign>', '通过呼号/航班号搜索Volanta航班')
    .action(async ({ session }, callsign) => {
      log('info', '收到volanta命令请求', { 
        userId: session.userId,
        callsign,
        channelId: session.channelId 
      })
      
      if (!callsign) {
        log('warn', 'volanta命令缺少呼号参数')
        return '请输入航班呼号或航班号。'
      }

      const searchCallsign = callsign.toUpperCase()
      log('info', '开始处理航班搜索请求', { searchCallsign })
      
      try {
        await session.send(`正在搜索航班 ${searchCallsign}，请稍候...`)

        // 强制刷新Volanta数据
        const flight = await fetchFlightByCallsign(searchCallsign, config.forceRefresh)
        
        if (!flight) {
          log('info', '未找到指定呼号的航班', { searchCallsign })
          return `❌ 未找到呼号或航班号为 ${searchCallsign} 的航班，或者该航班当前不在飞行中。`
        }

        if (flight.privacyOption !== 'Public') {
          log('info', '找到航班但隐私设置为非公开', { 
            callsign: flight.callsign,
            privacyOption: flight.privacyOption 
          })
          return `🔒 航班 ${searchCallsign} 的隐私设置为非公开，无法查看详细信息。`
        }

        log('info', '找到有效航班，准备生成回复', { 
          callsign: flight.callsign,
          userName: flight.networkUserName 
        })

        let screenshot: Buffer | null = null
        
        if (config.outputFormat !== OutputFormat.TEXT_ONLY) {
          log('debug', '开始截图流程')
          screenshot = await captureFlightScreenshot(flight)
        } else {
          log('debug', '跳过截图（TEXT_ONLY模式）')
        }

        const { mainMessage, routeMessage } = await buildReplyMessage(flight, screenshot)
        log('info', '准备发送航班信息回复')
        
        // 先发送航路信息，再发送主消息
        if (routeMessage) {
          await session.send(routeMessage)
        }
        
        // 然后发送主消息
        await session.send(mainMessage)
        
      } catch (error) {
        log('error', '处理航班搜索请求时发生错误', { 
          callsign: searchCallsign,
          error: error.message,
          stack: error.stack 
        })
        return `❌ 请求失败: ${error.message}`
      }
    })

  // 命令2: 绑定 <networkUserName> - 添加强制刷新
  const bindCmd = ctx.command('绑定 <networkUserName>', '绑定当前用户到Volanta用户名')
    .action(async ({ session }, networkUserName) => {
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
        
      } catch (error) {
        log('error', '处理绑定请求时发生错误', { 
          networkUserName,
          error: error.message,
          stack: error.stack 
        })
        return `❌ 绑定失败: ${error.message}`
      }
    })

  // 命令3: 查询 [@用户/networkUserName] - 修复@用户查询逻辑
const queryCmd = ctx.command('volanta查询 [target]', '查询被@用户、指定用户或自己的飞行状态')
  .action(async ({ session }, target) => {
    log('info', '收到volanta查询命令请求', { 
      userId: session.userId,
      target,
      channelId: session.channelId,
      message: session.event.message?.content 
    })
    
    // 检查是否有@用户 - 修复解析逻辑
    let targetUserId: string | null = null
    let targetUserName: string | null = null
    let searchUsername: string | null = null
    
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
        if (!targetUserId && session.quote) {
          targetUserId = session.quote.user.id
          targetUserName = session.quote.user.name || '未知用户'
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
      
    } catch (error) {
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
        await session.send(`${targetUserName} 的飞行状态：`)
        
        // 然后发送航路信息
        if (routeMessage) {
          await session.send(routeMessage)
        }
        
        // 最后发送主消息
        await session.send(mainMessage)
        
      } catch (error) {
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
          searchUsername = nameMatch[1]
          log('debug', '从at标签中提取用户名', { searchUsername })
        } else {
          searchUsername = target
        }
      } else {
        searchUsername = target
      }
      
      log('info', '处理用户名查询请求', { searchUsername })
      
      try {
        await session.send(`正在搜索用户 ${searchUsername} 的航班，请稍候...`)

        // 强制刷新Volanta数据
        const flight = await fetchFlightByUsername(searchUsername, config.forceRefresh)
        
        if (!flight) {
          log('info', '未找到指定用户名的航班', { searchUsername })
          return `❌ 未找到用户名包含 "${searchUsername}" 的航班，该用户可能当前没有在飞行。`
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
          log('debug', '开始为用户查询截图')
          screenshot = await captureFlightScreenshot(flight)
        }

        const { mainMessage, routeMessage } = await buildReplyMessage(flight, screenshot)
        log('info', '准备发送用户查询结果')
        
        // 先发送航路信息
        if (routeMessage) {
          await session.send(routeMessage)
        }
        
        // 然后发送主消息
        await session.send(mainMessage)
        
      } catch (error) {
        log('error', '处理用户名查询请求时发生错误', { 
          searchUsername,
          error: error.message,
          stack: error.stack 
        })
        return `❌ 查询失败: ${error.message}`
      }
    }
    // 既没有@用户也没有参数，查询自己的绑定信息
    else {
      const currentUserId = session.userId
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
        await session.send(`您的飞行状态：`)
        
        // 然后发送航路信息
        if (routeMessage) {
          await session.send(routeMessage)
        }
        
        // 最后发送主消息
        await session.send(mainMessage)
        
      } catch (error) {
        log('error', '处理当前用户查询请求时发生错误', { 
          currentUserId,
          error: error.message,
          stack: error.stack 
        })
        return `❌ 查询失败: ${error.message}`
      }
    }
  })

  // 新增命令：强制刷新航班数据
  ctx.command('volanta刷新', '强制刷新Volanta航班数据')
    .action(async ({ session }) => {
      log('info', '收到强制刷新命令请求', { userId: session.userId })
      
      try {
        await session.send('正在强制刷新Volanta航班数据，请稍候...')
        
        // 强制刷新数据
        const flights = await fetchAllFlights(true)
        
        log('info', '强制刷新完成', { flightCount: flights.length })
        return `✅ 航班数据刷新成功！当前共有 ${flights.length} 个航班在飞行中。`
      } catch (error) {
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
    screenshotDelay: config.screenshotDelay,
    retryCount: config.retryCount
  })
}