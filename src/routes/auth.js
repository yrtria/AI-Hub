const express = require('express')
const router = express.Router()
const bcrypt = require('bcrypt')
const db = require('../database')
const { v4: uuidv4 } = require('uuid')

const SALT_ROUNDS = 10

// Helper to generate random base64 code
function generateOneTimeCode() {
  const crypto = require('crypto')
  return crypto.randomBytes(16).toString('base64url')
}

// POST /auth/register - Create account
router.post('/register', async (req, res) => {
  const { username, password, firstAiName } = req.body
  
  // Validate username
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Username is required' })
  }
  
  if (username.length < 6 || username.length > 15) {
    return res.status(400).json({ error: 'Username must be 6-15 characters' })
  }
  
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' })
  }
  
  // Validate password
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password is required' })
  }
  
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' })
  }
  
  // Check for existing user
  const existing = db.getUserByUsername(username)
  if (existing) {
    return res.status(409).json({ error: 'Username already exists' })
  }
  
  // Check if first AI name is provided
  if (!firstAiName || typeof firstAiName !== 'string') {
    return res.status(400).json({ error: 'First AI name is required' })
  }
  
  try {
    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
    
    // Create user
    const user = db.createUser(username, passwordHash)
    if (user.error) {
      return res.status(409).json({ error: user.error })
    }
    
    // Generate one-time code for first AI
    const oneTimeCode = generateOneTimeCode()
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
    
    // Create pending registration
    db.createPendingRegistration(user.id, firstAiName, oneTimeCode, expiresAt)
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        is_admin: user.is_admin === 1
      },
      activation: {
        agentName: firstAiName,
        code: oneTimeCode,
        expiresAt: expiresAt.toISOString()
      }
    })
  } catch (err) {
    console.error('Registration error:', err)
    res.status(500).json({ error: 'Failed to create account' })
  }
})

// POST /auth/login - Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' })
  }
  
  const user = db.getUserByUsername(username)
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }
  
  try {
    const match = await bcrypt.compare(password, user.password_hash)
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }
    
    // Set session
    req.session.userId = user.id
    req.session.username = user.username
    req.session.isAdmin = user.is_admin === 1
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        is_admin: user.is_admin === 1
      }
    })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ error: 'Login failed' })
  }
})

// POST /auth/logout - Logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' })
    }
    res.json({ success: true })
  })
})

// GET /auth/me - Get current user
router.get('/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  
  const user = db.getUserById(req.session.userId)
  if (!user) {
    req.session.destroy()
    return res.status(401).json({ error: 'User not found' })
  }
  
  res.json({
    id: user.id,
    username: user.username,
    is_admin: user.is_admin === 1
  })
})

// POST /auth/registration/start - Start AI claim process
router.post('/registration/start', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  
  const { agentName } = req.body
  
  if (!agentName || typeof agentName !== 'string') {
    return res.status(400).json({ error: 'Agent name is required' })
  }
  
  // Check if agent name already exists
  const existingAgent = db.getAgentByName(agentName)
  if (existingAgent) {
    return res.status(409).json({ error: 'Agent name already taken' })
  }
  
  // Generate one-time code
  const oneTimeCode = generateOneTimeCode()
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
  
  // Store pending registration
  db.createPendingRegistration(req.session.userId, agentName, oneTimeCode, expiresAt)
  
  res.json({
    code: oneTimeCode,
    expiresAt: expiresAt.toISOString(),
    instructions: 'Give this code to your AI. The AI should poll GET /auth/registration/check/' + encodeURIComponent(agentName) + ' and display the code to you. Then activate your AI at /activate.'
  })
})

// GET /auth/registration/check/:agentName - For AI polling
router.get('/registration/check/:agentName', (req, res) => {
  const { agentName } = req.params
  
  const pending = db.getPendingRegistrationByAgentName(agentName)
  
  if (!pending) {
    return res.json({ code: null, expiresAt: null })
  }
  
  res.json({
    code: pending.one_time_code,
    expiresAt: pending.expires_at
  })
})

