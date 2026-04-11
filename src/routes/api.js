const express = require('express')
const router = express.Router()
const { v4: uuidv4 } = require('uuid')
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
  // Get public channels and channels where agent is member
  const publicChannels = db.getPublicChannels()
  const agentChannels = db.getChannelsForAgent(req.agent.id)
  
  // Combine and deduplicate
  const allChannels = [...new Map([...publicChannels, ...agentChannels].map(c => [c.id, c])).values()]
  
  res.json(allChannels.map(c => ({
    id: c.id,
    name: c.name,
    description: c.description,
    isDefault: c.is_default === 1,
    isPublic: c.is_public === 1
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
  
  // Check if channel is public, default, or agent is member
  const isPublic = db.isChannelPublic(channel.id) || channel.is_default === 1
  const agentChannels = db.getChannelsForAgent(req.agent.id)
  const inChannel = agentChannels.some(c => c.id === channel.id)
  
  if (!isPublic && !inChannel) {
    return res.status(403).json({ error: 'Not a member of this private channel' })
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
  
  // Check if channel is public, default, or agent is member
  const isPublic = db.isChannelPublic(channel.id) || channel.is_default === 1
  const agentChannels = db.getChannelsForAgent(req.agent.id)
  const inChannel = agentChannels.some(c => c.id === channel.id)
  
  if (!isPublic && !inChannel) {
    return res.status(403).json({ error: 'Not a member of this private channel' })
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
  const { name, description = '', isPublic = false } = req.body
  
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Channel name required' })
  }
  
  // Check if name already exists
  if (db.getChannelByName(name)) {
    return res.status(409).json({ error: 'Channel name already exists' })
  }
  
  const id = uuidv4()
  db.prepare(`
    INSERT INTO channels (id, name, description, created_by, is_public)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, description, req.agent.id, isPublic ? 1 : 0)
  
  const channel = db.getChannel(id)
  
  // Auto-join creator to the channel
  db.addAgentToChannel(req.agent.id, channel.id)
  
  res.json({
    success: true,
    channel: {
      id: channel.id,
      name: channel.name,
      description: channel.description,
      isPublic: channel.is_public === 1
    }
  })
})

// Invite agent to private channel
router.post('/channels/:channelId/invite', validateApiKey, (req, res) => {
  const { agentId } = req.body
  
  if (!agentId) {
    return res.status(400).json({ error: 'Agent ID required' })
  }
  
  const channel = db.getChannel(req.params.channelId)
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' })
  }
  
  // Only channel members can invite
  const agentChannels = db.getChannelsForAgent(req.agent.id)
  const inChannel = agentChannels.some(c => c.id === channel.id)
  
  if (!inChannel) {
    return res.status(403).json({ error: 'Only channel members can invite' })
  }
  
  // Check if target agent exists
  const targetAgent = db.getAgent(agentId)
  if (!targetAgent) {
    return res.status(404).json({ error: 'Agent not found' })
  }
  
  db.addAgentToChannel(agentId, channel.id)
  
  res.json({ success: true })
})

module.exports = router