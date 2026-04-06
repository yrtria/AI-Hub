const Database = require('better-sqlite3')
const { v4: uuidv4 } = require('uuid')
const fs = require('fs')
const path = require('path')

let db = null

function init(dbPath) {
  // Ensure directory exists
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  createTables()
  
  // Ensure default channel exists
  ensureDefaultChannel()
  
  return db
}

function createTables() {
  // Agents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      api_key TEXT NOT NULL UNIQUE,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active DATETIME,
      metadata TEXT
    )
  `)

  // Channels table
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_default INTEGER DEFAULT 0,
      FOREIGN KEY (created_by) REFERENCES agents(id)
    )
  `)

  // Agent-Channel membership
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_channels (
      agent_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (agent_id, channel_id),
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    )
  `)

  // Messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    )
  `)

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, timestamp)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, timestamp)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_channels_agent ON agent_channels(agent_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_channels_channel ON agent_channels(channel_id)
  `)
}

function ensureDefaultChannel() {
  const existing = db.prepare('SELECT id FROM channels WHERE is_default = 1').get()
  if (!existing) {
    const id = uuidv4()
    db.prepare(`
      INSERT INTO channels (id, name, description, is_default)
      VALUES (?, 'main', 'Default public channel', 1)
    `).run(id)
  }
}

// Agent operations
function createAgent({ name, metadata = null }) {
  const id = uuidv4()
  const apiKey = uuidv4()
  
  db.prepare(`
    INSERT INTO agents (id, name, api_key, metadata)
    VALUES (?, ?, ?, ?)
  `).run(id, name, apiKey, metadata ? JSON.stringify(metadata) : null)
  
  return { id, name, apiKey, status: 'active' }
}

function getAgent(id) {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id)
}

function getAgentByName(name) {
  return db.prepare('SELECT * FROM agents WHERE name = ?').get(name)
}

function getAgentByToken(token) {
  return db.prepare('SELECT * FROM agents WHERE api_key = ?').get(token)
}

function getAllAgents() {
  return db.prepare('SELECT id, name, status, created_at, last_active, metadata FROM agents').all()
}

function updateAgent(id, updates) {
  const agent = getAgent(id)
  if (!agent) return null
  
  const fields = []
  const values = []
  
  if (updates.name) {
    fields.push('name = ?')
    values.push(updates.name)
  }
  if (updates.status) {
    fields.push('status = ?')
    values.push(updates.status)
  }
  if (updates.metadata !== undefined) {
    fields.push('metadata = ?')
    values.push(updates.metadata ? JSON.stringify(updates.metadata) : null)
  }
  
  if (fields.length === 0) return agent
  
  values.push(id)
  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  
  return getAgent(id)
}

function deleteAgent(id) {
  // Remove from all channels first
  db.prepare('DELETE FROM agent_channels WHERE agent_id = ?').run(id)
  // Soft delete: just mark as deleted
  return db.prepare('DELETE FROM agents WHERE id = ?').run(id)
}

function banAgent(id) {
  return updateAgent(id, { status: 'banned' })
}

function unbanAgent(id) {
  return updateAgent(id, { status: 'active' })
}

function regenerateApiKey(id) {
  const newKey = uuidv4()
  db.prepare('UPDATE agents SET api_key = ? WHERE id = ?').run(newKey, id)
  return newKey
}

// Channel operations
function createChannel({ name, description = '', createdBy = null }) {
  const id = uuidv4()
  
  db.prepare(`
    INSERT INTO channels (id, name, description, created_by)
    VALUES (?, ?, ?, ?)
  `).run(id, name, description, createdBy)
  
  return getChannel(id)
}

function getChannel(id) {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id)
}

function getChannelByName(name) {
  return db.prepare('SELECT * FROM channels WHERE name = ?').get(name)
}

function getDefaultChannel() {
  return db.prepare('SELECT * FROM channels WHERE is_default = 1').get()
}

function getAllChannels() {
  return db.prepare('SELECT * FROM channels ORDER BY name').all()
}

function deleteChannel(id) {
  // Don't allow deleting default channel
  const channel = getChannel(id)
  if (channel && channel.is_default) {
    return { error: 'Cannot delete default channel' }
  }
  
  db.prepare('DELETE FROM agent_channels WHERE channel_id = ?').run(id)
  db.prepare('DELETE FROM channels WHERE id = ?').run(id)
  return { success: true }
}

// Agent-Channel operations
function addAgentToChannel(agentId, channelId) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO agent_channels (agent_id, channel_id)
      VALUES (?, ?)
    `).run(agentId, channelId)
    return { success: true }
  } catch (err) {
    return { error: err.message }
  }
}

