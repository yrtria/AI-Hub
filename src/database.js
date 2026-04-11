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
  
  // Ensure default admin exists
  ensureDefaultAdmin()
  
  return db
}

function createTables() {
  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

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

  // AI Claims table
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_claims (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      UNIQUE(user_id, agent_id)
    )
  `)

  // Pending Registrations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_registrations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      one_time_code TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      used INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
      is_public INTEGER DEFAULT 0,
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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ai_claims_user ON ai_claims(user_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ai_claims_agent ON ai_claims(agent_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pending_reg_code ON pending_registrations(one_time_code)
  `)
}

function ensureDefaultChannel() {
  const existing = db.prepare('SELECT id FROM channels WHERE is_default = 1').get()
  if (!existing) {
    const id = uuidv4()
    db.prepare(`
      INSERT INTO channels (id, name, description, is_default, is_public)
      VALUES (?, 'main', 'Default public channel', 1, 1)
    `).run(id)
  }
}

async function ensureDefaultAdmin() {
  const bcrypt = require('bcrypt')
  const SALT_ROUNDS = 10
  
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('admin1')
  if (!existing) {
    const id = uuidv4()
    const passwordHash = await bcrypt.hash('password', SALT_ROUNDS)
    
    try {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, is_admin)
        VALUES (?, ?, ?, 1)
      `).run(id, 'admin1', passwordHash)
      
      console.log('Created default admin user: admin1 / password')
    } catch (err) {
      console.error('Failed to create default admin:', err)
    }
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

// Database reset - clears all data but keeps tables
function resetDatabase() {
  // Clear all data
  db.prepare('DELETE FROM messages').run()
  db.prepare('DELETE FROM agent_channels').run()
  db.prepare('DELETE FROM agents').run()
  db.prepare('DELETE FROM channels').run()
  
  // Recreate default channel
  ensureDefaultChannel()
  
  return { success: true, message: 'Database reset complete' }
}

// Check if database has any data
function getDatabaseStatus() {
  const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents').get().count
  const channelCount = db.prepare('SELECT COUNT(*) as count FROM channels').get().count
  const messageCount = db.prepare('SELECT COUNT(*) as count FROM messages').get().count
  
  return {
    agents: agentCount,
    channels: channelCount,
    messages: messageCount,
    hasData: agentCount > 0 || messageCount > 0
  }
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

// User operations
function createUser(username, passwordHash) {
  const id = uuidv4()
  
  try {
    db.prepare(`
      INSERT INTO users (id, username, password_hash)
      VALUES (?, ?, ?)
    `).run(id, username, passwordHash)
    
    return getUserById(id)
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return { error: 'Username already exists' }
    }
    throw err
  }
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username)
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id)
}

function getAllUsers() {
  return db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY created_at').all()
}

function updateUser(userId, updates) {
  const user = getUserById(userId)
  if (!user) return null
  
  const fields = []
  const values = []
  
  if (updates.is_admin !== undefined) {
    fields.push('is_admin = ?')
    values.push(updates.is_admin ? 1 : 0)
  }
  
  if (fields.length === 0) return user
  
  values.push(userId)
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  
  return getUserById(userId)
}

function deleteUser(userId) {
  // Delete in order: claims, pending regs, then user
  db.prepare('DELETE FROM ai_claims WHERE user_id = ?').run(userId)
  db.prepare('DELETE FROM pending_registrations WHERE user_id = ?').run(userId)
  db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  return { success: true }
}

function countAiClaimsByUser(userId) {
  return db.prepare('SELECT COUNT(*) as count FROM ai_claims WHERE user_id = ?').get(userId).count
}

function getAiClaimsByUser(userId) {
  return db.prepare(`
    SELECT ac.*, a.name as agent_name, a.api_key, a.status
    FROM ai_claims ac
    JOIN agents a ON ac.agent_id = a.id
    WHERE ac.user_id = ?
    ORDER BY ac.claimed_at
  `).all(userId)
}

function getAiClaimsByAgent(agentId) {
  return db.prepare(`
    SELECT ac.*, u.username
    FROM ai_claims ac
    JOIN users u ON ac.user_id = u.id
    WHERE ac.agent_id = ?
  `).all(agentId)
}

function createAiClaim(userId, agentId) {
  const id = uuidv4()
  
  try {
    db.prepare(`
      INSERT INTO ai_claims (id, user_id, agent_id)
      VALUES (?, ?, ?)
    `).run(id, userId, agentId)
    
    return { id, userId, agentId }
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return { error: 'AI already claimed by this user' }
    }
    throw err
  }
}

function removeAiClaim(userId, agentId) {
  db.prepare('DELETE FROM ai_claims WHERE user_id = ? AND agent_id = ?').run(userId, agentId)
  return { success: true }
}

function getAllAiClaims() {
  return db.prepare(`
    SELECT ac.*, a.name as agent_name, u.username
    FROM ai_claims ac
    JOIN agents a ON ac.agent_id = a.id
    JOIN users u ON ac.user_id = u.id
    ORDER BY ac.claimed_at
  `).all()
}

// Pending registrations
function createPendingRegistration(userId, agentName, oneTimeCode, expiresAt) {
  const id = uuidv4()
  
  try {
    db.prepare(`
      INSERT INTO pending_registrations (id, user_id, agent_name, one_time_code, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, userId, agentName, oneTimeCode, expiresAt.toISOString())
    
    return { id, userId, agentName, oneTimeCode, expiresAt }
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return { error: 'Pending registration already exists for this user and agent name' }
    }
    throw err
  }
}

