const express = require('express')
const router = express.Router()
const db = require('../database')
const fs = require('fs')
const path = require('path')

// Load/save config
const configPath = path.join(__dirname, '../../config.json')

function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

function saveConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

// Get all agents
router.get('/agents', (req, res) => {
  const agents = db.getAllAgents()
  res.json(agents.map(a => ({
    id: a.id,
    name: a.name,
    status: a.status,
    createdAt: a.created_at,
    lastActive: a.last_active,
    metadata: a.metadata ? JSON.parse(a.metadata) : null
  })))
})

// Create new agent
router.post('/agents', (req, res) => {
  const { name, metadata } = req.body
  
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Agent name is required' })
  }
  
  // Check for duplicate name
  if (db.getAgentByName(name)) {
    return res.status(409).json({ error: 'Agent name already exists' })
  }
  
  const agent = db.createAgent({ name, metadata })
  
  // Auto-join to default channel
  const defaultChannel = db.getDefaultChannel()
  if (defaultChannel) {
    db.addAgentToChannel(agent.id, defaultChannel.id)
  }
  
  res.json({
    success: true,
    agent: {
      id: agent.id,
      name: agent.name,
      apiKey: agent.apiKey, // Only shown once on creation
      status: agent.status
    }
  })
})

// Get single agent
router.get('/agents/:id', (req, res) => {
  const agent = db.getAgent(req.params.id)
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' })
  }
  
  const stats = db.getAgentStats(req.params.id)
  const channels = db.getChannelsForAgent(req.params.id)
  
  res.json({
    id: agent.id,
    name: agent.name,
    status: agent.status,
    createdAt: agent.created_at,
    lastActive: agent.last_active,
    metadata: agent.metadata ? JSON.parse(agent.metadata) : null,
    stats,
    channels: channels.map(c => ({ id: c.id, name: c.name }))
  })
})

// Update agent
router.patch('/agents/:id', (req, res) => {
  const { name, metadata } = req.body
  
  if (name && db.getAgentByName(name) && db.getAgentByName(name).id !== req.params.id) {
    return res.status(409).json({ error: 'Agent name already exists' })
  }
  
  const agent = db.updateAgent(req.params.id, { name, metadata })
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' })
  }
  
  res.json({
    success: true,
    agent: {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      metadata: agent.metadata ? JSON.parse(agent.metadata) : null
    }
  })
})

// Ban agent
router.post('/agents/:id/ban', (req, res) => {
  const agent = db.banAgent(req.params.id)
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' })
  }
  res.json({ success: true, agent: { id: agent.id, status: agent.status } })
})

// Unban agent
router.post('/agents/:id/unban', (req, res) => {
  const agent = db.unbanAgent(req.params.id)
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' })
  }
  res.json({ success: true, agent: { id: agent.id, status: agent.status } })
})

// Delete agent
router.delete('/agents/:id', (req, res) => {
  const result = db.deleteAgent(req.params.id)
  res.json({ success: true })
})

// Regenerate API key
router.post('/agents/:id/regenerate-key', (req, res) => {
  const agent = db.getAgent(req.params.id)
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' })
  }
  
  const newKey = db.regenerateApiKey(req.params.id)
  res.json({ success: true, apiKey: newKey })
})

// Get all channels
router.get('/channels', (req, res) => {
  const channels = db.getAllChannels()
  res.json(channels.map(c => ({
    id: c.id,
    name: c.name,
    description: c.description,
    isDefault: c.is_default === 1,
    createdAt: c.created_at,
    createdBy: c.created_by
  })))
})

// Create channel
router.post('/channels', (req, res) => {
  const { name, description = '' } = req.body
  
  if (!name) {
    return res.status(400).json({ error: 'Channel name is required' })
  }
  
  if (db.getChannelByName(name)) {
    return res.status(409).json({ error: 'Channel name already exists' })
  }
  
  const channel = db.createChannel({ name, description })
  res.json({ success: true, channel })
})

// Delete channel
router.delete('/channels/:id', (req, res) => {
  const result = db.deleteChannel(req.params.id)
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  res.json({ success: true })
})

// Get global stats
router.get('/stats', (req, res) => {
  const stats = db.getStats()
  res.json(stats)
})

// Get config
router.get('/config', (req, res) => {
  const config = loadConfig()
  res.json({
    server: config.server,
    rateLimit: config.rateLimit,
    messages: {
      retentionDays: config.messages.retentionDays,
      maxRetentionDays: config.messages.maxRetentionDays
    }
  })
})

// Update config
router.patch('/config', (req, res) => {
  const config = loadConfig()
  const { rateLimit, retentionDays } = req.body
  
  if (rateLimit) {
    if (typeof rateLimit.enabled === 'boolean') {
      config.rateLimit.enabled = rateLimit.enabled
    }
    if (typeof rateLimit.windowMs === 'number' && rateLimit.windowMs > 0) {
      config.rateLimit.windowMs = rateLimit.windowMs
    }
    if (typeof rateLimit.maxRequests === 'number' && rateLimit.maxRequests > 0) {
      config.rateLimit.maxRequests = rateLimit.maxRequests
    }
  }
  
  if (typeof retentionDays === 'number') {
    const maxDays = config.messages.maxRetentionDays || 30
    if (retentionDays < 1 || retentionDays > maxDays) {
      return res.status(400).json({ 
        error: `Retention days must be between 1 and ${maxDays}` 
      })
    }
    config.messages.retentionDays = retentionDays
    
    // Also update the running config
    const app = require('../index')
    if (app.getConfig) {
      app.getConfig().messages.retentionDays = retentionDays
    }
  }
  
  saveConfig(config)
  res.json({ success: true, config: { rateLimit: config.rateLimit, messages: config.messages } })
})

// Get channel messages (admin can see all)
router.get('/channels/:channelId/messages', (req, res) => {
  const { limit = 100, before } = req.query
  
  const channel = db.getChannel(req.params.channelId)
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' })
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

module.exports = router