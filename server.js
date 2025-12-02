// server.js
// Tag Echobound authoritative WebSocket server with controller broadcast support.
// Dependencies: ws, uuid
// Install: npm install ws uuid
// Start: CONTROLLER_SECRET=<secret> node server.js
'use strict';

const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8080;
const TICK_RATE = 20;        // server ticks per second
const SNAPSHOT_RATE = 10;    // snapshots per second
const CONTROLLER_SECRET = process.env.CONTROLLER_SECRET || 'dev-secret-please-change';

// In-memory stores
const sockets = new Map();   // wsId -> { ws, playerId, name }
const parties = new Map();   // partyId -> { id, hostId, members: [{id,name,wsId,ready}], maxPlayers, state }
const matches = new Map();   // matchId -> { id, partyId, state, running, loop }

// Utilities
function safeSend(ws, obj){
  try { ws.send(JSON.stringify(obj)); } catch(e) { /* ignore send errors */ }
}

function broadcastAll(obj){
  for(const [wsId, s] of sockets.entries()){
    try {
      if(s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(obj));
    } catch(e){}
  }
}

function broadcastParty(partyId, obj){
  const party = parties.get(partyId);
  if(!party) return;
  for(const m of party.members){
    const s = sockets.get(m.wsId);
    if(s && s.ws && s.ws.readyState === WebSocket.OPEN){
      try { s.ws.send(JSON.stringify(obj)); } catch(e){}
    }
  }
}

// Basic match state factory
function createEmptyMatchState(party){
  const players = party.members.map((m, idx) => ({
    id: m.id,
    name: m.name,
    slot: idx,
    x: 200 + idx * 80,
    y: 200,
    vx: 0, vy: 0, size: 56, dead: false, downed: false
  }));
  return { tick: 0, players, tagger: 0, pickups: [], rebootCards: [], time: 0 };
}

