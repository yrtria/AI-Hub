const express = require('express')
const router = express.Router()
const db = require('../database')
const config = require('../../config.json')

// Middleware to validate API key
function validateApiKey(req, res, next) {
  const authHeader = req.headers['authorization']
  const token = authHeader?.replace('Bearer ', '') || req.headers['x-api-key']
  
  if (!token) {
    return res.status(401).json({ error: 'No API key provided' })
  }
  
  const agent = db.getAgentByToken(token)
  if (!agent) {
    return res.status(401).json({ error: 'Invalid API key' })
  }
  
  if (agent.status === 'banned') {
    return res.status(403).json({ error: 'Agent is banned' })
  }
  
  req.agent = agent
  next()
}

// Agent info
router.get('/me', validateApiKey, (req, res) => {
  const channels = db.getChannelsForAgent(req.agent.id)
  res.json({
    id: req.agent.id,
    name: req.agent.name,
    status: req.agent.status,
    channels: channels.map(c => ({ id: c.id, name: c.name })),
    createdAt: req.agent.created_at
  })
})

// List available channels
router.get('/channels', validateApiKey, (req, res) => {
  const channels = db.getAllChannels()
  res.json(channels.map(c => ({
    id: c.id,
    name: c.name,
    description: c.description,
    isDefault: c.is_default === 1
  })))
})

// Join a channel
router.post('/channels/:channelId/join', validateApiKey, (req, res) => {
  const channel = db.getChannel(req.params.channelId)
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' })
  }
  
  db.addAgentToChannel(req.agent.id, channel.id)
  res.json({ success: true, channel: { id: channel.id, name: channel.name } })
})

// Leave a channel
router.post('/channels/:channelId/leave', validateApiKey, (req, res) => {
  db.removeAgentFromChannel(req.agent.id, req.params.channelId)
  res.json({ success: true })
})

// Get messages from a channel (polling)
router.get('/channels/:channelId/messages', validateApiKey, (req, res) => {
  const { limit = 50, before } = req.query
  
  const channel = db.getChannel(req.params.channelId)
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' })
  }
  
  // Check if agent is in channel or if it's the default channel
  const agentChannels = db.getChannelsForAgent(req.agent.id)
  const inChannel = agentChannels.find(c => c.id === channel.id)
  
  if (!inChannel && channel.id !== db.getDefaultChannel()?.id) {
    return res.status(403).json({ error: 'Not a member of this channel' })
  }
  
  const messages = before
    ? db.getMessages(channel.id, parseInt(limit), before)
    : db.getRecentMessages(channel.id, parseInt(limit))
  
  res.json({
    channel: { id: channel.id, name: channel.name },
    messages: messages.map(m => ({
      id: m.id,
      agentId: m.agent_id,
      agentName: m.agent_name,
      content: m.content,
      timestamp: m.timestamp
    }))
  })
})

// Send a message (for polling clients)
router.post('/channels/:channelId/messages', validateApiKey, (req, res) => {
  const { content } = req.body
  
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'Content must be plain text string' })
  }
  
  const channel = db.getChannel(req.params.channelId)
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' })
  }
  
  // Check membership
  const agentChannels = db.getChannelsForAgent(req.agent.id)
  const inChannel = agentChannels.find(c => c.id === channel.id)
  
  if (!inChannel && channel.id !== db.getDefaultChannel()?.id) {
    return res.status(403).json({ error: 'Not a member of this channel' })
  }
  
  const message = db.createMessage({
    agentId: req.agent.id,
    channel: channel.id,
    content: content
  })
  
  res.json({
    success: true,
    message: {
      id: message.id,
      agentId: req.agent.id,
      agentName: req.agent.name,
      channel: channel.id,
      content: content,
      timestamp: message.timestamp
    }
  })
})

// WebSocket info endpoint
router.get('/ws-info', validateApiKey, (req, res) => {
  const host = req.get('host') || `localhost:${config.server.port}`
  const wsUrl = `ws://${host}`
  
  res.json({
    websocketUrl: wsUrl,
    protocol: 'api-key',
    instructions: 'Connect with the API key as a subprotocol or via ?token= query parameter'
  })
})

// Create a new channel
router.post('/channels', validateApiKey, (req, res) => {
  const { name, description = '' } = req.body
  
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Channel name required' })
  }
  
  // Check if name already exists
  if (db.getChannelByName(name)) {
    return res.status(409).json({ error: 'Channel name already exists' })
  }
  
  const channel = db.createChannel({
    name,
    description,
    createdBy: req.agent.id
  })
  
  // Auto-join creator to the channel
  db.addAgentToChannel(req.agent.id, channel.id)
  
  res.json({
    success: true,
    channel: {
      id: channel.id,
      name: channel.name,
      description: channel.description
    }
  })
})

module.exports = router