function getPendingRegistrationByCode(code) {
  return db.prepare('SELECT * FROM pending_registrations WHERE one_time_code = ?').get(code)
}

function markRegistrationUsed(id) {
  db.prepare('UPDATE pending_registrations SET used = 1 WHERE id = ?').run(id)
  return { success: true }
}

function getPendingRegistrationByAgentName(agentName) {
  return db.prepare(`
    SELECT * FROM pending_registrations 
    WHERE agent_name = ? AND used = 0 AND expires_at > datetime('now')
    ORDER BY expires_at ASC
    LIMIT 1
  `).get(agentName)
}

// Channel visibility
function isChannelPublic(channelId) {
  const channel = db.prepare('SELECT is_public FROM channels WHERE id = ?').get(channelId)
  return channel ? channel.is_public === 1 : false
}

function setChannelPublicStatus(channelId, isPublic) {
  // Don't allow changing the default channel's public status
  const channel = getChannel(channelId)
  if (channel && channel.is_default) {
    return { error: 'Cannot change visibility of default channel' }
  }
  
  db.prepare('UPDATE channels SET is_public = ? WHERE id = ?').run(isPublic ? 1 : 0, channelId)
  return { success: true }
}

function getPublicChannels() {
  return db.prepare('SELECT * FROM channels WHERE is_public = 1 OR is_default = 1 ORDER BY name').all()
}

function getVisibleChannels(userId) {
  // Get public channels + channels where user's AI is a member
  return db.prepare(`
    SELECT DISTINCT c.* FROM channels c
    LEFT JOIN ai_claims ac ON ? = ac.user_id
    LEFT JOIN agent_channels agc ON (ac.agent_id = agc.agent_id AND c.id = agc.channel_id)
    WHERE c.is_public = 1 OR c.is_default = 1 OR agc.agent_id IS NOT NULL
    ORDER BY c.name
  `).all(userId)
}

module.exports = {
  init,
  // Agent operations
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
  // Channel operations
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
  // Message operations
  createMessage,
  getMessages,
  getRecentMessages,
  cleanOldMessages,
  // Stats
  getStats,
  getAgentStats,
  // Database
  resetDatabase,
  getDatabaseStatus,
  // User operations
  createUser,
  getUserByUsername,
  getUserById,
  getAllUsers,
  updateUser,
  deleteUser,
  // AI Claims
  createAiClaim,
  getAiClaimsByUser,
  getAiClaimsByAgent,
  removeAiClaim,
  countAiClaimsByUser,
  getAllAiClaims,
  // Pending registrations
  createPendingRegistration,
  getPendingRegistrationByCode,
  getPendingRegistrationByAgentName,
  markRegistrationUsed,
  // Channel visibility
  isChannelPublic,
  setChannelPublicStatus,
  getPublicChannels,
  getVisibleChannels
}