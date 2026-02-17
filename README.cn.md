
# zmodem2-js

**中文文档** | [English](README.md)

> **注意：**
>
> 本项目是对 [zmodem2](https://codeberg.org/jarkko/zmodem2) Rust crate 的 JavaScript/TypeScript 移植。部分代码由 KiloCode 的 GLM5 模型 (z.ai) 生成。
>
> **所有的原始作者署名归属于 Jarkko Sakkinen。**

这是一个面向 JavaScript/TypeScript 的现代 ZMODEM 文件传输协议库。该库提供类似流的状态机，用于通过 ZMODEM 协议发送和接收文件，适用于 Node.js 和浏览器环境。

## 功能特性

- **跨平台**：同时支持 Node.js 与浏览器环境
- **原生 TypeScript 支持**：提供完整的类型声明文件
- **多种模块格式**：提供 ESM、CommonJS 与打包后的一体化版本
- **可摇树优化（tree-shakeable）**：ESM 输出支持摇树优化以减小包体积
- **零运行时依赖**：轻量且自包含
- **流式 API**：通过流式操作高效处理大文件

## 安装

```bash
npm install zmodem2
```

## 模块格式

本包提供多种输出格式以适应不同的使用场景：

| 格式 | 路径 | 说明 |
|------|------|------|
| ESM | `dist/esm/` | ES 模块，支持摇树优化，无捆绑依赖 |
| CommonJS | `dist/cjs/` | CommonJS 模块，无捆绑依赖 |
| CommonJS Full | `dist/cjs-full/` | 所有代码打包到单一文件的 CommonJS 版本 |
| Browser | `dist/browser/` | 供浏览器直接使用的 IIFE 格式 |

## 使用方法

### ES 模块 (ESM) — 推荐用于打包器

适用于支持摇树优化的现代打包器（如 webpack、rollup、vite 等）：

```javascript
import { Sender, Receiver, ZmodemError } from 'zmodem2'
```

// 创建用于发送的 Sender
const sender = new Sender()

// 创建用于接收的 Receiver
const receiver = new Receiver()

### CommonJS - Node.js

在 Node.js 中使用 `require()` 时：

```javascript
const { Sender, Receiver, ZmodemError } = require('zmodem2')

// 创建用于发送的 Sender
const sender = new Sender()

// 创建用于接收的 Receiver
const receiver = new Receiver()
```

### CommonJS 完整包 - Node.js（一体化）

适用于希望将所有代码打包到单一文件的环境：

```javascript
const zmodem2 = require('zmodem2/cjs-full')

const { Sender, Receiver } = zmodem2

// 使用 Sender 与 Receiver
const sender = new Sender()
```

### 浏览器 (IIFE/UMD)

无需打包器即可直接在浏览器中使用：

```html
<script src="node_modules/zmodem2/dist/browser/zmodem2.min.js"></script>
<script>
  // 全局变量：Zmodem2
  const sender = new Zmodem2.Sender()
  const receiver = new Zmodem2.Receiver()
</script>
```

或通过 CDN：

```html
<script src="https://unpkg.com/zmodem2/dist/browser/zmodem2.min.js"></script>
```

## API 概览

### 核心类

#### `Sender`

用于通过 ZMODEM 协议发送文件。

```javascript
const sender = new Sender()

// 获取要发送到对端的字节
const outgoingBytes = sender.drainOutgoing()

// 写入字节后推进发送状态
sender.advanceOutgoing()

// 向 Sender 提供从远端接收的字节
sender.feedIncoming(bytes)

// 发起发送文件请求
const fileRequest = sender.pollFile()
if (fileRequest) {
  sender.feedFile(fileData)
}

// 检查事件
const event = sender.pollEvent()
```

#### `Receiver`

用于通过 ZMODEM 协议接收文件。

```javascript
const receiver = new Receiver()

// 获取要发送到对端的字节
const outgoingBytes = receiver.drainOutgoing()

// 写入字节后推进接收状态
receiver.advanceOutgoing()

// 向 Receiver 提供从远端接收的字节
receiver.feedIncoming(bytes)

// 获取接收到的文件字节
const fileBytes = receiver.drainFile()
if (fileBytes) {
  // 写入存储
  receiver.advanceFile()
}

// 检查事件
const event = receiver.pollEvent()
```

### 事件

`Sender` 与 `Receiver` 通过 `pollEvent()` 发出事件：

```typescript
enum SenderEvent {
  Ready = 'ready',
  FileRequest = 'fileRequest',
  Sent = 'sent',
  Error = 'error',
  Complete = 'complete'
}

enum ReceiverEvent {
  Ready = 'ready',
  FileStart = 'fileStart',
  FileData = 'fileData',
  FileEnd = 'fileEnd',
  Error = 'error',
  Complete = 'complete'
}
```

### 错误处理

```javascript
import { ZmodemError, NotConnectedError, ReadError, WriteError } from 'zmodem2'

try {
  // ZMODEM 操作
} catch (error) {
  if (error instanceof ZmodemError) {
    console.error('ZMODEM 错误：', error.message)
  }
}
```

### 常量与工具函数

```javascript
import {
  // 常量
  ZPAD, ZDLE, XON,
  SUBPACKET_MAX_SIZE, SUBPACKET_PER_ACK,
  
  // CRC 工具
  crc16Xmodem, crc32IsoHdlc,
  Crc16, Crc32,
  
  // ZDLE 编码表
  ZDLE_TABLE, UNZDLE_TABLE,
  escapeByte, unescapeByte,
  
  // 头部类型
  Encoding, Frame,
  Zrinit, Header,
  decodeHeader, createZrinit
} from 'zmodem2'
```

## TypeScript 支持

本包包含 TypeScript 类型声明文件，无需额外的 `@types/` 包。

```typescript
import {
  Sender,
  Receiver,
  SenderEvent,
  ReceiverEvent,
  FileRequest,
  ZmodemError
} from 'zmodem2'

const sender: Sender = new Sender()
const event: SenderEvent | null = sender.pollEvent()
```

## 从源码构建

```bash
# 克隆仓库
git clone https://github.com/zxdong262/zmodem2-js.git
cd zmodem2-js

# 安装依赖
npm install

# 构建所有格式
npm run build

# 构建指定格式
npm run build:esm    # 仅 ESM
npm run build:cjs    # 仅 CommonJS
npm run build:types  # 仅声明文件
```

### 构建输出结构

```
dist/
  esm/           # ES 模块（支持摇树优化）
    index.js
    index.d.ts
    ...
  cjs/           # CommonJS 模块
    index.cjs
    index.d.ts
    ...
  cjs-full/      # 打包后的 CommonJS
    index.cjs
    index.d.ts
  browser/       # 浏览器包
    zmodem2.js
    zmodem2.min.js
    index.d.ts
```

## 测试

```bash
# 运行单元测试
npm test

# 运行集成测试
npm run test:upload
npm run test:download

# 监听模式
npm run test:watch
```

## 许可证

MIT 许可证 - 详细信息见 [LICENSE](LICENSE)。

## 相关项目

- [zmodem2-wasm](https://www.npmjs.com/package/zmodem2-wasm) - 使用 WebAssembly 提供高性能 CRC 计算的实现
- [electerm](https://github.com/electerm/electerm) - 支持 ZMODEM 的终端应用，使用本库进行 ZMODEM 文件传输
