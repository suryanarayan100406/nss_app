process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://nss:nss@localhost:5432/nss_test';
process.env.SESSION_SECRET ??= 'test-session-secret-that-is-long-enough-123456';
process.env.PUBLIC_ORIGIN ??= 'http://localhost:8080';
process.env.MANAGE_ORIGIN ??= 'http://localhost:5173';
