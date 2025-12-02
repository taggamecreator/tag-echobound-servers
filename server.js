// server.js
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8080;
const TICK_RATE = 20; // server ticks per second
const SNAPSHOT_RATE = 10; // snapshots per second

// In-memory stores (simple)
const sockets = new Map(); // socketId -> { ws, playerId }
const parties = new Map(); // partyId -> { id, hostId, members: [{id,name,wsId,ready,slot}], maxPlayers, state }
const matches = new Map(); // matchId -> matchState

// Utility
function send(ws, obj){ try{ ws.send(JSON.stringify(obj)); }catch(e){ console.warn('send err',e); } }
function broadcastToParty(party, obj){
  for(const m of party.members){
    const s = sockets.get(m.wsId);
    if(s && s.ws && s.ws.readyState === WebSocket.OPEN) send(s.ws, obj);
  }
}

// Basic game state skeleton (extend with your game logic)
function createEmptyMatchState(party){
  const players = party.members.map((m, idx)=>({
    id: m.id,
    name: m.name,
    slot: idx,
    x: 100 + idx*80,
    y: 100,
    vx:0, vy:0, size:56, dead:false, downed:false
  }));
  return { tick:0, players, tagger:0, pickups:[], rebootCards:[], time:0 };
}

// Server
const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const wsId = uuidv4();
  sockets.set(wsId, { ws, playerId: null });
  ws.on('message', (raw) => {
    let msg;
    try{ msg = JSON.parse(raw); } catch(e){ return; }
    handleMessage(wsId, msg);
  });
  ws.on('close', ()=> {
    // cleanup: remove from parties
    const s = sockets.get(wsId);
    if(s && s.playerId){
      // remove from any party
      for(const [pid, party] of parties.entries()){
        const idx = party.members.findIndex(m=>m.wsId === wsId);
        if(idx !== -1){
          party.members.splice(idx,1);
          broadcastToParty(party, { type:'party_update', partyId:pid, members: party.members.map(m=>({id:m.id,name:m.name,ready:m.ready})) });
          if(party.hostId === s.playerId && party.members.length) party.hostId = party.members[0].id;
          if(party.members.length === 0) parties.delete(pid);
        }
      }
    }
    sockets.delete(wsId);
  });
});

function handleMessage(wsId, msg){
  const s = sockets.get(wsId);
  if(!s) return;
  switch(msg.type){
    case 'auth': {
      // assign player id
      const playerId = msg.playerId || uuidv4();
      s.playerId = playerId;
      s.name = msg.name || ('Player-'+playerId.slice(0,4));
      send(s.ws, { type:'auth_ok', playerId, name:s.name });
      break;
    }
    case 'create_party': {
      if(!s.playerId) return send(s.ws, { type:'party_error', message:'not authenticated' });
      const partyId = uuidv4().slice(0,6);
      const party = { id:partyId, hostId: s.playerId, members: [{ id: s.playerId, name: s.name, wsId, ready:false }], maxPlayers: msg.maxPlayers || 4, state:'lobby' };
      parties.set(partyId, party);
      send(s.ws, { type:'party_created', partyId, hostId: party.hostId, members: party.members });
      break;
    }
    case 'join_party': {
      const party = parties.get(msg.partyId);
      if(!party) return send(s.ws, { type:'party_error', message:'party not found' });
      if(party.members.length >= party.maxPlayers) return send(s.ws, { type:'party_error', message:'party full' });
      const member = { id: s.playerId || uuidv4(), name: msg.name || s.name, wsId, ready:false };
      party.members.push(member);
      broadcastToParty(party, { type:'party_update', partyId: party.id, members: party.members.map(m=>({id:m.id,name:m.name,ready:m.ready})), hostId: party.hostId });
      break;
    }
    case 'leave_party': {
      for(const [pid, party] of parties.entries()){
        const idx = party.members.findIndex(m=>m.wsId === wsId);
        if(idx !== -1){
          party.members.splice(idx,1);
          broadcastToParty(party, { type:'party_update', partyId:pid, members: party.members.map(m=>({id:m.id,name:m.name,ready:m.ready})), hostId: party.hostId });
          if(party.members.length === 0) parties.delete(pid);
        }
      }
      break;
    }
    case 'ready': {
      for(const party of parties.values()){
        const m = party.members.find(x=>x.wsId === wsId);
        if(m){ m.ready = !!msg.ready; broadcastToParty(party, { type:'party_update', partyId:party.id, members: party.members.map(mm=>({id:mm.id,name:mm.name,ready:mm.ready})), hostId: party.hostId }); break; }
      }
      break;
    }
    case 'start_party': {
      const party = parties.get(msg.partyId);
      if(!party) return send(s.ws, { type:'party_error', message:'party not found' });
      if(party.hostId !== s.playerId) return send(s.ws, { type:'party_error', message:'only host can start' });
      // create match state
      const matchId = uuidv4();
      const matchState = createEmptyMatchState(party);
      matches.set(matchId, { id:matchId, partyId: party.id, state: matchState, running:true });
      // notify clients
      broadcastToParty(party, { type:'match_starting', matchId, countdown:3 });
      // after short countdown, start authoritative tick for this match
      setTimeout(()=> startMatchLoop(matchId), 3000);
      break;
    }
    case 'input': {
      // route input to match state (simple)
      // find which match this ws belongs to
      for(const match of matches.values()){
        const player = match.state.players.find(p=> p.id === s.playerId);
        if(player){
          // store last input for that player
          player.lastInput = msg;
        }
      }
      break;
    }
    default:
      send(s.ws, { type:'error', message:'unknown message' });
  }
}

// Match loop
function startMatchLoop(matchId){
  const match = matches.get(matchId);
  if(!match) return;
  const tickInterval = 1000 / TICK_RATE;
  const snapshotInterval = Math.round(TICK_RATE / SNAPSHOT_RATE);
  let tickCount = 0;
  match.loop = setInterval(()=>{
    tickCount++;
    // simple authoritative tick: apply inputs, integrate positions
    for(const p of match.state.players){
      const inp = p.lastInput;
      if(inp && inp.keys){
        const speed = 200;
        if(inp.keys.left) p.vx -= speed * (1/TICK_RATE);
        if(inp.keys.right) p.vx += speed * (1/TICK_RATE);
        if(inp.keys.jump && Math.abs(p.vy) < 0.1) p.vy = -600;
        if(inp.keys.attack){ /* handle attack server-side if desired */ }
      }
      // integrate
      p.vy += 1200 * (1/TICK_RATE);
      p.x += p.vx * (1/TICK_RATE);
      p.y += p.vy * (1/TICK_RATE);
      // simple ground clamp
      if(p.y > 1000){ p.y = 1000; p.vy = 0; }
      // damping
      p.vx *= 0.98;
    }
    match.state.tick++;
    // broadcast snapshots at snapshot rate
    if(tickCount % snapshotInterval === 0){
      const party = parties.get(match.partyId);
      if(party) broadcastToParty(party, { type:'snapshot', tick: match.state.tick, state: { players: match.state.players.map(pl=>({id:pl.id,x:pl.x,y:pl.y,vx:pl.vx,vy:pl.vy,dead:pl.dead,downed:pl.downed})), tagger: match.state.tagger } });
    }
  }, tickInterval);
}

// Start server
server.listen(PORT, ()=> console.log('Server listening on', PORT));