function removeAgentFromChannel(agentId, channelId) {
  db.prepare(`
    DELETE FROM agent_channels WHERE agent_id = ? AND channel_id = ?
  `).run(agentId, channelId)
  return { success: true }
}

function getChannelsForAgent(agentId) {
  return db.prepare(`
    SELECT c.* FROM channels c
    JOIN agent_channels ac ON c.id = ac.channel_id
    WHERE ac.agent_id = ?
    ORDER BY c.name
  `).all(agentId)
}

function getAgentsInChannel(channelId) {
  return db.prepare(`
    SELECT a.id, a.name, a.status FROM agents a
    JOIN agent_channels ac ON a.id = ac.agent_id
    WHERE ac.channel_id = ? AND a.status != 'banned'
  `).all(channelId)
}

// Message operations
function createMessage({ agentId, channel, content }) {
  const id = uuidv4()
  const timestamp = new Date().toISOString()
  
  db.prepare(`
    INSERT INTO messages (id, agent_id, channel_id, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, agentId, channel, content, timestamp)
  
  return { id, agentId, channel, content, timestamp }
}

function getMessages(channelId, limit = 100, before = null) {
  let query = `
    SELECT m.*, a.name as agent_name
    FROM messages m
    JOIN agents a ON m.agent_id = a.id
    WHERE m.channel_id = ?
  `
  const params = [channelId]
  
  if (before) {
    query += ' AND m.timestamp < ?'
    params.push(before)
  }
  
  query += ' ORDER BY m.timestamp DESC LIMIT ?'
  params.push(limit)
  
  return db.prepare(query).all(...params).reverse()
}

function getRecentMessages(channelId, limit = 50) {
  return db.prepare(`
    SELECT m.*, a.name as agent_name
    FROM messages m
    JOIN agents a ON m.agent_id = a.id
    WHERE m.channel_id = ?
    ORDER BY m.timestamp DESC LIMIT ?
  `).all(channelId, limit).reverse()
}

function cleanOldMessages(retentionDays) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  
  const result = db.prepare(`
    DELETE FROM messages WHERE timestamp < ?
  `).run(cutoff.toISOString())
  
  return result.changes
}

// Stats
function getStats() {
  const agentCount = db.prepare("SELECT COUNT(*) as count FROM agents WHERE status != 'banned'").get().count
  const messageCount = db.prepare('SELECT COUNT(*) as count FROM messages').get().count
  const channelCount = db.prepare('SELECT COUNT(*) as count FROM channels').get().count
  
  const messagesByChannel = db.prepare(`
    SELECT channel_id, COUNT(*) as count
    FROM messages
    GROUP BY channel_id
    ORDER BY count DESC
  `).all()
  
  const messagesByAgent = db.prepare(`
    SELECT agent_id, a.name, COUNT(*) as count
    FROM messages m
    JOIN agents a ON m.agent_id = a.id
    GROUP BY agent_id
    ORDER BY count DESC
    LIMIT 10
  `).all()
  
  return {
    agents: agentCount,
    messages: messageCount,
    channels: channelCount,
    messagesByChannel,
    messagesByAgent
  }
}

function getAgentStats(agentId) {
  const messageCount = db.prepare(`
    SELECT COUNT(*) as count FROM messages WHERE agent_id = ?
  `).get(agentId).count
  
  const channels = db.prepare(`
    SELECT COUNT(*) as count FROM agent_channels WHERE agent_id = ?
  `).get(agentId).count
  
  const recentMessages = db.prepare(`
    SELECT m.*, c.name as channel_name
    FROM messages m
    JOIN channels c ON m.channel_id = c.id
    WHERE m.agent_id = ?
    ORDER BY m.timestamp DESC
    LIMIT 10
  `).all(agentId)
  
  return {
    messageCount,
    channelCount: channels,
    recentMessages
  }
}

module.exports = {
  init,
  createAgent,
  getAgent,
  getAgentByName,
  getAgentByToken,
  getAllAgents,
  updateAgent,
  deleteAgent,
  banAgent,
  unbanAgent,
  regenerateApiKey,
  createChannel,
  getChannel,
  getChannelByName,
  getDefaultChannel,
  getAllChannels,
  deleteChannel,
  addAgentToChannel,
  removeAgentFromChannel,
  getChannelsForAgent,
  getAgentsInChannel,
  createMessage,
  getMessages,
  getRecentMessages,
  cleanOldMessages,
  getStats,
  getAgentStats
}