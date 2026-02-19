import express from 'express'
import expressWs from 'express-ws'
import { Client } from 'ssh2'
import fs from 'fs'
import path from 'path'
import cors from 'cors'

const app = express()
expressWs(app)

// Enable CORS for all routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}))

// Middleware to parse JSON bodies
app.use(express.json())

const SSH_HOST = 'localhost'
const SSH_PORT = 23355
const SSH_USER = 'zxd'
const SSH_PASS = 'zxd'

// Log file setup
const LOG_DIR = 'temp'
const SERVER_LOG_FILE = path.join(LOG_DIR, 'server.log')
const WEB_LOG_FILE = path.join(LOG_DIR, 'web.log')

// Ensure temp directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

// Clear log files on startup
fs.writeFileSync(SERVER_LOG_FILE, `=== Server started at ${new Date().toISOString()} ===\n`)
fs.writeFileSync(WEB_LOG_FILE, `=== Server started at ${new Date().toISOString()} ===\n`)

// Log to server log file
function logToServer (message, level = 'INFO') {
  const timestamp = new Date().toISOString()
  const logLine = `[${timestamp}] [${level}] ${message}\n`
  fs.appendFileSync(SERVER_LOG_FILE, logLine)
  console.log(`[SERVER] [${level}] ${message}`)
}

// Log to web log file (for client logs)
function logToWeb (message, level = 'INFO') {
  const timestamp = new Date().toISOString()
  const logLine = `[${timestamp}] [${level}] ${message}\n`
  fs.appendFileSync(WEB_LOG_FILE, logLine)
}

// WebSocket endpoint for web client logs (batched)
app.ws('/log-ws', (ws, req) => {
  logToServer('Log WebSocket connected')

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString())

      if (parsed.type === 'log-batch' && Array.isArray(parsed.logs)) {
        // Process batch of logs
        for (const log of parsed.logs) {
          if (log.message) {
            logToWeb(log.message, log.level || 'INFO')
          }
        }
      } else if (parsed.type === 'log') {
        // Single log message
        const level = parsed.level || 'INFO'
        if (parsed.message) {
          logToWeb(parsed.message, level)
        }
      }
    } catch (err) {
      logToServer(`Log WebSocket parse error: ${err.message}`, 'ERROR')
    }
  })

  ws.on('close', () => {
    logToServer('Log WebSocket disconnected')
  })

  ws.on('error', (err) => {
    logToServer(`Log WebSocket error: ${err.message}`, 'ERROR')
  })
})

// HTTP API endpoint for web client logs (fallback)
app.post('/log', (req, res) => {
  try {
    const { level = 'INFO', message } = req.body
    if (message) {
      logToWeb(message, level)
    }
    res.status(200).json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Test SSH connection on startup
logToServer('Testing SSH connection...')
const testSsh = new Client()
testSsh.on('ready', () => {
  logToServer('SSH test connection successful')
  testSsh.end()
})
testSsh.on('error', (err) => {
  logToServer(`SSH test connection failed: ${err.message}`, 'ERROR')
})
testSsh.connect({
  host: SSH_HOST,
  port: SSH_PORT,
  username: SSH_USER,
  password: SSH_PASS
})

app.ws('/terminal', (ws, req) => {
  const clientIp = req.connection.remoteAddress
  logToServer(`WebSocket connection established from: ${clientIp}`)

  const ssh = new Client()

  ssh.on('ready', () => {
    logToServer('SSH connection ready')
    ssh.shell({
      term: 'xterm-256color',
      cols: 80,
      rows: 24
    }, (err, stream) => {
      if (err) {
        logToServer(`SSH shell error: ${err.message}`, 'ERROR')
        ws.send(`SSH shell failed: ${err.message}`)
        ws.close(1011, 'SSH shell failed')
        ssh.end()
        return
      }

      logToServer('SSH shell opened')

      ws.on('message', (data) => {
        const msgStr = data.toString()
        try {
          const parsed = JSON.parse(msgStr)
          if (parsed.type === 'log') {
            // Log client messages to web log file
            const level = parsed.level || 'INFO'
            logToWeb(parsed.message, level)
            return
          }
        } catch {}
        // Send all other data as binary to SSH stream
        stream.write(data)
      })

      stream.on('data', (data) => {
        ws.send(data)
      })

      stream.on('close', () => {
        logToServer('SSH stream closed')
        ssh.end()
        ws.close()
      })

      stream.on('error', (err) => {
        logToServer(`SSH stream error: ${err.message}`, 'ERROR')
      })
    })
  })

  ssh.on('error', (err) => {
    logToServer(`SSH connection error: ${err.message}`, 'ERROR')
    ws.send(`SSH connection failed: ${err.message}`)
    ws.close(1011, 'SSH connection failed')
  })

  ssh.connect({
    host: SSH_HOST,
    port: SSH_PORT,
    username: SSH_USER,
    password: SSH_PASS
  })

  ws.on('close', () => {
    logToServer('WebSocket closed')
    ssh.end()
  })

  ws.on('error', (err) => {
    logToServer(`WebSocket error: ${err.message}`, 'ERROR')
  })
})

app.listen(8081, () => {
  logToServer('Server running on port 8081')
  logToServer(`Server log file: ${SERVER_LOG_FILE}`)
  logToServer(`Web log file: ${WEB_LOG_FILE}`)
})
