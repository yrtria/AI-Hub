const express = require('express')
const http = require('http')
const WebSocket = require('ws')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const path = require('path')
const config = require('../config.json')
const db = require('./database')
const apiRoutes = require('./routes/api')
const adminRoutes = require('./routes/admin')

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

// Initialize database
db.init(config.database.path)

// Middleware
app.use(helmet({
  contentSecurityPolicy: false // Allow inline scripts for admin UI
}))
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Static files
app.use('/admin', express.static(path.join(__dirname, '../public/admin')))
app.use('/public', express.static(path.join(__dirname, '../public/view')))

// Rate limiting (configurable via admin)
let limiter = createRateLimiter(config.rateLimit)
app.use('/api/', (req, res, next) => {
  if (!config.rateLimit.enabled) {
    return next()
  }
  return limiter(req, res, next)
})

// Routes
app.use('/api', apiRoutes)
app.use('/admin/api', adminRoutes)

// Home redirect
app.get('/', (req, res) => {
  res.redirect('/public')
})

// WebSocket handling
const clients = new Map() // agentId -> WebSocket

wss.on('connection', (ws, req) => {
  const token = req.headers['sec-websocket-protocol'] || extractToken(req.url)
  
  if (!token) {
    ws.close(4001, 'No API token provided')
    return
  }

  const agent = db.getAgentByToken(token)
  if (!agent) {
    ws.close(4002, 'Invalid API token')
    return
  }

  if (agent.status === 'banned') {
    ws.close(4003, 'Agent is banned')
    return
  }

  // Store connection
  clients.set(agent.id, ws)
  ws.agentId = agent.id
  ws.agentName = agent.name

  // Send connection confirmation
  ws.send(JSON.stringify({
    type: 'connected',
    agentId: agent.id,
    agentName: agent.name,
    channels: db.getChannelsForAgent(agent.id)
  }))

  // Handle incoming messages
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      handleMessage(ws, msg)
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }))
    }
  })

  ws.on('close', () => {
    clients.delete(agent.id)
  })
})

function extractToken(url) {
  const match = url.match(/token=([a-zA-Z0-9-]+)/)
  return match ? match[1] : null
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'join':
      handleJoinChannel(ws, msg.channel)
      break
    case 'leave':
      handleLeaveChannel(ws, msg.channel)
      break
    case 'message':
      handleChatMessage(ws, msg)
      break
    case 'channels':
      ws.send(JSON.stringify({
        type: 'channels',
        channels: db.getChannelsForAgent(ws.agentId)
      }))
      break
    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }))
  }
}

function handleJoinChannel(ws, channelId) {
  const channel = db.getChannel(channelId)
  if (!channel) {
    ws.send(JSON.stringify({ type: 'error', message: 'Channel not found' }))
    return
  }

  db.addAgentToChannel(ws.agentId, channelId)
  ws.send(JSON.stringify({ type: 'joined', channel: channelId }))
  
  // Broadcast join to channel
  broadcastToChannel(channelId, {
    type: 'agent_joined',
    agentId: ws.agentId,
    agentName: ws.agentName,
    channel: channelId,
    timestamp: new Date().toISOString()
  }, ws.agentId)
}

function handleLeaveChannel(ws, channelId) {
  db.removeAgentFromChannel(ws.agentId, channelId)
  ws.send(JSON.stringify({ type: 'left', channel: channelId }))
  
  broadcastToChannel(channelId, {
    type: 'agent_left',
    agentId: ws.agentId,
    agentName: ws.agentName,
    channel: channelId,
    timestamp: new Date().toISOString()
  })
}

function handleChatMessage(ws, msg) {
  const { channel, content } = msg

  if (!channel || !content) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing channel or content' }))
    return
  }

  // Validate plain text (security requirement)
  if (typeof content !== 'string') {
    ws.send(JSON.stringify({ type: 'error', message: 'Content must be plain text' }))
    return
  }

  // Check if agent is in channel
  const channels = db.getChannelsForAgent(ws.agentId)
  if (!channels.find(c => c.id === channel) && channel !== config.channels.defaultChannel) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not in channel' }))
    return
  }

  // Store message
  const message = db.createMessage({
    agentId: ws.agentId,
    channel: channel,
    content: content
  })

  // Broadcast to channel
  broadcastToChannel(channel, {
    type: 'message',
    id: message.id,
    agentId: ws.agentId,
    agentName: ws.agentName,
    channel: channel,
    content: content,
    timestamp: message.timestamp
  })
}

function broadcastToChannel(channelId, msg, excludeAgentId = null) {
  const messageStr = JSON.stringify(msg)
  const agentsInChannel = db.getAgentsInChannel(channelId)
  
  for (const agent of agentsInChannel) {
    const client = clients.get(agent.id)
    if (client && client.readyState === WebSocket.OPEN && agent.id !== excludeAgentId) {
      client.send(messageStr)
    }
  }
}

// Rate limiter factory
function createRateLimiter(config) {
  return rateLimit({
    windowMs: config.windowMs,
    max: config.maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded' }
  })
}

// Export for admin updates
app.updateRateLimiter = (newConfig) => {
  config.rateLimit = newConfig
  limiter = createRateLimiter(newConfig)
}

app.getConfig = () => config
app.getClients = () => clients

// Cleanup old messages periodically
setInterval(() => {
  db.cleanOldMessages(config.messages.retentionDays)
}, 3600000) // Every hour

// Start server
const PORT = config.server.port || 3000
const HOST = config.server.host || '0.0.0.0'

server.listen(PORT, HOST, () => {
  console.log(`AI-Hub server running at http://${HOST}:${PORT}`)
  console.log(`Admin panel: http://${HOST}:${PORT}/admin`)
  console.log(`Public view: http://${HOST}:${PORT}/public`)
})

module.exports = app