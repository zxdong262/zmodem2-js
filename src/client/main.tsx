import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.js'

// Server URL for logging (different port from dev server)
const LOG_SERVER_URL = 'ws://localhost:8081'

// Log batching to prevent flooding
class LogSender {
  private ws: WebSocket | null = null
  private readonly queue: Array<{ level: string, message: string }> = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private readonly FLUSH_INTERVAL = 100 // ms
  private readonly MAX_QUEUE_SIZE = 50
  private connecting = false

  constructor () {
    this.connect()
  }

  private connect (): void {
    if (this.connecting || ((this.ws != null) && this.ws.readyState === WebSocket.OPEN)) {
      return
    }
    this.connecting = true
    try {
      this.ws = new WebSocket(LOG_SERVER_URL + '/log-ws')
      this.ws.onopen = () => {
        this.connecting = false
        this.flush()
      }
      this.ws.onclose = () => {
        this.connecting = false
        this.ws = null
        // Reconnect after a delay
        setTimeout(() => this.connect(), 1000)
      }
      this.ws.onerror = () => {
        this.connecting = false
      }
    } catch {
      this.connecting = false
    }
  }

  enqueue (level: string, message: string): void {
    this.queue.push({ level, message })

    // Flush if queue is getting too large
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      this.flush()
    } else if (this.flushTimer == null) {
      // Schedule a flush
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        this.flush()
      }, this.FLUSH_INTERVAL)
    }
  }

  private flush (): void {
    if (this.queue.length === 0) return
    if ((this.ws == null) || this.ws.readyState !== WebSocket.OPEN) {
      this.connect()
      return
    }

    try {
      // Send all queued logs as a single batch
      const batch = this.queue.splice(0, this.queue.length)
      this.ws.send(JSON.stringify({ type: 'log-batch', logs: batch }))
    } catch {
      // Ignore errors
    }
  }
}

const logSender = new LogSender()

// Override console methods to send logs to server
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
  debug: console.debug
}

function sendLogToServer (level: string, ...args: any[]): void {
  try {
    const message = args.map(a => {
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      }
      return String(a)
    }).join(' ')

    logSender.enqueue(level, message)
  } catch {
    // Ignore all errors
  }
}

// Override console methods
console.log = (...args) => {
  originalConsole.log(...args)
  sendLogToServer('INFO', ...args)
}

console.error = (...args) => {
  originalConsole.error(...args)
  sendLogToServer('ERROR', ...args)
}

console.warn = (...args) => {
  originalConsole.warn(...args)
  sendLogToServer('WARN', ...args)
}

console.info = (...args) => {
  originalConsole.info(...args)
  sendLogToServer('INFO', ...args)
}

console.debug = (...args) => {
  originalConsole.debug(...args)
  sendLogToServer('DEBUG', ...args)
}

// Log uncaught errors
window.addEventListener('error', (event) => {
  sendLogToServer('ERROR', `Uncaught error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`)
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  sendLogToServer('ERROR', `Unhandled promise rejection: ${String(reason)}`)
})

console.log('Web client starting...')

const rootElement = document.getElementById('root')
if (rootElement !== null) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(<App />)
}
