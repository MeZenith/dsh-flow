/**
 * 零依赖标准 QR Code（ISO/IEC 18004）SVG 生成器。
 *
 * - 支持 Byte 模式（UTF-8）与纠错等级 L（版本 1–25，最高承载 1,273 字节，完整覆盖飞书扫码建应用长 URL）；
 * - 严格按 ISO/IEC 18004 规范实现 Finder/Alignment/Timing/Format/Version 图形、GF(256) Reed-Solomon 纠错码、
 *   数据交织与 8 种掩码惩罚评分择优；
 * - 将同行相邻黑块合并为单条 `<path>`，输出带 4 模块白边（Quiet Zone）的矢量 SVG 及 Data URI，
 *   确保在暗色/亮色主题下均可被手机飞书秒扫识别。
 *
 * @module dsh-flow/remote/feishu/qr-svg
 */

/**
 * ISO/IEC 18004 表 9（纠错等级 L，版本 1–25）：
 * 每项为 `[ecCodewordsPerBlock, numBlocks]`；块数据长度由总码字数自动按标准规则拆分
 * （短块在前 `numBlocks - numLongBlocks` 个，长块在后 `numLongBlocks` 个，长块比短块多 1 字节）。
 */
const ECC_L_TABLE = [
  null, // 0 unused
  [7, 1],    // v1
  [10, 1],   // v2
  [15, 1],   // v3
  [20, 1],   // v4
  [26, 1],   // v5
  [18, 2],   // v6
  [20, 2],   // v7
  [24, 2],   // v8
  [30, 2],   // v9
  [18, 4],   // v10
  [20, 4],   // v11
  [24, 4],   // v12
  [26, 4],   // v13
  [30, 4],   // v14
  [22, 6],   // v15
  [24, 6],   // v16
  [28, 6],   // v17
  [30, 6],   // v18
  [28, 7],   // v19
  [28, 8],   // v20
  [28, 8],   // v21
  [28, 9],   // v22
  [30, 9],   // v23
  [30, 10],  // v24
  [26, 12],  // v25
]

const MIN_VERSION = 1
const MAX_VERSION = ECC_L_TABLE.length - 1

/** 返回版本 v 的对齐图形中心坐标序列（ISO/IEC 18004 附录 E）。 */
function alignmentPatternPositions(version) {
  if (version === 1) return []
  const numAlign = Math.floor(version / 7) + 2
  const step = version === 32
    ? 26
    : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2
  const result = [6]
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos)
  }
  return result
}

/** 计算版本 v 的原始数据区位数（扣除功能图形与格式/版本信息位）。 */
function getNumRawDataModules(version) {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (version >= 7) result -= 36
  }
  return result
}

/** 计算版本 v 在等级 L 下的最大数据字节数。 */
function getNumDataCodewords(version) {
  const [eccPerBlock, numBlocks] = ECC_L_TABLE[version]
  return Math.floor(getNumRawDataModules(version) / 8) - eccPerBlock * numBlocks
}

/** GF(256) 乘法（本原多项式 x^8 + x^4 + x^3 + x^2 + 1 = 0x11D）。 */
function gfMultiply(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

/** 生成 degree 阶 Reed-Solomon 生成多项式系数（不含首项 1）。 */
function rsComputeDivisor(degree) {
  const result = new Uint8Array(degree)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

/** 计算数据块除以生成多项式的 Reed-Solomon 纠错码字。 */
function rsComputeRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length)
  for (const byte of data) {
    const factor = byte ^ result[0]
    result.copyWithin(0, 1)
    result[result.length - 1] = 0
    for (let i = 0; i < divisor.length; i += 1) {
      result[i] ^= gfMultiply(divisor[i], factor)
    }
  }
  return result
}

/** 构造带模式指示符、字节计数、终止符与 0xEC/0x11 填充码字的比特流。 */
function buildDataCodewords(bytes, version) {
  const dataCapacity = getNumDataCodewords(version)
  const bits = []
  const appendBits = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1)
  }

  // Byte 模式指示符 0100
  appendBits(0b0100, 4)
  // 字符计数字段长度：v1–v9 为 8 位，v10–v26 为 16 位
  appendBits(bytes.length, version <= 9 ? 8 : 16)
  for (const b of bytes) appendBits(b, 8)

  const capacityBits = dataCapacity * 8
  // 最多 4 位终止符 0000
  appendBits(0, Math.min(4, capacityBits - bits.length))
  // 补齐到字节边界
  appendBits(0, (8 - (bits.length % 8)) % 8)

  const out = new Uint8Array(dataCapacity)
  let byteIndex = 0
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0
    for (let j = 0; j < 8; j += 1) val = (val << 1) | bits[i + j]
    out[byteIndex++] = val
  }
  // 交替填充 0xEC / 0x11
  let padToggle = true
  while (byteIndex < dataCapacity) {
    out[byteIndex++] = padToggle ? 0xec : 0x11
    padToggle = !padToggle
  }
  return out
}

