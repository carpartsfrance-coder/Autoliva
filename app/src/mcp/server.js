'use strict';

// Implémentation MCP Streamable HTTP minimaliste (mode stateless, JSON unique).
// On évite d'ajouter une dépendance SDK : le protocole côté serveur se résume
// à 4 méthodes JSON-RPC (initialize, notifications/initialized, tools/list,
// tools/call) + ping. Un client MCP (Cowork) communique en POST JSON-RPC 2.0
// avec Accept: application/json, text/event-stream. On répond en JSON pur.

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'cpf-business-analytics';
const SERVER_VERSION = '0.1.0';

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

const businessOverview = require('./tools/businessOverview');
const productPerformance = require('./tools/productPerformance');
const campaignPerformance = require('./tools/campaignPerformance');
const funnelLeaks = require('./tools/funnelLeaks');

const TOOLS = [businessOverview, productPerformance, campaignPerformance, funnelLeaks];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.definition.name, t]));

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

async function dispatch(message) {
  if (!message || message.jsonrpc !== '2.0') {
    return rpcError(message?.id, JSONRPC_INVALID_REQUEST, 'Invalid JSON-RPC 2.0 envelope');
  }

  const { id, method, params } = message;

  // Notifications (no id) : pas de réponse à renvoyer.
  if (id === undefined || id === null) {
    return null;
  }

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Outils d'analyse business pour Car Parts France (e-commerce pièces auto). "
        + "Utilise getBusinessOverview pour la vue de pilotage, getCampaignPerformance pour l'attribution marketing, "
        + "getProductPerformance pour les ventes par produit, getFunnelLeaks pour les fuites (paniers abandonnés, taux retour SAV). "
        + "Tous les montants sont en euros. Les périodes acceptées : 7d, 30d, 90d, 365d, all.",
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, {
      tools: TOOLS.map((t) => ({
        name: t.definition.name,
        description: t.definition.description,
        inputSchema: t.definition.inputSchema,
      })),
    });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
      return rpcError(id, JSONRPC_INVALID_PARAMS, `Unknown tool: ${name}`);
    }
    try {
      const result = await tool.handler(args);
      return rpcResult(id, result);
    } catch (err) {
      return rpcResult(id, {
        content: [{ type: 'text', text: `Erreur outil ${name}: ${err.message}` }],
        isError: true,
      });
    }
  }

  return rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
}

function bearerAuth(req, res, next) {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected) {
    return res.status(503).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: JSONRPC_INTERNAL_ERROR, message: 'MCP_BEARER_TOKEN non configuré côté serveur' },
    });
  }
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== expected) {
    return res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: JSONRPC_INTERNAL_ERROR, message: 'Authentification Bearer requise' },
    });
  }
  return next();
}

async function handlePost(req, res) {
  const body = req.body;
  if (body === undefined || body === null) {
    return res.status(400).json(rpcError(null, JSONRPC_PARSE_ERROR, 'Body JSON manquant'));
  }

  if (Array.isArray(body)) {
    const responses = [];
    for (const msg of body) {
      const r = await dispatch(msg);
      if (r) responses.push(r);
    }
    if (responses.length === 0) {
      return res.status(202).end();
    }
    return res.status(200).json(responses);
  }

  const r = await dispatch(body);
  if (!r) {
    return res.status(202).end();
  }
  return res.status(200).json(r);
}

function handleGet(req, res) {
  // Mode stateless : pas de stream SSE serveur-vers-client.
  res.status(405).json(rpcError(null, JSONRPC_METHOD_NOT_FOUND, 'GET non supporté en mode stateless'));
}

function handleDelete(req, res) {
  // Pas de session à fermer en mode stateless.
  res.status(204).end();
}

function mountMcp(app) {
  const path = process.env.MCP_PATH || '/mcp';
  app.post(path, bearerAuth, handlePost);
  app.get(path, bearerAuth, handleGet);
  app.delete(path, bearerAuth, handleDelete);
  return path;
}

module.exports = { mountMcp, TOOLS, dispatch };
