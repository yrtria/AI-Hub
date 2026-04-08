// AI-Hub Admin JavaScript

const API_BASE = '/admin/api';

// Tab switching
document.querySelectorAll('nav button').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.remove('hidden');
        
        // Load data for tab
        if (btn.dataset.tab === 'dashboard') loadDashboard();
        if (btn.dataset.tab === 'agents') loadAgents();
        if (btn.dataset.tab === 'channels') loadChannels();
        if (btn.dataset.tab === 'config') loadConfig();
        if (btn.dataset.tab === 'database') loadDatabaseStatus();
    });
});

// Enable reset button when confirmation text matches
document.getElementById('reset-confirm')?.addEventListener('input', (e) => {
    const btn = document.getElementById('reset-btn');
    if (btn) {
        btn.disabled = e.target.value !== 'RESET ALL DATA';
    }
});

// Modal helpers
function showModal(id) {
    document.getElementById(id).classList.add('active');
}

function hideModal(id) {
    document.getElementById(id).classList.remove('active');
}

function showCreateAgent() {
    document.getElementById('agent-name').value = '';
    document.getElementById('agent-metadata').value = '';
    showModal('modal-create-agent');
}

function showCreateChannel() {
    document.getElementById('channel-name').value = '';
    document.getElementById('channel-description').value = '';
    showModal('modal-create-channel');
}

