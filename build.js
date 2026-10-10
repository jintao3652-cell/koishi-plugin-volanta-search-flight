// 构建脚本：等价于 yakumo 对单个插件的构建流程
//   1) tsc   -> 产出 lib/*.d.ts（类型声明，emitDeclarationOnly）
//   2) esbuild -> 打包 lib/index.js（CJS，依赖走 external 不内联）
// 用法：node external/volanta-search-flight/build.js
const path = require('path')
const { execFileSync } = require('child_process')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..', '..') // D:/koishi/dev/koishi-app

function runTsc() {
  // 项目里的 yakumo 在 Windows 下只有 sh 包装脚本，无法用 node 直跑，这里直接调 tsc
  execFileSync(process.execPath, [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', path.join(__dirname, 'tsconfig.json'),
  ], { stdio: 'inherit' })
}

async function runEsbuild() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'index.ts')],
    outfile: path.join(__dirname, 'lib', 'index.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    logLevel: 'warning',
    external: ['koishi', 'axios', 'cordis', '@satorijs/*', '@koishijs/*'],
  })
}

;(async () => {
  try {
    runTsc()
    await runEsbuild()
    console.log('volanta-search-flight BUILD OK -> external/volanta-search-flight/lib/index.js')
  } catch (e) {
    console.error('volanta-search-flight BUILD FAILED')
    console.error(e.message || e)
    process.exit(1)
  }
})()
