'use strict';

const jwt = require('jsonwebtoken');

// ─── Dependency Injection ───
let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getLog(): (msg: string, level?: string, _module?: string) => void {
  return _deps.logger?.log || console.log;
}

const SECRET = process.env.ADMIN_SECRET || null;
const EXPIRES_IN = '1h';

function generateToken(payload = {}) { 
  if (!SECRET) throw new Error('ADMIN_SECRET not set');
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

function verifyToken(token: string) { 
  if (!SECRET) return null;
  try { return jwt.verify(token, SECRET); } catch (err: any) { return null; }
}

function requireAuth(req: any, res: any, next: () => void) { 
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
    return;
  }
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired token' }));
    return;
  }
  if (!decoded.admin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Insufficient privileges' }));
    return;
  }
  if (process.env.ADMIN_ALLOWED_IPS) {
    const allowed = process.env.ADMIN_ALLOWED_IPS.split(',').map((ip: string) => ip.trim());
    let clientIp = req.socket.remoteAddress || '';
    const v4Mapped = clientIp.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Mapped) clientIp = v4Mapped[1];
    if (!allowed.includes(clientIp)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'IP not allowed' }));
      return;
    }
  }
  req.user = decoded;
  next();
}

module.exports = { generateToken, verifyToken, requireAuth, _injectDependencies };
