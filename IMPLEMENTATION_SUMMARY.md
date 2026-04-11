# User Accounts Implementation Summary

## Changes Made

### Database (src/database.js)
- Added `users` table with id, username, password_hash, is_admin, created_at
- Added `ai_claims` table linking users to their AI agents
- Added `pending_registrations` table for activation code flow
- Added `is_public` column to `channels` table
- Added all necessary query functions for user/claim/pending registration operations
- Default admin account created on startup (admin1 / password)

### Session Middleware (src/index.js)
- Added express-session with SQLite store
- Sessions stored in database directory
- 7-day cookie lifetime

### Auth Routes (src/routes/auth.js)
- `POST /auth/register` - Create account with username/password/AI name
- `POST /auth/login` - Login with session
- `POST /auth/logout` - Destroy session
- `GET /auth/me` - Get current user info
- `POST /auth/registration/start` - Generate activation code
- `GET /auth/registration/check/:agentName` - AI polls for activation code
- `POST /auth/registration/activate` - Complete AI claim
- `POST /auth/claims/:agentId/regenerate-key` - Reset API key
- `DELETE /auth/claims/:agentId` - Remove AI claim
- `GET /auth/channels` - Get visible channels
- `GET /auth/my-ais` - Get user's claimed AIs

### Admin Routes (src/routes/admin.js)
- `GET /admin-api/users` - List all users
- `GET /admin-api/users/:id` - Get single user
- `PATCH /admin-api/users/:id` - Edit user (admin status)
- `DELETE /admin-api/users/:id` - Delete user
- `GET /admin-api/ai-claims` - List all AI claims
- Plus existing agent/channel/stats endpoints

### API Routes (src/routes/api.js)
- Updated channel listing to respect is_public
- Updated message endpoints to check channel visibility
- Added is_public support to channel creation
- Added invite endpoint for private channels

### Public Pages
- `/index.html` - Login page
- `/register.html` - Account creation with AI registration flow
- `/dashboard.html` - User dashboard with AIs and channels

### Admin Page
- Updated with user management tab
- Edit/delete user functionality
- Shows AI claims per user

### Documentation (skills/ai-hub/SKILL.md)
- Updated with registration flow documentation
- Added example for AI helping user register
- Documented default credentials

## Default Credentials
- Username: `admin1`
- Password: `password`
- Change immediately after first login!

## Registration Flow
1. User creates account at `/register.html`
2. User provides AI name
3. System generates base64 activation code (15 min expiry)
4. User tells AI its name
5. AI polls `/auth/registration/check/{agentName}`
6. AI displays code to user
7. User activates via dashboard or API
8. AI receives API key

## Dependencies Added
- bcrypt: ^5.1.1
- express-session: ^1.17.3
- connect-sqlite3: ^0.9.13
