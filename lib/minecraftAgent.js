'use strict';

// lib/minecraftAgent.js
//
// Client HTTP utilisé par le dashboard pour déléguer toutes les opérations
// Minecraft à l'agent léger tournant sur le VPS (mc-agent).
// Si MINECRAFT_AGENT_URL n'est pas défini dans le .env, le dashboard
// continue à gérer Minecraft en local (comportement historique).

const http  = require('http');
const https = require('https');
const { URL } = require('url');

const AGENT_URL    = (process.env.MINECRAFT_AGENT_URL    || '').trim().replace(/\/+$/, '');
const AGENT_SECRET = (process.env.MINECRAFT_AGENT_SECRET || '').trim();
const TIMEOUT_MS   = 60_000; // provision/update peuvent être longs

function isConfigured() {
  return Boolean(AGENT_URL && AGENT_SECRET);
}

// Appel JSON vers l'agent. method: 'GET'|'POST'|'DELETE'
// path: '/tenants/:id/start', body: objet optionnel
function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const url  = new URL(AGENT_URL + path);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const lib  = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${AGENT_SECRET}`,
        'Content-Type':  'application/json',
        ...(data ? { 'Content-Length': data.length } : {}),
      },
      timeout: TIMEOUT_MS,
    };
    const req = lib.request(opts, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (res.statusCode >= 400) return reject(Object.assign(new Error(json.error || 'Erreur agent'), { statusCode: res.statusCode }));
          resolve(json);
        } catch {
          reject(new Error(`Réponse non-JSON de l'agent (${res.statusCode}): ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Timeout : l\'agent Minecraft ne répond pas.')); });
    if (data) req.write(data);
    req.end();
  });
}

// ── Helpers publics (miroir des méthodes du MinecraftController local) ──

function getStatus(tenantId)               { return call('GET',    `/tenants/${tenantId}/status`); }
function getLogs(tenantId)                 { return call('GET',    `/tenants/${tenantId}/logs`); }
function start(tenantId)                   { return call('POST',   `/tenants/${tenantId}/start`); }
function stop(tenantId)                    { return call('POST',   `/tenants/${tenantId}/stop`); }
function sendCommand(tenantId, command)    { return call('POST',   `/tenants/${tenantId}/command`, { command }); }
function deleteServer(tenantId)            { return call('DELETE', `/tenants/${tenantId}`); }

function provision(tenantId, opts) {
  return call('POST', `/tenants/${tenantId}/provision`, opts);
}

function health() {
  return call('GET', '/health');
}

module.exports = { isConfigured, health, getStatus, getLogs, start, stop, sendCommand, provision, deleteServer, call };