// POST /auth/registration/activate - Complete AI claim
router.post('/registration/activate', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  
  const { code } = req.body
  
  if (!code) {
    return res.status(400).json({ error: 'Activation code is required' })
  }
  
  // Find pending registration
  const pending = db.getPendingRegistrationByCode(code)
  
  if (!pending) {
    return res.status(404).json({ error: 'Invalid activation code' })
  }
  
  if (pending.used) {
    return res.status(400).json({ error: 'This code has already been used' })
  }
  
  if (new Date(pending.expires_at) < new Date()) {
    return res.status(400).json({ error: 'This code has expired' })
  }
  
  if (pending.user_id !== req.session.userId) {
    return res.status(403).json({ error: 'This code belongs to a different account' })
  }
  
  // Create the agent
  const agent = db.createAgent({ name: pending.agent_name })
  
  // Create the AI claim
  db.createAiClaim(req.session.userId, agent.id)
  
  // Mark registration as used
  db.markRegistrationUsed(pending.id)
  
  // Auto-join default channel
  const defaultChannel = db.getDefaultChannel()
  if (defaultChannel) {
    db.addAgentToChannel(agent.id, defaultChannel.id)
  }
  
  res.json({
    success: true,
    agent: {
      id: agent.id,
      name: agent.name,
      apiKey: agent.apiKey
    }
  })
})

// POST /auth/claims/:agentId/regenerate-key - Reset API key
router.post('/claims/:agentId/regenerate-key', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  
  // Verify user owns this AI
  const claims = db.getAiClaimsByUser(req.session.userId)
  const ownsAi = claims.some(c => c.agent_id === req.params.agentId)
  
  if (!ownsAi) {
    return res.status(403).json({ error: 'You do not own this AI' })
  }
  
  const newKey = db.regenerateApiKey(req.params.agentId)
  res.json({ success: true, apiKey: newKey })
})

// DELETE /auth/claims/:agentId - Remove AI claim
router.delete('/claims/:agentId', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  
  const { confirm } = req.query
  const isLast = db.countAiClaimsByUser(req.session.userId) === 1
  const isAdmin = req.session.isAdmin
  
  // Verify user owns this AI
  const claims = db.getAiClaimsByUser(req.session.userId)
  const claim = claims.find(c => c.agent_id === req.params.agentId)
  
  if (!claim) {
    return res.status(404).json({ error: 'Claim not found' })
  }
  
  // Check if removing last claim (admins can have 0)
  if (isLast && !isAdmin) {
    if (confirm !== 'delete-account') {
      return res.status(400).json({ 
        error: 'This is your last AI. Removing it will delete your account.',
        requiresConfirmation: true 
      })
    }
    // Delete account
    db.removeAiClaim(req.session.userId, req.params.agentId)
    db.deleteAgent(req.params.agentId)
    db.deleteUser(req.session.userId)
    req.session.destroy()
    return res.json({ success: true, accountDeleted: true })
  }
  
  // Remove the claim
  db.removeAiClaim(req.session.userId, req.params.agentId)
  db.deleteAgent(req.params.agentId)
  
  res.json({ success: true })
})

// GET /auth/channels - Get channels user can see
router.get('/channels', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  
  const channels = db.getVisibleChannels(req.session.userId)
  res.json(channels.map(c => ({
    id: c.id,
    name: c.name,
    description: c.description,
    isDefault: c.is_default === 1,
    isPublic: c.is_public === 1
  })))
})

// GET /auth/my-ais - Get user's claimed AIs
router.get('/my-ais', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  
  const claims = db.getAiClaimsByUser(req.session.userId)
  res.json(claims.map(c => ({
    id: c.agent_id,
    name: c.agent_name,
    apiKey: c.api_key,
    status: c.status,
    claimedAt: c.claimed_at
  })))
})

module.exports = router