// HTTP server (used only to attach WebSocket)
const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const wsId = uuidv4();
  sockets.set(wsId, { ws, playerId: null, name: null });
  console.log(`[ws] connected ${wsId}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { console.warn('[ws] invalid json', e); return; }
    handleMessage(wsId, msg);
  });

  ws.on('close', () => {
    console.log(`[ws] closed ${wsId}`);
    // remove from parties
    const s = sockets.get(wsId);
    if(s && s.playerId){
      for(const [pid, party] of parties.entries()){
        const idx = party.members.findIndex(m => m.wsId === wsId);
        if(idx !== -1){
          const removed = party.members.splice(idx,1)[0];
          console.log(`[party] removed ${removed.name} from ${pid}`);
          broadcastParty(pid, { type:'party_update', partyId: pid, members: party.members.map(m=>({id:m.id,name:m.name,ready:m.ready})), hostId: party.hostId });
          if(party.hostId === removed.id && party.members.length) party.hostId = party.members[0].id;
          if(party.members.length === 0) parties.delete(pid);
        }
      }
    }
    sockets.delete(wsId);
  });

  ws.on('error', (err) => {
    console.warn('[ws] error', err);
  });
});

function handleMessage(wsId, msg){
  const s = sockets.get(wsId);
  if(!s) return;
  console.log(`[msg] from ${wsId}:`, msg.type);

  switch(msg.type){
    case 'auth': {
      const playerId = msg.playerId || uuidv4();
      s.playerId = playerId;
      s.name = msg.name || ('Player-'+playerId.slice(0,6));
      safeSend(s.ws, { type:'auth_ok', playerId, name: s.name });
      console.log(`[auth] ws=${wsId} as ${s.name} (${playerId})`);
      break;
    }

    case 'create_party': {
      if(!s.playerId) return safeSend(s.ws, { type:'party_error', message:'not authenticated' });
      const partyId = uuidv4().slice(0,6);
      const party = { id: partyId, hostId: s.playerId, members: [{ id: s.playerId, name: s.name, wsId, ready:false }], maxPlayers: msg.maxPlayers || 8, state: 'lobby' };
      parties.set(partyId, party);
      safeSend(s.ws, { type:'party_created', partyId, hostId: party.hostId, members: party.members });
      console.log(`[party] created ${partyId} by ${s.name}`);
      break;
    }

    case 'join_party': {
      const party = parties.get(msg.partyId);
      if(!party) return safeSend(s.ws, { type:'party_error', message:'party not found' });
      if(party.members.length >= party.maxPlayers) return safeSend(s.ws, { type:'party_error', message:'party full' });
      const member = { id: s.playerId || uuidv4(), name: msg.name || s.name, wsId, ready:false };
      party.members.push(member);
      broadcastParty(party.id, { type:'party_update', partyId: party.id, members: party.members.map(m=>({id:m.id,name:m.name,ready:m.ready})), hostId: party.hostId });
      console.log(`[party] ${member.name} joined ${party.id}`);
      break;
    }

    case 'leave_party': {
      for(const [pid, party] of parties.entries()){
        const idx = party.members.findIndex(m => m.wsId === wsId);
        if(idx !== -1){
          const removed = party.members.splice(idx,1)[0];
          broadcastParty(party.id, { type:'party_update', partyId: party.id, members: party.members.map(m=>({id:m.id,name:m.name,ready:m.ready})), hostId: party.hostId });
          if(party.hostId === removed.id && party.members.length) party.hostId = party.members[0].id;
          if(party.members.length === 0) parties.delete(pid);
          console.log(`[party] ${removed.name} left ${pid}`);
        }
      }
      break;
    }

    case 'ready': {
      for(const party of parties.values()){
        const m = party.members.find(x => x.wsId === wsId);
        if(m){ m.ready = !!msg.ready; broadcastParty(party.id, { type:'party_update', partyId: party.id, members: party.members.map(mm=>({id:mm.id,name:mm.name,ready:mm.ready})), hostId: party.hostId }); break; }
      }
      break;
    }

    case 'start_party': {
      const party = parties.get(msg.partyId);
      if(!party) return safeSend(s.ws, { type:'party_error', message:'party not found' });
      if(party.hostId !== s.playerId) return safeSend(s.ws, { type:'party_error', message:'only host can start' });
      const matchId = uuidv4();
      const matchState = createEmptyMatchState(party);
      matches.set(matchId, { id: matchId, partyId: party.id, state: matchState, running: true });
      broadcastParty(party.id, { type:'match_starting', matchId, countdown: 3 });
      console.log(`[match] starting ${matchId} for party ${party.id}`);
      setTimeout(()=> startMatchLoop(matchId), 3000);
      break;
    }

    case 'input': {
      // route input to match state (simple)
      for(const match of matches.values()){
        const player = match.state.players.find(p => p.id === s.playerId);
        if(player){
          player.lastInput = msg;
        }
      }
      break;
    }

    case 'controller': {
      // msg: { type:'controller', secret:'...', target:'all'|'party', partyId?:string, action:'update'|'shutdown'|'maintenance' }
      const secret = (msg.secret || '').trim();
      // debug log (masked)
      console.log(`[controller-debug] from ws=${wsId} name=${s.name||'-'} secretPrefix=${secret.slice(0,6)} action=${msg.action}`);
      if(secret !== CONTROLLER_SECRET){
        if(s.ws && s.ws.readyState === WebSocket.OPEN) safeSend(s.ws, { type:'controller_error', message:'unauthorized' });
        console.warn(`[controller] unauthorized attempt from ws ${wsId}`);
        break;
      }
      const action = msg.action;
      const payload = { type:'controller_broadcast', action, ts: Date.now(), meta: msg.meta || null };
      if(msg.target === 'party' && msg.partyId){
        broadcastParty(msg.partyId, payload);
        console.log(`[controller] action=${action} -> party ${msg.partyId}`);
      } else {
        broadcastAll(payload);
        console.log(`[controller] action=${action} -> all`);
      }
      console.log(`[controller-audit] by ${s.name || wsId} action=${action} target=${msg.target || 'all'} party=${msg.partyId || '-'}`);
      break;
    }

    default:
      safeSend(s.ws, { type:'error', message:'unknown message' });
  }
}

// Match loop: authoritative tick and snapshot broadcast
function startMatchLoop(matchId){
  const match = matches.get(matchId);
  if(!match) return;
  const tickInterval = 1000 / TICK_RATE;
  const snapshotInterval = Math.max(1, Math.round(TICK_RATE / SNAPSHOT_RATE));
  let tickCount = 0;

  match.loop = setInterval(() => {
    tickCount++;
    // apply inputs and integrate
    for(const p of match.state.players){
      const inp = p.lastInput;
      if(inp && inp.keys){
        const speed = 200;
        if(inp.keys.left) p.vx -= speed * (1/TICK_RATE);
        if(inp.keys.right) p.vx += speed * (1/TICK_RATE);
        if(inp.keys.jump && Math.abs(p.vy) < 0.1) p.vy = -600;
      }
      // integrate simple physics
      p.vy += 1200 * (1/TICK_RATE);
      p.x += p.vx * (1/TICK_RATE);
      p.y += p.vy * (1/TICK_RATE);
      if(p.y > 1000){ p.y = 1000; p.vy = 0; }
      p.vx *= 0.98;
    }

    match.state.tick++;
    // broadcast snapshots at snapshot rate
    if(tickCount % snapshotInterval === 0){
      const party = parties.get(match.partyId);
      if(party) broadcastParty(party.id, { type:'snapshot', tick: match.state.tick, state: { players: match.state.players.map(pl => ({ id: pl.id, x: pl.x, y: pl.y, vx: pl.vx, vy: pl.vy, dead: pl.dead, downed: pl.downed })), tagger: match.state.tagger } });
    }
  }, tickInterval);

  match.running = true;
  console.log(`[match] loop started ${matchId}`);
}

function stopMatchLoop(matchId){
  const match = matches.get(matchId);
  if(!match) return;
  if(match.loop) clearInterval(match.loop);
  match.running = false;
  matches.delete(matchId);
  console.log(`[match] stopped ${matchId}`);
}

// Start server
server.listen(PORT, () => console.log('Server listening on', PORT));