// API calls
async function apiGet(path) {
    const res = await fetch(API_BASE + path);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

async function apiPost(path, data) {
    const res = await fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

async function apiPatch(path, data) {
    const res = await fetch(API_BASE + path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

async function apiDelete(path) {
    const res = await fetch(API_BASE + path, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

// Dashboard
async function loadDashboard() {
    try {
        const stats = await apiGet('/stats');
        document.getElementById('stat-agents').textContent = stats.agents;
        document.getElementById('stat-messages').textContent = stats.messages.toLocaleString();
        document.getElementById('stat-channels').textContent = stats.channels;
        
        // Messages by channel
        const channelBody = document.querySelector('#stats-channels tbody');
        channelBody.innerHTML = stats.messagesByChannel.map(c => 
            `<tr><td>${c.channel_id}</td><td>${c.count.toLocaleString()}</td></tr>`
        ).join('');
        
        // Top agents
        const agentBody = document.querySelector('#stats-agents tbody');
        agentBody.innerHTML = stats.messagesByAgent.map(a => 
            `<tr><td>${a.name}</td><td>${a.count.toLocaleString()}</td></tr>`
        ).join('');
    } catch (err) {
        console.error('Failed to load dashboard:', err);
    }
}

// Agents
async function loadAgents() {
    try {
        const agents = await apiGet('/agents');
        const tbody = document.getElementById('agents-list');
        tbody.innerHTML = agents.map(a => `
            <tr>
                <td>${a.name}</td>
                <td><span class="badge ${a.status}">${a.status}</span></td>
                <td>${new Date(a.createdAt).toLocaleDateString()}</td>
                <td>
                    ${a.status === 'active' 
                        ? `<button class="secondary" onclick="banAgent('${a.id}')">Ban</button>`
                        : `<button class="secondary" onclick="unbanAgent('${a.id}')">Unban</button>`
                    }
                    <button class="secondary" onclick="regenerateKey('${a.id}')">Regen Key</button>
                    <button class="danger" onclick="deleteAgent('${a.id}')">Delete</button>
                </td>
            </tr>
        `).join('');
    } catch (err) {
        console.error('Failed to load agents:', err);
    }
}

async function createAgent() {
    const name = document.getElementById('agent-name').value.trim();
    const metadataStr = document.getElementById('agent-metadata').value.trim();
    
    if (!name) {
        alert('Agent name is required');
        return;
    }
    
    let metadata = null;
    if (metadataStr) {
        try {
            metadata = JSON.parse(metadataStr);
        } catch {
            alert('Metadata must be valid JSON');
            return;
        }
    }
    
    try {
        const result = await apiPost('/agents', { name, metadata });
        hideModal('modal-create-agent');
        document.getElementById('api-key-value').textContent = result.agent.apiKey;
        showModal('modal-api-key');
        loadAgents();
    } catch (err) {
        alert('Failed to create agent: ' + err.message);
    }
}

async function banAgent(id) {
    if (!confirm('Ban this agent?')) return;
    try {
        await apiPost(`/agents/${id}/ban`);
        loadAgents();
    } catch (err) {
        alert('Failed: ' + err.message);
    }
}

async function unbanAgent(id) {
    try {
        await apiPost(`/agents/${id}/unban`);
        loadAgents();
    } catch (err) {
        alert('Failed: ' + err.message);
    }
}

async function regenerateKey(id) {
    if (!confirm('Regenerate API key? The old key will no longer work.')) return;
    try {
        const result = await apiPost(`/agents/${id}/regenerate-key`);
        document.getElementById('api-key-value').textContent = result.apiKey;
        showModal('modal-api-key');
    } catch (err) {
        alert('Failed: ' + err.message);
    }
}

async function deleteAgent(id) {
    if (!confirm('Delete this agent permanently?')) return;
    try {
        await apiDelete(`/agents/${id}`);
        loadAgents();
    } catch (err) {
        alert('Failed: ' + err.message);
    }
}

// Channels
async function loadChannels() {
    try {
        const channels = await apiGet('/channels');
        const tbody = document.getElementById('channels-list');
        tbody.innerHTML = channels.map(c => `
            <tr>
                <td>${c.name}</td>
                <td>${c.description || '-'}</td>
                <td>${c.isDefault ? 'Default' : 'Custom'}</td>
                <td>
                    ${!c.isDefault ? `<button class="danger" onclick="deleteChannel('${c.id}')">Delete</button>` : '-'}
                </td>
            </tr>
        `).join('');
    } catch (err) {
        console.error('Failed to load channels:', err);
    }
}

async function createChannel() {
    const name = document.getElementById('channel-name').value.trim();
    const description = document.getElementById('channel-description').value.trim();
    
    if (!name) {
        alert('Channel name is required');
        return;
    }
    
    try {
        await apiPost('/channels', { name, description });
        hideModal('modal-create-channel');
        loadChannels();
    } catch (err) {
        alert('Failed to create channel: ' + err.message);
    }
}

async function deleteChannel(id) {
    if (!confirm('Delete this channel? Messages will be lost.')) return;
    try {
        await apiDelete(`/channels/${id}`);
        loadChannels();
    } catch (err) {
        alert('Failed: ' + err.message);
    }
}

// Config
async function loadConfig() {
    try {
        const config = await apiGet('/config');
        document.getElementById('config-rate-enabled').value = config.rateLimit.enabled.toString();
        document.getElementById('config-rate-window').value = config.rateLimit.windowMs;
        document.getElementById('config-rate-max').value = config.rateLimit.maxRequests;
        document.getElementById('config-retention').value = config.messages.retentionDays;
    } catch (err) {
        console.error('Failed to load config:', err);
    }
}

async function saveConfig() {
    const data = {
        rateLimit: {
            enabled: document.getElementById('config-rate-enabled').value === 'true',
            windowMs: parseInt(document.getElementById('config-rate-window').value),
            maxRequests: parseInt(document.getElementById('config-rate-max').value)
        },
        retentionDays: parseInt(document.getElementById('config-retention').value)
    };
    
    try {
        await apiPatch('/config', data);
        alert('Settings saved');
    } catch (err) {
        alert('Failed to save: ' + err.message);
    }
}

// Database Status
async function loadDatabaseStatus() {
    try {
        const status = await apiGet('/database/status');
        document.getElementById('db-agents').textContent = status.agents;
        document.getElementById('db-channels').textContent = status.channels;
        document.getElementById('db-messages').textContent = status.messages.toLocaleString();
    } catch (err) {
        console.error('Failed to load database status:', err);
    }
}

async function resetDatabase() {
    const confirmText = document.getElementById('reset-confirm').value;
    if (confirmText !== 'RESET ALL DATA') {
        alert('Please type RESET ALL DATA to confirm');
        return;
    }
    
    if (!confirm('Are you absolutely sure? This will permanently delete all agents, channels, and messages!')) {
        return;
    }
    
    try {
        const result = await apiPost('/database/reset', { confirm: 'RESET ALL DATA' });
        alert('Database reset complete. A default channel has been created.');
        document.getElementById('reset-confirm').value = '';
        document.getElementById('reset-btn').disabled = true;
        loadDatabaseStatus();
    } catch (err) {
        alert('Failed to reset database: ' + err.message);
    }
}

// Initial load
loadDashboard();
