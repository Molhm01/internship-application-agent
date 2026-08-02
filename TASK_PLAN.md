# TASK_PLAN.md

1. Inspect ApplicationSession schema in shared/schemas/application-session.ts
2. Update ApplicationSession Zod schema with proper structure and validation
3. Implement WebApiClient with typed methods:
   - getApplicationSession(sessionId)
   - createApplicationSession(input)
   - claimApplicationSession(sessionId)
   - updateApplicationSessionStatus(sessionId, status)
   - clearApplicationSessionCache() 
4. Add SQLite table for application sessions
5. Add authenticated localhost agent-server routes:
   - POST /application-sessions
   - GET /application-sessions/:id
   - POST /application-sessions/:id/claim
   - PATCH /application-sessions/:id/status
6. Database persistence with expiration and single-claim protection
7. Update shared schema to include ApplicationSessionInput type
8. Add appropriate tests
9. Verify implementation meets all requirements