/** 按 ISO/IEC 18004 分块计算 ECC 并交织全部码字。 */
function addEccAndInterleave(data, version) {
  const [eccLen, numBlocks] = ECC_L_TABLE[version]
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const shortDataLen = shortBlockLen - eccLen

  const divisor = rsComputeDivisor(eccLen)
  const blocks = []
  let offset = 0
  for (let i = 0; i < numBlocks; i += 1) {
    const dataLen = shortDataLen + (i < numShortBlocks ? 0 : 1)
    const chunk = data.subarray(offset, offset + dataLen)
    offset += dataLen
    const ecc = rsComputeRemainder(chunk, divisor)
    blocks.push({ data: chunk, ecc })
  }

  const result = new Uint8Array(rawCodewords)
  let outPos = 0
  const maxDataLen = shortDataLen + (numShortBlocks < numBlocks ? 1 : 0)
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const blk of blocks) {
      if (i < blk.data.length) result[outPos++] = blk.data[i]
    }
  }
  for (let i = 0; i < eccLen; i += 1) {
    for (const blk of blocks) {
      result[outPos++] = blk.ecc[i]
    }
  }
  return result
}

function createMatrix(size) {
  return Array.from({ length: size }, () => new Uint8Array(size))
}

function drawFunctionPatterns(version) {
  const size = version * 4 + 17
  const modules = createMatrix(size)
  const isFunction = createMatrix(size)

  const setFn = (x, y, dark) => {
    modules[y][x] = dark ? 1 : 0
    isFunction[y][x] = 1
  }

  // Timing patterns
  for (let i = 0; i < size; i += 1) {
    setFn(6, i, i % 2 === 0)
    setFn(i, 6, i % 2 === 0)
  }

  // 3 Finder patterns + 1-module white separator
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || x >= size || y < 0 || y >= size) continue
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        setFn(x, y, dist !== 2 && dist !== 4)
      }
    }
  }
  drawFinder(3, 3)
  drawFinder(size - 4, 3)
  drawFinder(3, size - 4)

  // Alignment patterns
  const alignPos = alignmentPatternPositions(version)
  const numAlign = alignPos.length
  for (let i = 0; i < numAlign; i += 1) {
    for (let j = 0; j < numAlign; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0)) continue
      const cx = alignPos[i]
      const cy = alignPos[j]
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
  }

  // Reserve format bits (dummy mask 0, overwritten after mask selection)
  drawFormatBits(modules, isFunction, size, 0)
  // Draw version info for v >= 7
  if (version >= 7) drawVersionBits(modules, isFunction, size, version)

  return { size, modules, isFunction }
}

/** 写入 15 位格式信息（ECC Level L = 01，mask 0..7）。 */
function drawFormatBits(modules, isFunction, size, mask) {
  const data = (0b01 << 3) | mask // Level L format bits = 01
  let rem = data
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412

  const setFn = (x, y, dark) => {
    modules[y][x] = dark ? 1 : 0
    isFunction[y][x] = 1
  }

  for (let i = 0; i <= 5; i += 1) setFn(8, i, ((bits >>> i) & 1) !== 0)
  setFn(8, 7, ((bits >>> 6) & 1) !== 0)
  setFn(8, 8, ((bits >>> 7) & 1) !== 0)
  setFn(7, 8, ((bits >>> 8) & 1) !== 0)
  for (let i = 9; i < 15; i += 1) setFn(14 - i, 8, ((bits >>> i) & 1) !== 0)

  for (let i = 0; i < 8; i += 1) setFn(size - 1 - i, 8, ((bits >>> i) & 1) !== 0)
  for (let i = 8; i < 15; i += 1) setFn(8, size - 15 + i, ((bits >>> i) & 1) !== 0)
  setFn(8, size - 8, true) // 固定暗模块
}

/** 写入 18 位版本信息（v >= 7）。 */
function drawVersionBits(modules, isFunction, size, version) {
  let rem = version
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  const bits = (version << 12) | rem

  const setFn = (x, y, dark) => {
    modules[y][x] = dark ? 1 : 0
    isFunction[y][x] = 1
  }

  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) !== 0
    const a = size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    setFn(a, b, dark)
    setFn(b, a, dark)
  }
}

/** 按双列 Z 字形自右下向左上写入全部交织码字位。 */
function drawCodewords(modules, isFunction, size, codewords) {
  let bitIndex = 0
  const totalBits = codewords.length * 8
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (isFunction[y][x] === 0 && bitIndex < totalBits) {
          modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1)
          bitIndex += 1
        }
      }
    }
  }
}

function applyMask(modules, isFunction, size, mask) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (isFunction[y][x] !== 0) continue
      let invert = false
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break
        case 1: invert = y % 2 === 0; break
        case 2: invert = x % 3 === 0; break
        case 3: invert = (x + y) % 3 === 0; break
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break
        default: break
      }
      if (invert) modules[y][x] ^= 1
    }
  }
}

function computePenalty(modules, size) {
  let penalty = 0

  // Rule 1: 5+ consecutive same-color modules in rows/cols
  for (let y = 0; y < size; y += 1) {
    let runColor = modules[y][0]
    let runLen = 1
    for (let x = 1; x < size; x += 1) {
      if (modules[y][x] === runColor) {
        runLen += 1
        if (runLen === 5) penalty += 3
        else if (runLen > 5) penalty += 1
      } else {
        runColor = modules[y][x]
        runLen = 1
      }
    }
  }
  for (let x = 0; x < size; x += 1) {
    let runColor = modules[0][x]
    let runLen = 1
    for (let y = 1; y < size; y += 1) {
      if (modules[y][x] === runColor) {
        runLen += 1
        if (runLen === 5) penalty += 3
        else if (runLen > 5) penalty += 1
      } else {
        runColor = modules[y][x]
        runLen = 1
      }
    }
  }

  // Rule 2: 2x2 same-color blocks
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = modules[y][x]
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        penalty += 3
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns
  const hasFinderLike = (line) => {
    let hits = 0
    for (let i = 0; i <= size - 11; i += 1) {
      // 10111010000 or 00001011101
      if (
        (line[i] === 1 && line[i + 1] === 0 && line[i + 2] === 1 && line[i + 3] === 1 && line[i + 4] === 1
          && line[i + 5] === 0 && line[i + 6] === 1 && line[i + 7] === 0 && line[i + 8] === 0 && line[i + 9] === 0 && line[i + 10] === 0)
        || (line[i] === 0 && line[i + 1] === 0 && line[i + 2] === 0 && line[i + 3] === 0 && line[i + 4] === 1
          && line[i + 5] === 0 && line[i + 6] === 1 && line[i + 7] === 1 && line[i + 8] === 1 && line[i + 9] === 0 && line[i + 10] === 1)
      ) {
        hits += 1
      }
    }
    return hits * 40
  }
  const col = new Uint8Array(size)
  for (let y = 0; y < size; y += 1) penalty += hasFinderLike(modules[y])
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) col[y] = modules[y][x]
    penalty += hasFinderLike(col)
  }

  // Rule 4: dark module balance
  let darkCount = 0
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) darkCount += modules[y][x]
  }
  const total = size * size
  const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1
  if (k > 0) penalty += k * 10

  return penalty
}

/**
 * 将文本编码为标准 QR Code 模块矩阵。
 *
 * @param {string} text
 * @returns {{ version: number, size: number, mask: number, modules: Uint8Array[] }}
 */
export function encodeQrMatrix(text) {
  const bytes = Buffer.from(String(text ?? ''), 'utf8')
  if (bytes.length === 0) throw new Error('QR 内容不能为空')

  let version = 0
  for (let v = MIN_VERSION; v <= MAX_VERSION; v += 1) {
    const headerBits = 4 + (v <= 9 ? 8 : 16)
    const neededBits = headerBits + bytes.length * 8
    if (neededBits <= getNumDataCodewords(v) * 8) {
      version = v
      break
    }
  }
  if (version === 0) {
    throw new Error(`QR 内容过长（${bytes.length} 字节，超过版本 ${MAX_VERSION} 容量上限）`)
  }

  const data = buildDataCodewords(bytes, version)
  const codewords = addEccAndInterleave(data, version)
  const { size, modules, isFunction } = drawFunctionPatterns(version)
  drawCodewords(modules, isFunction, size, codewords)

  let bestMask = 0
  let minPenalty = Infinity
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(modules, isFunction, size, mask)
    drawFormatBits(modules, isFunction, size, mask)
    const penalty = computePenalty(modules, size)
    if (penalty < minPenalty) {
      minPenalty = penalty
      bestMask = mask
    }
    applyMask(modules, isFunction, size, mask) // 还原
  }

  applyMask(modules, isFunction, size, bestMask)
  drawFormatBits(modules, isFunction, size, bestMask)
  return { version, size, mask: bestMask, modules }
}

/**
 * 将文本编码为带 4 模块白边的紧凑矢量 SVG 字符串。
 *
 * @param {string} text
 * @param {{ border?: number, dark?: string, light?: string }} [opts]
 * @returns {string}
 */
export function encodeQrSvg(text, { border = 4, dark = '#111111', light = '#ffffff' } = {}) {
  const { size, modules } = encodeQrMatrix(text)
  const viewSize = size + border * 2
  const segments = []

  for (let y = 0; y < size; y += 1) {
    const row = modules[y]
    let x = 0
    while (x < size) {
      if (row[x] === 0) {
        x += 1
        continue
      }
      const start = x
      while (x < size && row[x] === 1) x += 1
      const width = x - start
      segments.push(`M${start + border},${y + border}h${width}v1h-${width}z`)
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges">`,
    `<rect width="100%" height="100%" fill="${light}"/>`,
    `<path fill="${dark}" d="${segments.join('')}"/>`,
    '</svg>',
  ].join('')
}

/** 将文本编码为可直接放进 `<img src="...">` 的 SVG Data URI。 */
export function encodeQrDataUrl(text, opts) {
  const svg = encodeQrSvg(text, opts)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
