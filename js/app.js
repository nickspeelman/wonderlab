(() => {
  'use strict';

  const DB_VERSION = 9;
  const DB_NAME = 'roscoes-playground';
  const STORE = 'state';
  const COMPANION_URL = 'https://wonderlab-companion.nickspeelman.com/';
  const COLORS = ['#e63946', '#ffd23f', '#3a86ff'];
  const app = document.getElementById('app');

  const defaults = {
    currentScreen: 'home',
    preferences: { soundEffects: true, voiceResponses: true, volume: 0.45, tilt: true, usageInsights: true },
    switchboard: { light:false, rain:false, stars:false, bubbles:false, train:false, wind:false, snow:false, lightning:false, rainbow:false },
    tapAndMake: { selected:'circle', selectedColor:'red', shapes:[] },
    buttons: { events:[] },
    pictureLab: { instances:[], selectedId:null },
    timeLab: { timestamp:null, step:'hour' },
    device: { deviceId:null, deviceName:null, deviceToken:null, pairedAt:null, lastSyncAt:null, lastError:null },
    colorLight: { levels:[0,0,0], brightnessLevel:3, spot:{x:.5,y:.5,color:'red'} },
    drawing: { dataUrl:null, tool:'red', brushSize:'medium' },
    drawings: { queue:[], lastSyncAt:null, lastError:null },
    drive: { queue:[], rootFolderId:null, drawingsFolderId:null, lastSyncAt:null, lastError:null },
    physics: { selectedColor:'red', objects:[
      {id:'ball1',type:'ball',color:'red',x:.25,y:.88,vx:0,vy:0,angle:0,omega:0},
      {id:'block1',type:'block',color:'yellow',x:.50,y:.88,vx:0,vy:0,angle:0,omega:0},
      {id:'ball2',type:'ball',color:'blue',x:.75,y:.88,vx:0,vy:0,angle:0,omega:0}
    ]},
    analytics: {
      events: [],
      milestones: {},
      touches: [],
      sessions: [],
      currentSession: null,
      activityStartedAt: null,
      activityDurations: {},
      lastSyncAt: null,
      lastError: null
    }
  };

  const state = structuredClone(defaults);
  let db;
  let audioCtx;
  let lowPower = false;
  let activeCleanup = () => {};
  let lastTouchSampleAt = 0;
  let buildVersion = 'Checking…';

  async function refreshBuildVersion(){
    const prefix='roscoe-wonder-lab-';
    try{
      if('caches' in window){
        const names=await caches.keys();
        const current=names.find(name=>name.startsWith(prefix));
        if(current){ buildVersion=current.slice(prefix.length); return buildVersion; }
      }
      const response=await fetch('./sw.js',{cache:'no-store'});
      if(response.ok){
        const source=await response.text();
        const match=source.match(/const\s+CACHE\s*=\s*['"]roscoe-wonder-lab-([^'"]+)['"]/);
        if(match){ buildVersion=match[1]; return buildVersion; }
      }
    }catch{}
    buildVersion='Unknown';
    return buildVersion;
  }

  const activeLoops = new Map();
  let voiceDucking = false;
  let lastCollisionSoundAt = 0;
  let lastBounceSoundAt = 0;

  const AUDIO_FILES = {
    ui: {
      click:'audio/ui/click.mp3', toggle:'audio/ui/toggle.mp3', pop:'audio/ui/pop.mp3', broom:'audio/ui/broom.mp3', home:'audio/ui/home.mp3'
    },
    switches: {
      light:'audio/switches/light.mp3', rain:'audio/switches/rain.mp3', stars:'audio/switches/stars.mp3',
      bubbles:'audio/switches/bubbles.mp3', train:'audio/switches/train.mp3', wind:'audio/switches/wind.mp3',
      snow:'audio/switches/snow.mp3', lightning:'audio/switches/lightning.mp3', rainbow:'audio/switches/rainbow.mp3'
    },
    motion: {
      pickup:'audio/motion/pickup.mp3', drop:'audio/motion/drop.mp3', collision:'audio/motion/collision.mp3',
      bounce:'audio/motion/bounce.mp3', spawn:'audio/motion/spawn.mp3', remove:'audio/motion/remove.mp3'
    },
    time: {
      rooster:'audio/time/rooster.mp3', birds:'audio/time/birds.mp3', bell:'audio/time/bell.mp3', crickets:'audio/time/crickets.mp3',
      owl:'audio/time/owl.mp3', shootingStar:'audio/time/shooting-star.mp3', leaves:'audio/time/leaves.mp3', winterWind:'audio/time/winter-wind.mp3',
      trickOrTreat:'audio/time/trick-or-treat.mp3', sleighBells:'audio/time/sleigh-bells.mp3', fireworks:'audio/time/fireworks.mp3', tick:'audio/time/clock-tick.mp3'
    }
  };

  const LOOPING_SWITCHES = new Set(['rain','bubbles','train','wind','snow','lightning']);
  const ONE_SHOT_SWITCHES = new Set(['light','stars','rainbow']);
  const MIX = { voice:1, ui:.45, pop:.60, broom:.45, switchOneShot:.55, motion:.50, ambient:.32 };

  const clone = obj => JSON.parse(JSON.stringify(obj));

  async function openDB(){
    return new Promise((resolve,reject)=>{
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function idbGet(key){ return new Promise((resolve,reject)=>{ const r=db.transaction(STORE).objectStore(STORE).get(key); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); }); }
  function idbSet(key,val){ return new Promise((resolve,reject)=>{ const r=db.transaction(STORE,'readwrite').objectStore(STORE).put(val,key); r.onsuccess=()=>resolve(); r.onerror=()=>reject(r.error); }); }
  function idbDelete(key){ return new Promise((resolve,reject)=>{ const r=db.transaction(STORE,'readwrite').objectStore(STORE).delete(key); r.onsuccess=()=>resolve(); r.onerror=()=>reject(r.error); }); }

  async function loadState(){
    for (const key of Object.keys(defaults)) {
      const saved = await idbGet(key);
      if (saved !== undefined) state[key] = saved;
    }
    // Merge newly added preferences into older installs without losing existing choices.
    state.preferences = {...defaults.preferences, ...(state.preferences || {})};
    state.device = {...defaults.device, ...(state.device || {})};
    state.timeLab = {...defaults.timeLab, ...(state.timeLab || {})};
    if (Object.prototype.hasOwnProperty.call(state.preferences, 'muted')) {
      state.preferences.soundEffects = !state.preferences.muted;
      delete state.preferences.muted;
    }
    await save('preferences');
    state.switchboard = {...defaults.switchboard, ...(state.switchboard || {})};
    if(!Array.isArray(state.colorLight?.levels)){
      const old=state.colorLight?.colors || [];
      state.colorLight={...defaults.colorLight, ...(state.colorLight||{}), levels:[0,1,2].map(i=>old.includes(i)?5:0)};
    } else state.colorLight={...defaults.colorLight,...state.colorLight};
    if(!Number.isFinite(state.colorLight.brightnessLevel)){
      const legacy=Number.isFinite(state.colorLight.brightness)?state.colorLight.brightness:1;
      state.colorLight.brightnessLevel=Math.max(0,Math.min(5,Math.round((legacy-.35)/(1.5-.35)*5)));
    }
    delete state.colorLight.brightness;
    state.drawing={...defaults.drawing,...(state.drawing||{})};
    state.drawings={...defaults.drawings,...(state.drawings||{})};
    if(!Array.isArray(state.drawings.queue))state.drawings.queue=[];
    state.analytics={...defaults.analytics,...(state.analytics||{})};
    if(!Array.isArray(state.analytics.events))state.analytics.events=[];
    if(!Array.isArray(state.analytics.sessions))state.analytics.sessions=[];
    if(!Array.isArray(state.analytics.touches))state.analytics.touches=[];
    if(!state.analytics.milestones||typeof state.analytics.milestones!=='object')state.analytics.milestones={};
    state.analytics.events=state.analytics.events.map(item=>({...item,id:/^[0-9a-f-]{36}$/i.test(String(item.id||''))?item.id:crypto.randomUUID(),syncedAt:item.syncedAt||null}));
    state.analytics.sessions=state.analytics.sessions.map(item=>({...item,id:/^[0-9a-f-]{36}$/i.test(String(item.id||''))?item.id:crypto.randomUUID(),syncedAt:item.syncedAt||null}));
    Object.entries(state.analytics.milestones).forEach(([key,item])=>{state.analytics.milestones[key]={...item,key:item?.key||key,syncedAt:item?.syncedAt||null};});
    state.tapAndMake={...defaults.tapAndMake,...(state.tapAndMake||{})};
    state.tapAndMake.shapes=(state.tapAndMake.shapes||[]).map(x=>({...x,color:x.color||'red'}));
    state.physics={...defaults.physics,...(state.physics||{})};
    state.physics.objects=(state.physics.objects||[]).map((x,i)=>({
      ...x,
      type:x.type==='triangle'?'stick':x.type,
      color:x.color||['red','yellow','blue'][i%3],
      x:Number.isFinite(x.x)&&x.x>=0&&x.x<=1?x.x:defaults.physics.objects[i%defaults.physics.objects.length].x,
      y:Number.isFinite(x.y)&&x.y>=0&&x.y<=1?x.y:defaults.physics.objects[i%defaults.physics.objects.length].y,
      vx:Number.isFinite(x.vx)?x.vx:0,
      vy:Number.isFinite(x.vy)?x.vy:0,
      angle:Number.isFinite(x.angle)?x.angle:0,
      omega:Number.isFinite(x.omega)?x.omega:0
    }));
    // Repair the known zero-size-canvas corruption from older builds.
    if(state.physics.objects.length && state.physics.objects.every(o=>o.x>.94 || o.y<.06)){
      state.physics.objects=clone(defaults.physics.objects);
    }
    await Promise.all([save('switchboard'),save('colorLight'),save('drawing'),save('analytics')]);
  }
  const save = key => idbSet(key, clone(state[key]));


  const nowISO = () => new Date().toISOString();
  const weekAgoMs = () => Date.now() - 7 * 24 * 60 * 60 * 1000;

  function analyticsEnabled(){ return state.preferences.usageInsights !== false; }

  function trimAnalytics(){
    const a=state.analytics;
    if(a.events.length>6000) a.events.splice(0,a.events.length-6000);
    if(a.touches.length>3500) a.touches.splice(0,a.touches.length-3500);
    if(a.sessions.length>365) a.sessions.splice(0,a.sessions.length-365);
  }

  function logEvent(activity,event,details={}){
    if(!analyticsEnabled()) return;
    state.analytics.events.push({id:crypto.randomUUID(),time:nowISO(),activity,event,details,syncedAt:null});
    trimAnalytics();
    save('analytics').catch(()=>{});
  }

  function markMilestone(key,label,activity){
    if(!analyticsEnabled() || state.analytics.milestones[key]) return;
    state.analytics.milestones[key]={key,time:nowISO(),label,activity,syncedAt:null};
    logEvent(activity,'milestone',{key,label});
  }

  function startSession(){
    if(!analyticsEnabled() || state.analytics.currentSession) return;
    state.analytics.currentSession={id:crypto.randomUUID(),startedAt:nowISO(),batteryStart:batteryInfo?Math.round(batteryInfo.level*100):null};
    state.analytics.activityStartedAt=Date.now();
    save('analytics').catch(()=>{});
  }

  function closeActivitySegment(nextScreen=null){
    if(!analyticsEnabled() || !state.analytics.activityStartedAt) return;
    const current=state.currentScreen;
    const elapsed=Math.max(0,Date.now()-state.analytics.activityStartedAt);
    if(current && current!=='home') state.analytics.activityDurations[current]=(state.analytics.activityDurations[current]||0)+elapsed;
    state.analytics.activityStartedAt=nextScreen?Date.now():null;
  }

  function endSession(){
    if(!analyticsEnabled() || !state.analytics.currentSession) return;
    if(state.currentScreen && state.currentScreen!=='home' && state.analytics.activityStartedAt){
      const durationMs=Math.max(0,Date.now()-state.analytics.activityStartedAt);
      logEvent(state.currentScreen,'activity_exit',{durationMs,to:'session_end'});
    }
    closeActivitySegment(null);
    const cur=state.analytics.currentSession;
    state.analytics.sessions.push({
      id:cur.id,
      startedAt:cur.startedAt,
      endedAt:nowISO(),
      durationMs:Math.max(0,Date.now()-new Date(cur.startedAt).getTime()),
      batteryStart:cur.batteryStart,
      batteryEnd:batteryInfo?Math.round(batteryInfo.level*100):null,
      syncedAt:null
    });
    state.analytics.currentSession=null;
    trimAnalytics();
    save('analytics').catch(()=>{});
  }

  function resumeSession(){
    if(!analyticsEnabled()) return;
    if(!state.analytics.currentSession) startSession();
    state.analytics.activityStartedAt=Date.now();
  }

  function sampleTouch(activity,e,container){
    if(!analyticsEnabled() || !activity || activity==='home') return;
    const now=Date.now(); if(now-lastTouchSampleAt<250) return; lastTouchSampleAt=now;
    const r=container.getBoundingClientRect(); if(!r.width||!r.height) return;
    state.analytics.touches.push({time:nowISO(),activity,x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))});
    trimAnalytics();
    save('analytics').catch(()=>{});
  }

  function bindTouchSampling(){
    const wrap=document.querySelector('.activity-wrap');
    if(!wrap || !analyticsEnabled()) return;
    wrap.addEventListener('pointerdown',e=>{
      if(e.target.closest('.activity-tools,.topbar')) return;
      sampleTouch(state.currentScreen,e,wrap);
    },{passive:true});
  }

  function fmtDuration(ms){
    const mins=Math.round(ms/60000);
    if(mins<60) return `${mins}m`;
    const h=Math.floor(mins/60),m=mins%60;
    return `${h}h ${m}m`;
  }

  function activityLabel(id){ return activities.find(a=>a.id===id)?.label || id; }

  function masterVolume(){ return Math.max(0,Math.min(1,+state.preferences.volume||0)); }

  function logAudioFailure(kind,path,error){
    console.warn(`[Wonder Lab audio] ${kind} failed for ${path}`, error || 'Unknown media error');
  }

  function oneShot(path, relativeVolume=.5, playbackRate=1){
    if(!state.preferences.soundEffects || !path) return null;
    try{
      const a=new Audio(path);
      a.preload='auto';
      a.volume=Math.min(1,masterVolume()*relativeVolume);
      a.playbackRate=playbackRate;
      a.addEventListener('error',()=>logAudioFailure('load',path,a.error),{once:true});
      const playPromise=a.play();
      if(playPromise?.catch) playPromise.catch(error=>logAudioFailure('play',path,error));
      return a;
    }catch(error){
      logAudioFailure('setup',path,error);
      return null;
    }
  }

  function playNamed(group,name,relativeVolume){
    const path=AUDIO_FILES[group]?.[name];
    const jitter=(group==='ui' && ['click','toggle','pop'].includes(name)) ? .97+Math.random()*.06 : 1;
    return oneShot(path,relativeVolume,jitter);
  }

  function ambientPerLoopVolume(){
    const n=Math.max(1,activeLoops.size);
    return MIX.ambient/Math.sqrt(n);
  }

  function updateLoopVolumes(){
    const duck=voiceDucking?.40:1;
    const volume=Math.min(1,masterVolume()*ambientPerLoopVolume()*duck);
    for(const a of activeLoops.values()) a.volume=volume;
  }

  function startLoop(key,path){
    if(!state.preferences.soundEffects || !path || activeLoops.has(key)) return;
    try{
      const a=new Audio(path);a.loop=true;a.preload='auto';a.volume=0;
      a.addEventListener('error',()=>{
        logAudioFailure('load',path,a.error);
        if(activeLoops.get(key)===a) activeLoops.delete(key);
      },{once:true});
      activeLoops.set(key,a);updateLoopVolumes();
      const playPromise=a.play();
      if(playPromise?.catch) playPromise.catch(error=>{
        logAudioFailure('play',path,error);
        if(activeLoops.get(key)===a) activeLoops.delete(key);
      });
    }catch(error){
      logAudioFailure('setup',path,error);
    }
  }

  function stopLoop(key){
    const a=activeLoops.get(key);if(!a)return;
    a.pause();a.currentTime=0;activeLoops.delete(key);updateLoopVolumes();
  }

  function stopAllLoops(){
    for(const key of [...activeLoops.keys()])stopLoop(key);
  }

  // V15: synthesized beeps removed; recorded UI/action sounds are used instead.
  function tone(){ /* intentionally silent */ }

  function speak(text){
    if (!state.preferences.voiceResponses || !text || !('speechSynthesis' in window)) return;
    try{
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.82;
      utterance.pitch = 1.02;
      utterance.volume = Math.min(1,masterVolume()*MIX.voice);
      utterance.onstart=()=>{voiceDucking=true;updateLoopVolumes();};
      const release=()=>{voiceDucking=false;updateLoopVolumes();};
      utterance.onend=release;utterance.onerror=release;
      const voices = window.speechSynthesis.getVoices();
      const preferred = voices.find(v => /^en-US/i.test(v.lang) && /google|natural/i.test(v.name))
        || voices.find(v => /^en-US/i.test(v.lang))
        || voices.find(v => /^en/i.test(v.lang));
      if (preferred) utterance.voice = preferred;
      window.speechSynthesis.speak(utterance);
    }catch{}
  }

  function toast(msg){ const el=document.createElement('div'); el.className='toast'; el.textContent=msg; document.body.appendChild(el); setTimeout(()=>el.remove(),1500); }

  function shell(title, body, activity=false){
    app.innerHTML = `
      <section class="screen">
        <header class="topbar">
          <div class="brand">${title}</div>
          <div></div>
          <div class="top-actions">
            <div id="battery" class="battery" aria-label="Low battery"><span class="battery-charge-icon" aria-hidden="true">⚡</span><div class="battery-fill"></div></div>
            <button class="icon-btn" id="parentBtn" aria-label="Wonder Lab settings">⚙️</button>
          </div>
        </header>
        <main class="content">${body}</main>
      </section>`;
    document.getElementById('parentBtn').onclick = openParentGate;
    updateBatteryUI();
    if (activity){
      document.querySelector('main.content')?.classList.add('activity-content');
      addActivityTools();
      requestAnimationFrame(bindTouchSampling);
    }
  }

  document.addEventListener('pointerdown',e=>{
    const button=e.target.closest('button');
    if(!button || button.disabled || button.id==='homeBtn' || button.id==='broomBtn') return;
    playNamed('ui',button.classList.contains('switch-card')?'toggle':'click',MIX.ui);
  },{passive:true});

  function addActivityTools(){
    const content=document.querySelector('main.content');
    const tools=document.createElement('div'); tools.className='activity-tools';
    tools.innerHTML=`<button class="icon-btn" id="homeBtn" aria-label="Home">🏠</button><button class="icon-btn" id="broomBtn" aria-label="Clean up">🧹</button>`;
    content.appendChild(tools);
    document.getElementById('homeBtn').onclick=()=>{ playNamed('ui','home',MIX.ui); speak('Home'); navigate('home'); };
    document.getElementById('broomBtn').onclick=()=>{ playNamed('ui','broom',MIX.broom); speak('Clean up'); resetCurrent(true); };
  }

  const activities = [
    {id:'switchboard', label:'Switch Lab', icon:'🎚️', cls:'red'},
    {id:'tapAndMake', label:'Shape Lab', icon:'⭐', cls:'yellow'},
    {id:'buttons', label:'Action Lab', icon:'🔴', cls:'blue'},
    {id:'colorLight', label:'Color Lab', icon:'🌈', cls:'white'},
    {id:'drawing', label:'Art Lab', icon:'🎨', cls:'orange'},
    {id:'physics', label:'Motion Lab', icon:'⚽', cls:'green'},
    {id:'pictureLab', label:'Picture Lab', icon:'🖼️', cls:'purple'},
    {id:'timeLab', label:'Time Lab', icon:'🕰️', cls:'gray'}
  ];

  async function navigate(screen){
    const previous=state.currentScreen;
    if(analyticsEnabled() && previous && previous!=='home' && state.analytics.activityStartedAt){
      const durationMs=Math.max(0,Date.now()-state.analytics.activityStartedAt);
      state.analytics.activityDurations[previous]=(state.analytics.activityDurations[previous]||0)+durationMs;
      logEvent(previous,'activity_exit',{durationMs,to:screen});
    }
    activeCleanup(); activeCleanup=()=>{};
    state.currentScreen=screen;
    if(analyticsEnabled()){
      state.analytics.activityStartedAt=Date.now();
      if(screen!=='home') logEvent(screen,'activity_enter',{from:previous});
    }
    await Promise.all([save('currentScreen'),save('analytics')]);
    if(screen==='home'&&state.device.deviceToken&&navigator.onLine)syncCompanionNow(false).catch(()=>{});
    if (screen==='home') renderHome(); else renderActivity(screen);
  }

  function renderHome(){
    const tiles=activities.map(a=>`<button class="tile ${a.cls}${a.disabled?' coming-soon':''}" data-screen="${a.id}" ${a.disabled?'disabled aria-disabled="true"':''}><span class="tile-icon">${a.icon}</span><span class="tile-label">${a.label}</span>${a.disabled?'<span class="tile-note">COMING SOON</span>':''}</button>`).join('');
    shell("Roscoe's Wonder Lab", `<div class="home-grid">${tiles}</div>`);
    document.querySelectorAll('.tile:not(:disabled)').forEach(btn=>btn.onclick=()=>{ speak(activityLabel(btn.dataset.screen)); navigate(btn.dataset.screen); });
  }

  function renderActivity(id){
    const map={switchboard:renderSwitchboard,tapAndMake:renderTapAndMake,buttons:renderButtons,colorLight:renderColorLight,drawing:renderDrawing,physics:renderPhysics,pictureLab:renderPictureLab,timeLab:renderTimeLab};
    if(map[id]) map[id](); else renderHome();
  }

  function stopAllSwitchSounds(){
    for(const key of LOOPING_SWITCHES)stopLoop(`switch:${key}`);
  }

  function syncSwitchSounds(){
    for(const key of LOOPING_SWITCHES){
      const loopKey=`switch:${key}`;
      if(state.preferences.soundEffects && state.switchboard[key])startLoop(loopKey,AUDIO_FILES.switches[key]);
      else stopLoop(loopKey);
    }
    updateLoopVolumes();
  }

  function playSwitchOneShot(key){
    if(ONE_SHOT_SWITCHES.has(key))playNamed('switches',key,MIX.switchOneShot);
  }

  function renderSwitchboard(){
    const labels={light:['💡','Light'],rain:['🌧️','Rain'],stars:['⭐','Stars'],bubbles:['🫧','Bubbles'],train:['🚂','Train'],wind:['🍃','Wind'],snow:['❄️','Snow'],lightning:['⚡','Lightning'],rainbow:['🌈','Rainbow']};
    const cards=Object.entries(labels).map(([k,[e,l]])=>`<button class="switch-card ${state.switchboard[k]?'on':''}" data-key="${k}" aria-label="${l}"><span class="emoji">${e}</span><span class="toggle"><span class="toggle-knob"></span></span></button>`).join('');
    shell('Switch Lab',`<div class="activity-wrap"><div class="switchboard"><div id="fxRear" class="fx-layer fx-rear"></div>${cards}<div id="fxFront" class="fx-layer fx-front"></div></div></div>`,true);
    activeCleanup=()=>stopAllSwitchSounds();
    const fxRear=document.getElementById('fxRear'),fxFront=document.getElementById('fxFront'); drawSwitchFx(fxRear,fxFront); syncSwitchSounds();
    document.querySelectorAll('.switch-card').forEach(c=>c.onclick=async()=>{
      const k=c.dataset.key; state.switchboard[k]=!state.switchboard[k]; c.classList.toggle('on');
      if(state.switchboard[k])playSwitchOneShot(k);
      speak(`${labels[k][1]} ${state.switchboard[k]?'on':'off'}`); await save('switchboard');
      logEvent('switchboard','switch_toggled',{switch:k,on:state.switchboard[k]}); markMilestone('switch-first','Turned on a switch','switchboard');
      const onCount=Object.values(state.switchboard).filter(Boolean).length; if(onCount>=2)markMilestone('switch-two','Turned on two switches together','switchboard'); if(onCount===9)markMilestone('switch-all','Turned on every switch','switchboard');
      drawSwitchFx(fxRear,fxFront); syncSwitchSounds();
    });
  }

  function drawSwitchFx(rear,front){
    rear.innerHTML=''; front.innerHTML='';
    const board=document.querySelector('.switchboard');
    board?.classList.toggle('light-active',!!state.switchboard.light);
    const count=lowPower?5:10;
    if(state.switchboard.rainbow) rear.insertAdjacentHTML('beforeend','<span class="rainbow-arc">🌈</span>');
    if(state.switchboard.rain) for(let i=0;i<count*2;i++) front.insertAdjacentHTML('beforeend',`<i class="drop" style="left:${Math.random()*100}%;animation-delay:${Math.random()}s"></i>`);
    if(state.switchboard.stars) for(let i=0;i<count;i++) front.insertAdjacentHTML('beforeend',`<span class="fx-star" style="left:${Math.random()*92}%;top:${Math.random()*75}%;animation-delay:${Math.random()}s">⭐</span>`);
    if(state.switchboard.bubbles) for(let i=0;i<count;i++){ const size=30+Math.random()*45; front.insertAdjacentHTML('beforeend',`<i class="bubble" style="left:${Math.random()*92}%;width:${size}px;height:${size}px;animation-delay:${Math.random()*5}s"></i>`); }
    if(state.switchboard.train) front.insertAdjacentHTML('beforeend','<span class="train">🚂</span>');
    if(state.switchboard.wind) for(let i=0;i<count;i++) front.insertAdjacentHTML('beforeend',`<span class="wind-leaf" style="top:${15+Math.random()*70}%;animation-delay:${Math.random()*4}s">🍃</span>`);
    if(state.switchboard.snow) for(let i=0;i<count*2;i++) front.insertAdjacentHTML('beforeend',`<span class="snowflake" style="left:${Math.random()*100}%;animation-delay:${Math.random()*4}s">❄</span>`);
    if(state.switchboard.lightning){
      const bolts=lowPower?3:6;
      for(let i=0;i<bolts;i++){
        const left=5+Math.random()*82, top=4+Math.random()*58, size=70+Math.random()*95;
        front.insertAdjacentHTML('beforeend',`<span class="lightning-flash" style="left:${left}%;top:${top}%;font-size:${size}px;animation-delay:${Math.random()*1.8}s">⚡</span>`);
      }
    }
  }

  function renderTapAndMake(){
    const shapeNames={circle:'Circle',square:'Square',triangle:'Triangle',star:'Star'};
    const colors={red:'#e63946',yellow:'#ffd23f',blue:'#3a86ff'};
    const shapeTools=Object.keys(shapeNames).map(k=>`<button class="shape-choice ${state.tapAndMake.selected===k?'active':''}" data-shape="${k}" aria-label="${shapeNames[k]}"><span class="shape-icon ${k}"></span></button>`).join('');
    const colorTools=Object.entries(colors).map(([k,v])=>`<button class="shape-color ${state.tapAndMake.selectedColor===k?'active':''}" data-color="${k}" aria-label="${k}" style="--shape-color:${v}"></button>`).join('');
    shell('Shape Lab',`<div class="activity-wrap"><div class="make-area" id="makeArea"><div class="shape-toolbar"><div class="shape-tool-row">${shapeTools}</div><div class="shape-color-row">${colorTools}</div></div></div></div>`,true);
    const area=document.getElementById('makeArea');
    const addShapeEl=sh=>{ const el=document.createElement('div'); el.className=`made-shape shape-${sh.type}`; el.dataset.id=sh.id; el.style.setProperty('--shape-color',colors[sh.color]||colors.red); el.style.left=`${sh.x*100}%`; el.style.top=`${sh.y*100}%`; el.style.transform=`translate(-50%,-50%) scale(${sh.scale})`; area.appendChild(el); bindShape(el,sh); };
    state.tapAndMake.shapes.forEach(addShapeEl);
    document.querySelectorAll('.shape-choice').forEach(b=>b.onclick=e=>{ e.stopPropagation(); state.tapAndMake.selected=b.dataset.shape; document.querySelectorAll('.shape-choice').forEach(x=>x.classList.toggle('active',x===b)); save('tapAndMake'); logEvent('tapAndMake','shape_selected',{shape:state.tapAndMake.selected}); markMilestone('shape-switched','Changed the shape type','tapAndMake'); speak(shapeNames[state.tapAndMake.selected]); });
    document.querySelectorAll('.shape-color').forEach(b=>b.onclick=e=>{e.stopPropagation();state.tapAndMake.selectedColor=b.dataset.color;document.querySelectorAll('.shape-color').forEach(x=>x.classList.toggle('active',x===b));save('tapAndMake');speak(b.dataset.color);});
    area.onpointerdown=e=>{
      if(e.target!==area) return;
      const r=area.getBoundingClientRect(); const sh={id:crypto.randomUUID(),type:state.tapAndMake.selected,color:state.tapAndMake.selectedColor,x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height,scale:1};
      state.tapAndMake.shapes.push(sh); addShapeEl(sh); save('tapAndMake'); playNamed('motion','spawn',MIX.motion); logEvent('tapAndMake','shape_created',{shape:sh.type,color:sh.color,count:state.tapAndMake.shapes.length}); markMilestone('shape-first','Created a first shape','tapAndMake'); if(state.tapAndMake.shapes.length>=10)markMilestone('shape-ten','Created ten shapes','tapAndMake'); if(state.tapAndMake.shapes.length>=50)markMilestone('shape-fifty','Created fifty shapes','tapAndMake'); speak(`${sh.color} ${sh.type}`);
    };
  }

  function bindShape(el,s){
    let timer=null, grow=null, dragging=false, start={};
    const finish=async()=>{ clearTimeout(timer); clearInterval(grow); el.classList.remove('growing'); await save('tapAndMake'); };
    el.onpointerdown=e=>{ e.stopPropagation(); el.setPointerCapture(e.pointerId); dragging=true; start={x:e.clientX,y:e.clientY}; timer=setTimeout(()=>{ dragging=false; el.classList.add('growing'); markMilestone('shape-grow','Made a shape grow','tapAndMake'); grow=setInterval(()=>{ s.scale=Math.min(3.2,s.scale+.08); el.style.transform=`translate(-50%,-50%) scale(${s.scale})`; if(s.scale>=3.2){ clearInterval(grow); el.classList.add('pop'); playNamed('ui','pop',MIX.pop); speak('Pop'); setTimeout(()=>{ state.tapAndMake.shapes=state.tapAndMake.shapes.filter(x=>x.id!==s.id); el.remove(); save('tapAndMake'); logEvent('tapAndMake','shape_popped',{shape:s.type}); markMilestone('shape-pop','Popped a shape by holding it','tapAndMake'); },220); } },90); },430); };
    el.onpointermove=e=>{ if(!dragging) return; if(Math.hypot(e.clientX-start.x,e.clientY-start.y)>8){ clearTimeout(timer); markMilestone('shape-drag','Dragged a shape','tapAndMake'); } const area=document.getElementById('makeArea'),r=area.getBoundingClientRect(); s.x=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)); s.y=Math.max(0,Math.min(1,(e.clientY-r.top)/r.height)); el.style.left=`${s.x*100}%`; el.style.top=`${s.y*100}%`; };
    el.onpointerup=finish; el.onpointercancel=finish;
  }

  function renderButtons(){
    const icons=['⚽','🌀','🚂','✨','🎉','👣'];
    shell('Action Lab',`<div class="activity-wrap"><div class="buttons-grid">${icons.map((x,i)=>`<button class="big-trigger" data-i="${i}">${x}</button>`).join('')}</div><div class="event-layer" id="eventLayer"></div></div>`,true);
    const layer=document.getElementById('eventLayer');
    document.querySelectorAll('.big-trigger').forEach(b=>b.onclick=()=>{ const index=+b.dataset.i; const x=['⚽','🌀','🚂','✨','🎉','👣'][index]; const words=['Ball','Spin','Train','Sparkle','Confetti','Stomp']; for(let i=0;i<(lowPower?1:3);i++){ const e=document.createElement('span'); e.className='event'; e.textContent=x; e.style.left=`${15+Math.random()*70}%`; e.style.top=`${45+Math.random()*35}%`; e.style.animationDelay=`${i*.08}s`; layer.appendChild(e); setTimeout(()=>e.remove(),1900); } logEvent('buttons','button_pressed',{button:+b.dataset.i}); markMilestone('button-first','Pressed a big button','buttons'); speak(words[index]); });
  }

  function mixedColor(levels){
    const [r,y,b]=levels.map(v=>Math.max(0,Math.min(5,v))/5);
    const base=[255,255,255], pigments=[[230,57,70],[255,210,63],[58,134,255]];
    const weights=[r,y,b], total=weights.reduce((a,x)=>a+x,0); if(!total)return '#fff';
    const strength=Math.min(1,Math.max(...weights)*.85+total*.15);
    const target=[0,1,2].map(ch=>weights.reduce((sum,w,i)=>sum+pigments[i][ch]*w,0)/total);
    const out=target.map((v,i)=>Math.round(base[i]*(1-strength)+v*strength));
    return `rgb(${out.join(',')})`;
  }

  // Picture Lab -------------------------------------------------------------

  const WONDER_BACKEND_URL='https://script.google.com/macros/s/AKfycbwZh5_GFoCC8TcJ6wgpI1ZAoRCKjJ7rJaNlG5bFcFSfljuhZxzpGT6sPselshwbUvBndQ/exec';
  let wonderJsonpCounter=0;

  function wonderBackend(action,params={}){
    const callbackName=`__wonderTabletJsonp${++wonderJsonpCounter}`;
    const url=new URL(WONDER_BACKEND_URL);
    url.searchParams.set('action',action);url.searchParams.set('callback',callbackName);
    Object.entries(params).forEach(([key,value])=>{if(value!==undefined&&value!==null)url.searchParams.set(key,String(value))});
    return new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      const timeout=setTimeout(()=>{cleanup();reject(new Error('Wonder Lab backend request timed out.'))},30000);
      const cleanup=()=>{clearTimeout(timeout);script.remove();try{delete window[callbackName]}catch{window[callbackName]=undefined}};
      window[callbackName]=result=>{cleanup();if(result?.ok)resolve(result.payload);else reject(new Error(result?.error||'Wonder Lab backend error.'))};
      script.onerror=()=>{cleanup();reject(new Error('Could not reach the Wonder Lab backend.'))};
      script.src=url.toString();document.head.appendChild(script);
    });
  }

  function tabletRequestId(){
    const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);
    return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  }

  async function sendTabletCommand(action,fields={}){
    if(!state.device.deviceToken)throw new Error('Pair this tablet with the Companion first.');
    if(!navigator.onLine)throw new Error('Waiting for internet.');
    const requestId=tabletRequestId();
    const body=new URLSearchParams({wlDeviceAction:action,requestId,deviceToken:state.device.deviceToken});
    Object.entries(fields).forEach(([key,value])=>body.set(key,String(value)));
    await fetch(WONDER_BACKEND_URL,{method:'POST',mode:'no-cors',body});
    const deadline=Date.now()+45000;
    while(Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,700));
      const result=await wonderBackend('claimDeviceCommandResult',{requestId,deviceToken:state.device.deviceToken});
      if(result.status==='complete')return result.payload;
    }
    throw new Error('Tablet sync timed out. It may still have completed.');
  }

  function devicePairingStatusText(){
    if(!state.device.deviceToken)return 'Not paired';
    if(state.device.lastError)return `Paired · ${state.device.lastError}`;
    if(state.device.lastSyncAt)return `Paired · synced ${new Date(state.device.lastSyncAt).toLocaleString()}`;
    return 'Paired · waiting for first sync';
  }

  async function pairDeviceWithCode(code){
    if(!navigator.onLine)throw new Error('Connect to Wi-Fi before pairing.');
    const result=await wonderBackend('claimPairingCode',{code,deviceName:'Roscoe’s Wonder Lab Tablet'});
    state.device={...state.device,deviceId:result.deviceId,deviceName:result.deviceName,deviceToken:result.deviceToken,pairedAt:result.pairedAt,lastError:null};
    await save('device');
    await syncPictureLibraryFromBackend(true);
    await syncDrawingQueue(false);
    await syncWonderLog(false);
    return result;
  }

  async function syncPictureLibraryFromBackend(showMessage=false){
    if(!state.device.deviceToken||!navigator.onLine)return false;
    try{
      const result=await wonderBackend('devicePictures',{deviceToken:state.device.deviceToken});
      const pictures=(result.pictures||[]).slice(0,8).map(item=>({pictureId:String(item.pictureId),label:String(item.label||'PICTURE').toUpperCase(),thumbnailDataUrl:String(item.thumbnailDataUrl||''),imageDataUrl:String(item.thumbnailDataUrl||''),updatedAt:String(item.updatedAt||'')})).filter(item=>item.pictureId&&item.thumbnailDataUrl);
      localStorage.setItem(PICTURE_LIBRARY_KEY,JSON.stringify(pictures));
      window.WONDER_LAB_PICTURE_LIBRARY=pictures;
      state.device.lastSyncAt=result.syncedAt||nowISO();state.device.lastError=null;await save('device');
      if(state.currentScreen==='pictureLab')renderPictureLab();
      if(showMessage)toast(`${pictures.length} picture${pictures.length===1?'':'s'} synced`);
      return true;
    }catch(error){
      state.device.lastError=error.message||'Picture sync failed';await save('device');
      if(showMessage)toast(state.device.lastError);
      return false;
    }
  }

  function openDevicePairing(){
    const bg=document.createElement('div');bg.className='modal-backdrop';bg.innerHTML=`<div class="modal"><h2>Pair this tablet</h2>
      <div class="companion-qr-card pairing-qr-card">
        <a href="${COMPANION_URL}" target="_blank" rel="noopener" aria-label="Open Wonder Lab Companion"><img src="./assets/companion-qr.png" alt="QR code for Wonder Lab Companion"></a>
        <div><strong>Open the Companion</strong><br><span class="small-note">Scan with a phone, then open <strong>Pairing</strong> and generate a code.</span><br><a class="companion-url" href="${COMPANION_URL}" target="_blank" rel="noopener">wonderlab-companion.nickspeelman.com</a></div>
      </div>
      <p>Enter the 8-digit pairing code:</p><input id="pairCode" inputmode="numeric" autocomplete="one-time-code" maxlength="9" placeholder="1234 5678"><p class="small-note" id="pairStatus">${escapeHtml(devicePairingStatusText())}</p><div class="modal-actions"><button class="adult-btn" id="cancelPair">Cancel</button><button class="adult-btn primary" id="confirmPair">Pair device</button></div></div>`;document.body.appendChild(bg);
    const input=bg.querySelector('#pairCode'),status=bg.querySelector('#pairStatus'),confirm=bg.querySelector('#confirmPair');
    const close=()=>bg.remove();bg.onclick=e=>{if(e.target===bg)close()};bg.querySelector('#cancelPair').onclick=close;
    input.oninput=()=>{const digits=input.value.replace(/\D/g,'').slice(0,8);input.value=digits.length>4?digits.slice(0,4)+' '+digits.slice(4):digits};
    confirm.onclick=async()=>{confirm.disabled=true;status.textContent='Pairing…';try{await pairDeviceWithCode(input.value);status.textContent='Paired and synced.';setTimeout(close,650)}catch(error){status.textContent=error.message;confirm.disabled=false}};
    input.focus();
  }

  const PICTURE_MIN_SCALE=.64;
  const PICTURE_MAX_SCALE=1.60;
  const PICTURE_SCALE_STEP=.16;
  const PICTURE_BIG_AT=1.20;
  const PICTURE_SMALL_AT=.80;
  const PICTURE_BASE_RADIUS=48;
  const PICTURE_HIT_SLOP=24;
  const PICTURE_HOLD_DELAY=440;
  const PICTURE_HOLD_TICK=85;
  const PICTURE_TAP_MOVE=14;
  const PICTURE_LIBRARY_KEY='wonderLabPictureLibrary';

  function pictureLibrary(){
    const source=Array.isArray(window.WONDER_LAB_PICTURE_LIBRARY)?window.WONDER_LAB_PICTURE_LIBRARY:(()=>{try{return JSON.parse(localStorage.getItem(PICTURE_LIBRARY_KEY)||'[]')}catch{return []}})();
    if(!Array.isArray(source))return [];
    return source.slice(0,8).map((item,i)=>({
      pictureId:String(item.pictureId||item.id||`picture-${i}`),
      label:String(item.label||'PICTURE').trim().toUpperCase(),
      src:item.imageDataUrl||item.thumbnailDataUrl||item.thumbnail||item.url||''
    })).filter(item=>item.src);
  }

  function renderPictureLab(){
    const library=pictureLibrary();
    const shelf=library.length?library.map(item=>`<button class="picture-source" data-picture-id="${escapeHtml(item.pictureId)}" aria-label="Add ${escapeHtml(item.label)}"><img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.label)}" draggable="false"></button>`).join(''):'<div class="picture-empty">No synced pictures yet.</div>';
    shell('Picture Lab',`<div class="activity-wrap"><div class="picture-lab"><div class="picture-playfield" id="picturePlayfield"><div class="picture-container" id="pictureContainer"><span class="picture-container-label">IN</span></div><span class="picture-out-label">OUT</span></div><aside class="picture-side"><div class="picture-shelf-title">PICTURES</div><div class="picture-shelf">${shelf}</div><div class="picture-size-controls"><button class="picture-size-btn" id="pictureMinus" aria-label="Make picture smaller">−</button><button class="picture-size-btn" id="picturePlus" aria-label="Make picture bigger">+</button></div><div class="picture-help" id="pictureHelp">Tap a picture to add it.</div></aside></div></div>`,true);
    const field=document.getElementById('picturePlayfield');
    document.querySelectorAll('.picture-source').forEach(btn=>btn.onclick=()=>{const item=library.find(x=>x.pictureId===btn.dataset.pictureId);if(item)spawnPicture(item)});
    document.getElementById('pictureMinus').onclick=()=>resizePicture(-PICTURE_SCALE_STEP);
    document.getElementById('picturePlus').onclick=()=>resizePicture(PICTURE_SCALE_STEP);
    field.onpointerdown=picturePointerDown;
    renderPictureInstances();
    activeCleanup=()=>save('pictureLab');
  }

  function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  const pictureClamp=(v,min,max)=>max<min?(min+max)/2:Math.max(min,Math.min(max,v));
  const pictureRound=v=>Math.round(v*1000)/1000;

  function spawnPicture(item){
    const field=document.getElementById('picturePlayfield'),box=document.getElementById('pictureContainer');if(!field||!box)return;
    const fr=field.getBoundingClientRect(),br=box.getBoundingClientRect(),n=state.pictureLab.instances.length;
    const instance={id:crypto.randomUUID(),pictureId:item.pictureId,label:item.label,src:item.src,x:br.left-fr.left+br.width/2+((n%3)-1)*Math.min(76,br.width*.18),y:br.top-fr.top+br.height/2+((Math.floor(n/3)%3)-1)*Math.min(58,br.height*.15),scale:1,containment:'in'};
    state.pictureLab.instances.push(instance);state.pictureLab.selectedId=instance.id;snapPicture(instance,'in');save('pictureLab');renderPictureInstances();speakPicture(instance);logEvent('pictureLab','picture_spawned',{pictureId:item.pictureId,label:item.label});
  }

  function renderPictureInstances(){
    const field=document.getElementById('picturePlayfield');if(!field)return;
    field.querySelectorAll('.picture-object').forEach(el=>el.remove());
    state.pictureLab.instances.forEach(item=>{const img=document.createElement('img');img.className='picture-object'+(item.id===state.pictureLab.selectedId?' selected':'');img.dataset.instanceId=item.id;img.src=item.src;img.alt=item.label;img.draggable=false;img.style.left=`${item.x}px`;img.style.top=`${item.y}px`;img.style.setProperty('--picture-scale',item.scale);field.appendChild(img)});
    updatePictureControls();
  }

  function selectedPicture(){return state.pictureLab.instances.find(x=>x.id===state.pictureLab.selectedId)||null}
  function selectPicture(item){state.pictureLab.selectedId=item.id;document.querySelectorAll('.picture-object').forEach(el=>el.classList.toggle('selected',el.dataset.instanceId===item.id));save('pictureLab');updatePictureControls()}

  function resizePicture(delta){
    const item=selectedPicture();if(!item)return;
    item.scale=pictureClamp(pictureRound(item.scale+delta),PICTURE_MIN_SCALE,PICTURE_MAX_SCALE);snapPicture(item,item.containment);syncPictureElement(item);save('pictureLab');updatePictureControls();speakPicture(item);logEvent('pictureLab','picture_resized',{label:item.label,scale:item.scale});
  }

  function updatePictureControls(){
    const minus=document.getElementById('pictureMinus'),plus=document.getElementById('picturePlus'),help=document.getElementById('pictureHelp');if(!minus||!plus)return;
    const item=selectedPicture();minus.disabled=!item||item.scale<=PICTURE_MIN_SCALE+.001;plus.disabled=!item||item.scale>=PICTURE_MAX_SCALE-.001;
    if(help)help.textContent=item?`${pictureSizeWord(item)} ${item.label} • ${item.containment.toUpperCase()}`.trim():'Tap a picture to add it.';
  }

  function pictureSizeWord(item){return item.scale>=PICTURE_BIG_AT?'BIG':item.scale<=PICTURE_SMALL_AT?'SMALL':''}
  function speakPicture(item){const words=[pictureSizeWord(item).toLowerCase(),String(item.label||'picture').toLowerCase(),item.containment==='in'?'in':'out'].filter(Boolean);speak(words.join(' '));updatePictureControls()}

  function pictureHit(clientX,clientY){
    const field=document.getElementById('picturePlayfield');if(!field)return null;const r=field.getBoundingClientRect(),x=clientX-r.left,y=clientY-r.top;
    for(const slop of [0,PICTURE_HIT_SLOP]){let best=null,bestD=Infinity;for(const item of [...state.pictureLab.instances].reverse()){const d=Math.hypot(x-item.x,y-item.y),radius=PICTURE_BASE_RADIUS*item.scale+slop;if(d<=radius&&d<bestD){best=item;bestD=d}}if(best)return best}return null;
  }

  function picturePointerDown(e){
    const item=pictureHit(e.clientX,e.clientY);if(!item)return;e.preventDefault();selectPicture(item);
    const field=document.getElementById('picturePlayfield'),el=field.querySelector(`[data-instance-id="${CSS.escape(item.id)}"]`),fr=field.getBoundingClientRect();if(!el)return;
    const start={id:e.pointerId,x:e.clientX,y:e.clientY,itemX:item.x,itemY:item.y,moved:false,holding:false,direction:1,timer:null,interval:null};el.classList.add('dragging');field.setPointerCapture?.(e.pointerId);
    start.timer=setTimeout(()=>{if(start.moved)return;start.holding=true;start.interval=setInterval(()=>{item.scale=pictureRound(item.scale+.045*start.direction);if(item.scale>=PICTURE_MAX_SCALE){item.scale=PICTURE_MAX_SCALE;start.direction=-1}else if(item.scale<=PICTURE_MIN_SCALE){item.scale=PICTURE_MIN_SCALE;start.direction=1}el.style.setProperty('--picture-scale',item.scale);updatePictureControls()},PICTURE_HOLD_TICK)},PICTURE_HOLD_DELAY);
    const move=ev=>{if(ev.pointerId!==start.id)return;const dx=ev.clientX-start.x,dy=ev.clientY-start.y;if(!start.moved&&Math.hypot(dx,dy)>PICTURE_TAP_MOVE){start.moved=true;clearTimeout(start.timer)}if(start.holding)return;item.x=pictureClamp(start.itemX+dx,0,fr.width);item.y=pictureClamp(start.itemY+dy,0,fr.height);el.style.left=`${item.x}px`;el.style.top=`${item.y}px`};
    const finish=ev=>{if(ev.pointerId!==start.id)return;clearTimeout(start.timer);clearInterval(start.interval);field.removeEventListener('pointermove',move);field.removeEventListener('pointerup',finish);field.removeEventListener('pointercancel',finish);el.classList.remove('dragging');if(start.holding){snapPicture(item,item.containment);syncPictureElement(item);save('pictureLab');speakPicture(item);return}if(!start.moved){speakPicture(item);return}resolvePictureContainment(item);syncPictureElement(item);save('pictureLab');speakPicture(item);logEvent('pictureLab','picture_moved',{label:item.label,containment:item.containment})};
    field.addEventListener('pointermove',move);field.addEventListener('pointerup',finish);field.addEventListener('pointercancel',finish);
  }

  function resolvePictureContainment(item){
    const field=document.getElementById('picturePlayfield'),box=document.getElementById('pictureContainer');if(!field||!box)return;const fr=field.getBoundingClientRect(),br=box.getBoundingClientRect(),bx=br.left-fr.left,by=br.top-fr.top,r=PICTURE_BASE_RADIUS*item.scale,enter=Math.min(36,r*.45),exit=Math.min(34,r*.38);let target=item.containment;
    if(item.containment==='out'){if(item.x>bx+enter&&item.x<bx+br.width-enter&&item.y>by+enter&&item.y<by+br.height-enter)target='in'}else if(item.x<bx-exit||item.x>bx+br.width+exit||item.y<by-exit||item.y>by+br.height+exit)target='out';
    snapPicture(item,target);
  }

  function snapPicture(item,target){
    const field=document.getElementById('picturePlayfield'),box=document.getElementById('pictureContainer');if(!field||!box)return;const fr=field.getBoundingClientRect(),br=box.getBoundingClientRect(),bx=br.left-fr.left,by=br.top-fr.top,r=PICTURE_BASE_RADIUS*item.scale,gap=8;
    if(target==='in'){item.containment='in';item.x=pictureClamp(item.x,bx+r+gap,bx+br.width-r-gap);item.y=pictureClamp(item.y,by+r+gap,by+br.height-r-gap);return}
    item.containment='out';const sides=[['left',Math.abs(item.x-bx)],['right',Math.abs(item.x-(bx+br.width))],['top',Math.abs(item.y-by)],['bottom',Math.abs(item.y-(by+br.height))]].sort((a,b)=>a[1]-b[1]);
    for(const [side] of sides){let x=item.x,y=item.y;if(side==='left')x=bx-r-gap;if(side==='right')x=bx+br.width+r+gap;if(side==='top')y=by-r-gap;if(side==='bottom')y=by+br.height+r+gap;x=pictureClamp(x,r+4,fr.width-r-4);y=pictureClamp(y,r+4,fr.height-r-4);const overlaps=x+r>bx&&x-r<bx+br.width&&y+r>by&&y-r<by+br.height;if(!overlaps){item.x=x;item.y=y;return}}
  }

  function syncPictureElement(item){const el=document.querySelector(`.picture-object[data-instance-id="${CSS.escape(item.id)}"]`);if(!el)return;el.style.left=`${item.x}px`;el.style.top=`${item.y}px`;el.style.setProperty('--picture-scale',item.scale)}

  window.WonderLabPictureLab=Object.freeze({setLibrary(pictures){const normalized=(Array.isArray(pictures)?pictures:[]).slice(0,8);try{localStorage.setItem(PICTURE_LIBRARY_KEY,JSON.stringify(normalized))}catch{}window.WONDER_LAB_PICTURE_LIBRARY=normalized;if(state.currentScreen==='pictureLab')renderPictureLab()},clear(){state.pictureLab=clone(defaults.pictureLab);save('pictureLab');if(state.currentScreen==='pictureLab')renderPictureLab()}});

  // Time Lab ---------------------------------------------------------------
  const TIME_STEPS={minute:60000,hour:3600000,day:86400000};
  const TIME_STEP_LABELS={minute:'MINUTE',hour:'HOUR',day:'DAY',month:'MONTH'};
  const MOON_PHASES=['🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘'];

  function timeLabDate(){
    if(!Number.isFinite(state.timeLab?.timestamp)) state.timeLab.timestamp=Date.now();
    return new Date(state.timeLab.timestamp);
  }

  function renderTimeLab(){
    state.timeLab={...defaults.timeLab,...(state.timeLab||{})};
    if(!Number.isFinite(state.timeLab.timestamp)) state.timeLab.timestamp=Date.now();
    const leaves=Array.from({length:28},(_,i)=>`<span class="time-leaf leaf-${i+1}"></span>`).join('');
    const stars=Array.from({length:18},(_,i)=>`<span class="time-star star-${i+1}">✦</span>`).join('');
    const numbers=Array.from({length:12},(_,i)=>`<span class="clock-number n${i+1}">${i+1}</span>`).join('');
    shell('Time Lab',`<div class="activity-wrap"><div class="time-lab">
      <section class="time-world" id="timeWorld" aria-label="Time landscape">
        <div class="time-sky" id="timeSky"></div>${stars}
        <div class="time-sun" id="timeSun">☀️</div><div class="time-moon" id="timeMoon">🌕</div>
        <div class="holiday-rainbow" id="holidayRainbow"></div>
        <div class="time-cloud cloud-a">☁️</div><div class="time-cloud cloud-b">☁️</div>
        <div class="time-birds" id="timeBirds">⌁⌁</div>
        <div class="time-shooting-star" id="shootingStar">✦</div>
        <div class="time-santa" id="timeSanta">🛷</div>
        <div class="time-hearts" id="timeHearts">❤️　💗　❤️</div>
        <div class="time-fireworks" id="timeFireworks">🎆　🎇</div>
        <div class="time-ground" id="timeGround"></div>
        <div class="time-tree" id="timeTree"><div class="tree-trunk"></div><div class="tree-crown">${leaves}</div><div class="tree-owl" id="treeOwl">🦉</div></div>
        <div class="time-rooster" id="timeRooster">🐓</div>
        <div class="time-pumpkins" id="timePumpkins">🎃　🎃</div>
        <div class="time-tricksters" id="timeTricksters">🧙　🦸　👻</div>
        <div class="time-presents" id="timePresents">🎁　🎁</div>
      </section>
      <section class="time-console">
        <div class="analog-clock" id="analogClock" aria-label="Analog clock">
          ${numbers}<div class="clock-center"></div>
          <div class="clock-hand hour-hand" id="hourHand"><span></span></div>
          <div class="clock-hand minute-hand" id="minuteHand"><span></span></div>
        </div>
        <div class="time-readouts">
          <div class="digital-time" id="digitalTime">12:00 PM</div>
          <div class="calendar-card"><div class="calendar-month" id="calendarMonth">JANUARY</div><div class="calendar-day" id="calendarDay">1</div><div class="calendar-weekday" id="calendarWeekday">MONDAY</div></div>
        </div>
        <div class="time-stepper">
          <button class="time-jump" id="timeMinus" aria-label="Move backward">−</button>
          <button class="time-step" id="timeStep" aria-label="Change time step"><span id="timeStepIcon">🕐</span><strong id="timeStepLabel">HOUR</strong></button>
          <button class="time-jump" id="timePlus" aria-label="Move forward">+</button>
        </div>
      </section>
    </div></div>`,true);

    const clock=document.getElementById('analogClock');
    document.getElementById('timeMinus').onclick=()=>advanceTime(-1);
    document.getElementById('timePlus').onclick=()=>advanceTime(1);
    document.getElementById('timeStep').onclick=()=>cycleTimeStep();
    bindClockHand(document.getElementById('minuteHand'),'minute',clock);
    bindClockHand(document.getElementById('hourHand'),'hour',clock);
    updateTimeLab(true);
    activeCleanup=()=>{stopLoop('time:crickets');save('timeLab');};
  }

  function cycleTimeStep(){
    const order=['minute','hour','day','month'];
    const idx=order.indexOf(state.timeLab.step);
    state.timeLab.step=order[(idx+1+order.length)%order.length];
    save('timeLab');updateTimeLab(true);
    logEvent('timeLab','step_changed',{step:state.timeLab.step});
  }

  function advanceTime(direction){
    const old=timeLabDate();
    const next=new Date(old);
    if(state.timeLab.step==='month'){
      const wantedDay=next.getDate();next.setDate(1);next.setMonth(next.getMonth()+direction);
      const lastDay=new Date(next.getFullYear(),next.getMonth()+1,0).getDate();next.setDate(Math.min(wantedDay,lastDay));
    } else next.setTime(next.getTime()+direction*TIME_STEPS[state.timeLab.step]);
    setTimeLabDate(next,old,'button');
  }

  function setTimeLabDate(next,previous=null,source='clock'){
    const old=previous||timeLabDate();
    state.timeLab.timestamp=next.getTime();
    updateTimeLab();
    playTimeTransitions(old,next,false,{source,step:state.timeLab.step});
    save('timeLab');
    logEvent('timeLab','time_changed',{source,step:state.timeLab.step,direction:Math.sign(next-old),timestamp:next.toISOString()});
  }

  function bindClockHand(hand,type,clock){
    let dragging=false,lastAngle=0,pendingMinutes=0;
    const angleFor=e=>{const r=clock.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;return Math.atan2(e.clientY-cy,e.clientX-cx);};
    hand.addEventListener('pointerdown',e=>{dragging=true;lastAngle=angleFor(e);pendingMinutes=0;hand.setPointerCapture(e.pointerId);e.preventDefault();});
    hand.addEventListener('pointermove',e=>{
      if(!dragging)return;
      const angle=angleFor(e);let delta=angle-lastAngle;
      if(delta>Math.PI)delta-=Math.PI*2;if(delta<-Math.PI)delta+=Math.PI*2;
      lastAngle=angle;
      pendingMinutes+=delta/(Math.PI*2)*(type==='minute'?60:720);
      const whole=pendingMinutes<0?Math.ceil(pendingMinutes):Math.floor(pendingMinutes);
      if(whole){const old=timeLabDate(),next=new Date(old.getTime()+whole*60000);pendingMinutes-=whole;state.timeLab.timestamp=next.getTime();updateTimeLab();playTimeTransitions(old,next,true,{source:'drag',step:type});}
      e.preventDefault();
    });
    const finish=()=>{if(!dragging)return;dragging=false;save('timeLab');logEvent('timeLab','clock_hand_dragged',{hand:type,timestamp:timeLabDate().toISOString()});};
    hand.addEventListener('pointerup',finish);hand.addEventListener('pointercancel',finish);
  }

  function updateTimeLab(silent=false){
    const d=timeLabDate(),h=d.getHours()+d.getMinutes()/60,month=d.getMonth(),day=d.getDate();
    const digital=document.getElementById('digitalTime');if(!digital)return;
    digital.textContent=d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
    document.getElementById('calendarMonth').textContent=d.toLocaleDateString([], {month:'long'}).toUpperCase();
    document.getElementById('calendarDay').textContent=day;
    document.getElementById('calendarWeekday').textContent=d.toLocaleDateString([], {weekday:'long'}).toUpperCase();
    const minuteAngle=d.getMinutes()*6+d.getSeconds()*.1;
    const hourAngle=(d.getHours()%12)*30+d.getMinutes()*.5;
    document.getElementById('minuteHand').style.transform=`rotate(${minuteAngle}deg)`;
    document.getElementById('hourHand').style.transform=`rotate(${hourAngle}deg)`;
    const icons={minute:'⏱️',hour:'🕐',day:'☀️',month:'📅'};
    document.getElementById('timeStepIcon').textContent=icons[state.timeLab.step]||'🕐';
    document.getElementById('timeStepLabel').textContent=TIME_STEP_LABELS[state.timeLab.step]||'HOUR';

    const world=document.getElementById('timeWorld');
    world.style.setProperty('--daylight',daylightAmount(h));
    world.style.setProperty('--season',seasonProgress(d));
    const sun=document.getElementById('timeSun'),moon=document.getElementById('timeMoon');
    positionCelestial(sun,(h-6)/12,h>=5.5&&h<=18.5);
    // The moon's night arc runs east -> west from 6 PM to 6 AM. Keep it
    // below the horizon through sunset so the pre-6 PM branch cannot clamp
    // it onto the western horizon beside the setting sun.
    const moonProgress=h>=18?(h-18)/12:(h+6)/12;
    positionCelestial(moon,moonProgress,h>=18.75||h<=6.25);
    moon.textContent=MOON_PHASES[moonPhaseIndex(d)];

    const s=seasonInfo(d);world.dataset.season=s.name;
    world.style.setProperty('--leaf-opacity',s.leafOpacity);
    world.style.setProperty('--leaf-hue',s.leafHue);
    world.style.setProperty('--snow-opacity',s.snowOpacity);
    document.getElementById('timeBirds').classList.toggle('show',h>=7&&h<17&&s.name!=='winter');
    document.getElementById('timeRooster').classList.toggle('show',h>=5.75&&h<7);
    document.getElementById('treeOwl').classList.toggle('show',h>=20.5||h<1);
    document.getElementById('shootingStar').classList.toggle('show',h>=0&&h<.35);

    const halloween=month===9&&day===31;
    document.getElementById('timePumpkins').classList.toggle('show',halloween);
    document.getElementById('timeTricksters').classList.toggle('show',halloween&&h>=17.5&&h<21.5);
    document.getElementById('timeSanta').classList.toggle('show',month===11&&day===24&&(h>=19||h<1));
    document.getElementById('timePresents').classList.toggle('show',month===11&&day===25);
    document.getElementById('timeFireworks').classList.toggle('show',(month===0&&day===1&&h<1)||(month===11&&day===31&&h>=23.8));
    document.getElementById('timeHearts').classList.toggle('show',month===1&&day===14);
    document.getElementById('holidayRainbow').classList.toggle('show',month===2&&day===17&&h>=8&&h<18);

    if(state.preferences.soundEffects&&(h>=18.5||h<5.5))startLoop('time:crickets',AUDIO_FILES.time.crickets); else stopLoop('time:crickets');
    if(!silent) document.getElementById('timeWorld')?.classList.add('time-shift');
    clearTimeout(updateTimeLab.shiftTimer);updateTimeLab.shiftTimer=setTimeout(()=>document.getElementById('timeWorld')?.classList.remove('time-shift'),180);
  }

  function daylightAmount(h){
    if(h>=7&&h<=17)return 1;
    if(h<5||h>19)return 0;
    if(h<7)return (h-5)/2;
    return (19-h)/2;
  }

  function positionCelestial(el,p,visible){
    if(!el)return;p=Math.max(0,Math.min(1,p));
    const x=5+p*90,y=72-Math.sin(p*Math.PI)*58;
    el.style.left=`${x}%`;el.style.top=`${y}%`;el.classList.toggle('show',visible);
  }

  function moonPhaseIndex(d){
    const knownNew=Date.UTC(2000,0,6,18,14),cycle=29.530588853*86400000;
    const phase=((d.getTime()-knownNew)%cycle+cycle)%cycle/cycle;
    return Math.floor((phase*8)+.5)%8;
  }

  function seasonProgress(d){return (Date.UTC(2000,d.getMonth(),d.getDate())-Date.UTC(2000,0,1))/(366*86400000);}
  function seasonInfo(d){
    const m=d.getMonth()+d.getDate()/31;
    if(m<2||m>=11)return {name:'winter',leafOpacity:0,leafHue:95,snowOpacity:.82};
    if(m<5)return {name:'spring',leafOpacity:Math.min(1,(m-2)/1.7),leafHue:105,snowOpacity:Math.max(0,.6-(m-2)*.8)};
    if(m<8)return {name:'summer',leafOpacity:1,leafHue:112,snowOpacity:0};
    if(m<10)return {name:'autumn',leafOpacity:Math.max(.15,1-(m-8)*.28),leafHue:Math.max(10,75-(m-8)*34),snowOpacity:0};
    return {name:'late-autumn',leafOpacity:Math.max(0,.55-(m-10)*.65),leafHue:18,snowOpacity:Math.max(0,(m-10.7)*1.5)};
  }

  function crossedHour(a,b,hour){
    const lo=Math.min(a.getTime(),b.getTime()),hi=Math.max(a.getTime(),b.getTime());
    const start=new Date(lo);start.setMinutes(0,0,0);start.setHours(hour);
    if(start.getTime()<=lo)start.setDate(start.getDate()+1);
    return start.getTime()<=hi;
  }

  function crossedNewYear(a,b){
    const lo=Math.min(a,b),hi=Math.max(a,b),y0=new Date(lo).getFullYear(),y1=new Date(hi).getFullYear();
    for(let y=y0;y<=y1+1;y++){const t=new Date(y,0,1,0,0,0,0).getTime();if(t>lo&&t<=hi)return true;}return false;
  }

  function playTimeTransitions(oldD,newD,duringDrag=false,context={}){
    const span=Math.abs(newD-oldD);
    const source=context.source||'clock';
    const step=context.step||state.timeLab.step;

    // Day/month jump buttons are calendar navigation, not a fast-forward through
    // every hour in between. Update the world to the destination silently so a
    // +DAY click doesn't crow, chime, hoot, etc. all at once.
    if(source==='button'&&(step==='day'||step==='month'))return;

    // Fine clock manipulation may legitimately cross daily landmarks, but cap
    // absurd jumps so a single gesture can never dump days of queued sounds.
    if(span>18*60*60*1000)return;

    if(crossedHour(oldD,newD,6))playNamed('time','rooster',.75);
    if(crossedHour(oldD,newD,8))playNamed('time','birds',.42);
    if(crossedHour(oldD,newD,12))playNamed('time','bell',.6);
    if(crossedHour(oldD,newD,21))playNamed('time','owl',.55);
    if(crossedHour(oldD,newD,0))playNamed('time','shootingStar',.4);
    if(crossedNewYear(oldD,newD))playNamed('time','fireworks',.7);

    const n=newD,month=n.getMonth(),day=n.getDate(),h=n.getHours();
    if(!duringDrag&&oldD.getMonth()!==11&&month===11)playNamed('time','winterWind',.35);
    if(month===9&&day===31&&h>=17&&h<=21)playNamed('time','trickOrTreat',.48);
    if(month===11&&day===24&&h>=19)playNamed('time','sleighBells',.62);
    if(step==='minute'&&!duringDrag)playNamed('time','tick',.35);
  }


  function renderColorLight(){
    const spotColors={red:[230,57,70],yellow:[255,210,63],blue:[58,134,255],white:[255,255,255]};
    const spotOrder=['red','yellow','blue','white'];
    state.colorLight.spot={...defaults.colorLight.spot,...(state.colorLight.spot||{})};
    shell('Color Lab',`<div class="activity-wrap"><div class="color-lab"><div class="color-controls"><button class="color-btn red" data-c="0"><span class="level-number">0</span><span class="level-dots"></span></button><button class="color-btn yellow" data-c="1"><span class="level-number">0</span><span class="level-dots"></span></button><button class="color-btn blue" data-c="2"><span class="level-number">0</span><span class="level-dots"></span></button><button class="spot-color-btn" id="spotColor" aria-label="Change spotlight color"><span class="spot-lens"></span></button><button class="light-btn brightness-btn" id="brightness" aria-label="Brightness"><span class="brightness-icon">☀️</span><span class="level-number">3</span><span class="level-dots"></span></button></div><div class="color-stage" id="colorStage"><div class="spotlight" id="spot"></div></div></div></div>`,true);
    const stage=document.getElementById('colorStage'),spot=document.getElementById('spot'),spotColorBtn=document.getElementById('spotColor');
    const update=()=>{
      stage.style.background=mixedColor(state.colorLight.levels);
      const brightness=.35+(state.colorLight.brightnessLevel/5)*1.15;
      stage.style.filter=`brightness(${brightness})`;
      spot.style.left=`${state.colorLight.spot.x*100}%`;
      spot.style.top=`${state.colorLight.spot.y*100}%`;
      const name=state.colorLight.spot.color||'red',rgb=spotColors[name];
      spot.style.setProperty('--spot-rgb',rgb.join(','));
      spot.classList.toggle('white-spot',name==='white');
      spotColorBtn.style.setProperty('--spot-button-color',`rgb(${rgb.join(',')})`);
      spotColorBtn.setAttribute('aria-label',`${name} spotlight`);
      document.querySelectorAll('.color-btn').forEach(b=>{const n=state.colorLight.levels[+b.dataset.c];b.querySelector('.level-number').textContent=n;b.querySelector('.level-dots').textContent='●'.repeat(n)+'○'.repeat(5-n);});
      const brightBtn=document.getElementById('brightness');
      if(brightBtn){const n=state.colorLight.brightnessLevel;brightBtn.querySelector('.level-number').textContent=n;brightBtn.querySelector('.level-dots').textContent='●'.repeat(n)+'○'.repeat(5-n);}
    };
    update();
    document.querySelectorAll('.color-btn').forEach(b=>b.onclick=()=>{ const c=+b.dataset.c; state.colorLight.levels[c]=(state.colorLight.levels[c]+1)%6; update(); save('colorLight'); logEvent('colorLight','color_added',{color:['red','yellow','blue'][c],level:state.colorLight.levels[c]}); speak(`${['Red','Yellow','Blue'][c]} ${state.colorLight.levels[c]}`); markMilestone('color-first','Changed the screen color','colorLight'); if(state.colorLight.levels.filter(x=>x>0).length>=2)markMilestone('color-mix','Mixed two colors','colorLight'); });
    spotColorBtn.onclick=()=>{ const current=spotOrder.indexOf(state.colorLight.spot.color||'red'); state.colorLight.spot.color=spotOrder[(current+1)%spotOrder.length]; update(); save('colorLight'); logEvent('colorLight','spotlight_color_changed',{color:state.colorLight.spot.color}); speak(`${state.colorLight.spot.color[0].toUpperCase()+state.colorLight.spot.color.slice(1)} spotlight`); };
    document.getElementById('brightness').onclick=()=>{ state.colorLight.brightnessLevel=(state.colorLight.brightnessLevel+1)%6; update();save('colorLight');logEvent('colorLight','brightness_changed',{level:state.colorLight.brightnessLevel});speak(`Brightness ${state.colorLight.brightnessLevel}`); };
    const moveSpot=e=>{ const r=stage.getBoundingClientRect(); state.colorLight.spot={...state.colorLight.spot,x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))}; update(); };
    stage.onpointerdown=e=>{ stage.setPointerCapture(e.pointerId); moveSpot(e); };
    stage.onpointermove=e=>{ if(stage.hasPointerCapture(e.pointerId)) moveSpot(e); };
    stage.onpointerup=e=>{ if(stage.hasPointerCapture(e.pointerId))stage.releasePointerCapture(e.pointerId); save('colorLight'); };
  }

  function renderDrawing(){
    const colors=['red','yellow','blue','black','white','rainbow'];
    const colorButtons=colors.map(c=>`<button class="paint-btn ${c} ${state.drawing.tool===c?'active':''}" data-tool="${c}">${c==='rainbow'?'🌈':''}</button>`).join('');
    shell('Art Lab',`<div class="activity-wrap"><div class="drawing-layout"><div class="drawing-tools"><div class="paint-grid">${colorButtons}</div><div class="brush-grid" aria-label="Brush sizes"><button class="brush-btn ${state.drawing.brushSize==='small'?'active':''}" data-size="small" aria-label="Small brush"><span class="brush-dot small"></span></button><button class="brush-btn ${state.drawing.brushSize==='medium'?'active':''}" data-size="medium" aria-label="Medium brush"><span class="brush-dot medium"></span></button><button class="brush-btn ${state.drawing.brushSize==='large'?'active':''}" data-size="large" aria-label="Large brush"><span class="brush-dot large"></span></button></div></div><div class="drawing-canvas-wrap"><canvas id="drawCanvas" class="draw-canvas"></canvas><button id="saveDrawing" class="art-save-btn" aria-label="Save drawing" title="Save drawing">★</button></div></div></div>`,true);
    const canvas=document.getElementById('drawCanvas'),ctx=canvas.getContext('2d',{willReadFrequently:true}); let tool=state.drawing.tool,drawing=false,last=null,hue=0,saveTimer;
    const widths={small:10,medium:22,large:44};
    const ink=()=>tool==='white'?'#fff':tool==='black'?'#111':tool==='rainbow'?`hsl(${hue},90%,55%)`:({red:COLORS[0],yellow:COLORS[1],blue:COLORS[2]})[tool];
    const resize=()=>{ const r=canvas.getBoundingClientRect(); canvas.width=Math.max(1,Math.floor(r.width*devicePixelRatio)); canvas.height=Math.max(1,Math.floor(r.height*devicePixelRatio)); ctx.scale(devicePixelRatio,devicePixelRatio); ctx.lineCap='round';ctx.lineJoin='round'; if(state.drawing.dataUrl){ const im=new Image(); im.onload=()=>ctx.drawImage(im,0,0,r.width,r.height); im.src=state.drawing.dataUrl; } };
    requestAnimationFrame(resize); window.addEventListener('resize',resize); activeCleanup=()=>window.removeEventListener('resize',resize);
    document.querySelectorAll('.paint-btn').forEach(b=>b.onclick=()=>{ tool=state.drawing.tool=b.dataset.tool; document.querySelectorAll('.paint-btn').forEach(x=>x.classList.toggle('active',x===b)); save('drawing'); logEvent('drawing','tool_selected',{tool}); speak(tool==='white'?'White':tool[0].toUpperCase()+tool.slice(1)); });
    document.querySelectorAll('.brush-btn').forEach(b=>b.onclick=()=>{state.drawing.brushSize=b.dataset.size;document.querySelectorAll('.brush-btn').forEach(x=>x.classList.toggle('active',x===b));save('drawing');speak(`${b.dataset.size} brush`);});
    document.getElementById('saveDrawing').onclick=async()=>{const button=document.getElementById('saveDrawing');button.disabled=true;try{await queueCurrentDrawing(true);button.classList.add('saved');setTimeout(()=>button?.classList.remove('saved'),700)}finally{if(button?.isConnected)button.disabled=false}};
    const point=e=>{ const r=canvas.getBoundingClientRect(); return {x:e.clientX-r.left,y:e.clientY-r.top}; };
    canvas.onpointerdown=e=>{drawing=true;last=point(e);canvas.setPointerCapture(e.pointerId);const w=widths[state.drawing.brushSize];ctx.beginPath();ctx.arc(last.x,last.y,w/2,0,Math.PI*2);ctx.fillStyle=ink();ctx.fill();};
    canvas.onpointermove=e=>{ if(!drawing)return; const p=point(e); if(tool==='rainbow')hue=(hue+4)%360;ctx.strokeStyle=ink();ctx.lineWidth=widths[state.drawing.brushSize];ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p;clearTimeout(saveTimer);saveTimer=setTimeout(saveDrawingState,350); };
    canvas.onpointerup=()=>{drawing=false;saveDrawingState();logEvent('drawing','stroke_completed',{tool,size:state.drawing.brushSize});}; canvas.onpointercancel=canvas.onpointerup;
  }

  async function saveDrawingState(){ const c=document.getElementById('drawCanvas'); if(!c)return; state.drawing.dataUrl=c.toDataURL('image/png'); await save('drawing'); }

  function renderPhysics(){
    const colors={red:'#e63946',yellow:'#ffd23f',blue:'#3a86ff'};
    const shapeButtons=['ball','block','stick'].map(type=>`<button data-add="${type}" aria-label="Add ${type}"><span class="motion-button-shape ${type}" style="--object-color:${colors[state.physics.selectedColor]}"></span></button>`).join('');
    const colorButtons=Object.entries(colors).map(([k,v])=>`<button class="motion-color ${state.physics.selectedColor===k?'active':''}" data-motion-color="${k}" style="--object-color:${v}" aria-label="${k}"></button>`).join('');
    shell('Motion Lab',`<div class="activity-wrap"><div class="motion-lab"><div class="physics-toolbar"><div class="motion-shape-row">${shapeButtons}<button id="removeMotion" aria-label="Remove last shape">−</button></div><div class="motion-color-row">${colorButtons}</div></div><div id="physicsStage" class="physics-stage"></div></div></div>`,true);
    const stage=document.getElementById('physicsStage'); const els=new Map(); const pairCollisionTimes=new Map(); let raf,last=performance.now();
    const drawObj=o=>{ const el=document.createElement('div'); el.className=`physics-object ${o.type}`; el.style.setProperty('--object-color',colors[o.color]||colors.red); stage.appendChild(el); els.set(o.id,el); bindPhysics(el,o); };
    state.physics.objects.forEach(drawObj);
    document.querySelectorAll('[data-motion-color]').forEach(b=>b.onclick=()=>{state.physics.selectedColor=b.dataset.motionColor;document.querySelectorAll('[data-motion-color]').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.motion-button-shape').forEach(x=>x.style.setProperty('--object-color',colors[state.physics.selectedColor]));save('physics');speak(b.dataset.motionColor);});
    document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{const type=b.dataset.add,color=state.physics.selectedColor,o={id:crypto.randomUUID(),type,color,x:.2+Math.random()*.6,y:.15,vx:(Math.random()-.5)*.3,vy:0,angle:0,omega:type==='stick'?(Math.random()-.5)*2.4:0};state.physics.objects.push(o);drawObj(o);save('physics');playNamed('motion','spawn',MIX.motion);speak(`${color} ${type} added`);});
    document.getElementById('removeMotion').onclick=()=>{const o=state.physics.objects.pop();if(o){els.get(o.id)?.remove();els.delete(o.id);save('physics');playNamed('motion','remove',MIX.motion);speak(`${o.color||''} ${o.type} removed`.trim());}};
    const collisionSound=(impact,pairKey)=>{ const now=performance.now();const lastPair=pairCollisionTimes.get(pairKey)||0;if(impact<.14||now-lastPair<150)return;pairCollisionTimes.set(pairKey,now);playNamed('motion','collision',Math.min(.50,.18+impact*.22)); };
    const bounceSound=impact=>{ const now=performance.now();if(impact<.28||now-lastBounceSoundAt<120)return;lastBounceSoundAt=now;playNamed('motion','bounce',Math.min(.40,.18+impact*.12)); };
    const collide=()=>{
      const a=state.physics.objects,r=stage.getBoundingClientRect();
      for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++){
        const p=a[i],q=a[j],dx=(q.x-p.x)*r.width,dy=(q.y-p.y)*r.height,d=Math.hypot(dx,dy);
        const radius=o=>o.type==='stick'?42:38;const minDistance=radius(p)+radius(q);if(d>0&&d<minDistance){const nx=dx/d,ny=dy/d,over=minDistance-d;p.x-=nx*(over/2)/r.width;p.y-=ny*(over/2)/r.height;q.x+=nx*(over/2)/r.width;q.y+=ny*(over/2)/r.height;const rel=((q.vx-p.vx)*r.width)*nx+((q.vy-p.vy)*r.height)*ny;if(rel<0){const normRel=rel/Math.max(r.width,r.height);const impact=-normRel;const imp=impact*.9;p.vx-=imp*nx;p.vy-=imp*ny;q.vx+=imp*nx;q.vy+=imp*ny;if(p.type==='stick')p.omega-=ny*imp*4;if(q.type==='stick')q.omega+=ny*imp*4;collisionSound(impact,[p.id,q.id].sort().join(':'));}}
      }
    };
    let tiltGravity={x:0,y:.75};
    const clampTilt=n=>Math.max(-1,Math.min(1,n));
    const deadZone=n=>Math.abs(n)<.06?0:n;
    const screenAngle=()=>{
      const angle=Number(screen.orientation?.angle);
      if(Number.isFinite(angle))return ((angle%360)+360)%360;
      const legacy=Number(window.orientation);
      return Number.isFinite(legacy)?((legacy%360)+360)%360:0;
    };
    const tilt=e=>{
      if(!state.preferences.tilt||e.beta==null||e.gamma==null)return;
      const beta=clampTilt(e.beta/35);
      const gamma=clampTilt(e.gamma/35);
      let x,y;
      switch(screenAngle()){
        case 90:
          // ChromeOS landscape-primary: lowering the right edge should move
          // objects right, and lowering the bottom edge should move them down.
          x=-beta;
          y=gamma;
          break;
        case 180:
          x=-gamma;
          y=-beta;
          break;
        case 270:
          x=beta;
          y=-gamma;
          break;
        default:
          x=gamma;
          y=beta;
      }
      // ChromeOS reports the vertical sensor axis opposite the visible
      // screen direction on this tablet, so invert only Y. Keep X unchanged.
      tiltGravity={x:deadZone(x)*.9,y:deadZone(-y)*.9};
    };
    window.addEventListener('deviceorientation',tilt);
    const tick=now=>{ const dt=Math.min(.03,(now-last)/1000);last=now; const r=stage.getBoundingClientRect();
      // Do not run physics until layout has produced a real canvas. Older builds
      // could divide by zero here and permanently save Infinity/NaN positions.
      if(r.width<100 || r.height<100){raf=requestAnimationFrame(tick);return;}
      let strongestWall=0; for(const o of state.physics.objects){ o.vx+=tiltGravity.x*dt;o.vy+=tiltGravity.y*dt;o.x+=o.vx*dt;o.y+=o.vy*dt;
        let halfX=38,halfY=38;
        if(o.type==='stick'){
          o.angle=(o.angle||0)+(o.omega||0)*dt;
          o.omega=(o.omega||0)*Math.pow(.985,dt*60);
          halfX=Math.abs(Math.cos(o.angle))*43+Math.abs(Math.sin(o.angle))*12;
          halfY=Math.abs(Math.sin(o.angle))*43+Math.abs(Math.cos(o.angle))*12;
        }
        const rx=halfX/r.width,ry=halfY/r.height;
        if(o.x<rx||o.x>1-rx){strongestWall=Math.max(strongestWall,Math.abs(o.vx));o.vx*=-.82;o.x=Math.max(rx,Math.min(1-rx,o.x));}
        if(o.y<ry){strongestWall=Math.max(strongestWall,Math.abs(o.vy));o.vy=Math.abs(o.vy);o.y=ry;}
        if(o.y>1-ry){
          strongestWall=Math.max(strongestWall,Math.abs(o.vy));o.vy=-Math.abs(o.vy)*.72;o.y=1-ry;
          if(Math.abs(o.vy)<.04)o.vy=0;
          if(o.type==='stick' && Math.abs(o.vx)<.12 && Math.abs(o.vy)<.08){
            const target=Math.round((o.angle||0)/Math.PI)*Math.PI;
            const delta=target-(o.angle||0);
            o.omega=(o.omega||0)*.72+delta*6*dt;
            o.angle=(o.angle||0)+delta*Math.min(1,8*dt);
            if(Math.abs(delta)<.018 && Math.abs(o.omega)<.08){o.angle=target;o.omega=0;}
          }
        }
      } bounceSound(strongestWall);collide();for(const o of state.physics.objects){const el=els.get(o.id);if(el){el.style.left=`calc(${o.x*100}% - ${o.type==='stick'?43:38}px)`;el.style.top=`calc(${o.y*100}% - ${o.type==='stick'?12:38}px)`;el.style.transform=o.type==='stick'?`rotate(${o.angle||0}rad)`:'';}}raf=requestAnimationFrame(tick); };
    raf=requestAnimationFrame(tick); const saveInt=setInterval(()=>save('physics'),1000); activeCleanup=()=>{cancelAnimationFrame(raf);clearInterval(saveInt);save('physics');window.removeEventListener('deviceorientation',tilt)};
    function bindPhysics(el,o){let drag=false,lastP=null,lastT=0;el.onpointerdown=e=>{drag=true;lastP={x:e.clientX,y:e.clientY};lastT=performance.now();el.setPointerCapture(e.pointerId);o.vx=o.vy=0;playNamed('motion','pickup',MIX.motion*.8);speak(`${o.color||''} ${o.type}`.trim());};el.onpointermove=e=>{if(!drag)return;const r=stage.getBoundingClientRect(),now=performance.now(),dt=Math.max(16,now-lastT);const dx=e.clientX-lastP.x,dy=e.clientY-lastP.y;o.vx=dx/r.width/(dt/1000);o.vy=dy/r.height/(dt/1000);if(o.type==='stick'&&Math.hypot(dx,dy)>1)o.omega+=(dx-dy)*.0025;o.x=(e.clientX-r.left)/r.width;o.y=(e.clientY-r.top)/r.height;lastP={x:e.clientX,y:e.clientY};lastT=now;};el.onpointerup=()=>{if(drag)playNamed('motion','drop',MIX.motion);drag=false;save('physics');};el.onpointercancel=el.onpointerup;}
  }

  async function resetCurrent(animate=false){
    const k=state.currentScreen; if(!defaults[k])return;
    if(animate){ const wrap=document.querySelector('.activity-wrap'); const broom=document.createElement('div'); broom.className='cleanup-broom'; broom.textContent='🧹'; wrap.appendChild(broom); await new Promise(r=>setTimeout(r,4800)); broom.remove(); }
    activeCleanup(); activeCleanup=()=>{};
    state[k]=clone(defaults[k]); await save(k); logEvent(k,'activity_reset',{by:'broom_or_parent'}); renderActivity(k);
  }

  function openParentGate(){
  const bg = document.createElement('div');
  bg.className = 'modal-backdrop';

  bg.innerHTML = `
    <div class="modal">
      <h2>Wonder Lab Settings</h2>
      <p>Type <strong>ENTER</strong> to continue.</p>
      <div class="companion-quick-qr">
        <a href="${COMPANION_URL}" target="_blank" rel="noopener" aria-label="Open Wonder Lab Companion"><img src="./assets/companion-qr.png" alt="QR code for Wonder Lab Companion"></a>
        <span><strong>Need the Companion?</strong><br><span class="small-note">Scan with a phone.</span></span>
      </div>

      <input
        id="gateInput"
        autocomplete="off"
        inputmode="text"
        aria-label="Type ENTER"
      >

      <div class="modal-actions">
        <button class="adult-btn" id="cancelGate">Cancel</button>
        <button class="adult-btn primary" id="enterGate">Continue</button>
      </div>
    </div>
  `;

  document.body.appendChild(bg);

  const input = bg.querySelector('#gateInput');
  input.focus();

  const close = () => bg.remove();

  bg.onclick = event => {
    if (event.target === bg) close();
  };

  bg.querySelector('#cancelGate').onclick = close;

  bg.querySelector('#enterGate').onclick = () => {
    if (input.value.trim().toUpperCase() === 'ENTER') {
      close();
      openParentControls();
    } else {
      input.value = '';
      input.placeholder = 'Please type ENTER';
    }
  };

  input.onkeydown = event => {
    if (event.key === 'Enter') {
      bg.querySelector('#enterGate').click();
    }
  };
}
  function companionSyncStatusText(){
    const drawingQueue=state.drawings?.queue?.length||0;
    const logPending=pendingWonderLogCount();
    if(!state.device.deviceToken)return 'Not paired yet';
    if(state.device.lastError)return state.device.lastError;
    if(state.drawings?.lastError&&drawingQueue)return state.drawings.lastError;
    if(state.analytics?.lastError&&logPending)return state.analytics.lastError;
    const pending=drawingQueue+logPending;
    if(pending)return `${pending} item${pending===1?'':'s'} waiting to sync`;
    const latest=[state.device.lastSyncAt,state.drawings?.lastSyncAt,state.analytics?.lastSyncAt].filter(Boolean).sort().at(-1);
    return latest?`Up to date · last synced ${new Date(latest).toLocaleString()}`:'Paired · automatic sync is on';
  }

  async function syncCompanionNow(showMessage=true){
    if(!state.device.deviceToken){if(showMessage)toast('Pair this tablet first');return false;}
    if(!navigator.onLine){if(showMessage)toast('Waiting for Wi-Fi');return false;}
    await Promise.allSettled([
      syncPictureLibraryFromBackend(false),
      syncDrawingQueue(false),
      syncWonderLog(false)
    ]);
    const failed=Boolean(state.device.lastError||state.drawings?.lastError||state.analytics?.lastError);
    if(showMessage)toast(failed?'Some Companion data could not sync':'Companion synced');
    return !failed;
  }

  function openParentControls(){
    const currentLab=activities.find(a=>a.id===state.currentScreen);
    const resetCurrentRow=currentLab?`<div class="settings-row"><span><strong>Reset ${escapeHtml(currentLab.label)}</strong><br><span class="small-note">Clears only this Lab.</span></span><button class="adult-btn" id="resetCurrent">Reset</button></div>`:'';
    const bg=document.createElement('div'); bg.className='modal-backdrop'; bg.innerHTML=`<div class="modal settings-modal"><h2>Wonder Lab Settings</h2><div class="settings-list">
      <section class="settings-section"><h3>Audio</h3>
        <div class="settings-row"><span><strong>Voice responses</strong><br><span class="small-note">Short spoken words describe Roscoe's actions.</span></span><button class="adult-btn" id="voiceBtn">${state.preferences.voiceResponses?'On':'Off'}</button></div>
        <div class="settings-row"><span><strong>Sound effects</strong><br><span class="small-note">Every Lab still works when these are off.</span></span><button class="adult-btn" id="effectsBtn">${state.preferences.soundEffects?'On':'Off'}</button></div>
        <div class="settings-row"><label for="volume"><strong>Audio volume</strong></label><input id="volume" type="range" min="0" max="1" step="0.05" value="${state.preferences.volume}"></div>
      </section>
      <section class="settings-section"><h3>Interaction</h3>
        <div class="settings-row"><span><strong>Tilt controls</strong><br><span class="small-note">Used by Motion Lab.</span></span><button class="adult-btn" id="tiltBtn">${state.preferences.tilt?'On':'Off'}</button></div>
      </section>
      <section class="settings-section companion-section"><h3>Companion</h3>
        <div class="companion-qr-card">
          <a href="${COMPANION_URL}" target="_blank" rel="noopener" aria-label="Open Wonder Lab Companion"><img src="./assets/companion-qr.png" alt="QR code for Wonder Lab Companion"></a>
          <div><strong>Pictures, drawings & Wonder Log</strong><br><span class="small-note">Scan this code with a phone to open the caregiver Companion.</span><br><a class="companion-url" href="${COMPANION_URL}" target="_blank" rel="noopener">wonderlab-companion.nickspeelman.com</a></div>
        </div>
        <div class="settings-row"><span><strong>Tablet pairing</strong><br><span class="small-note" id="pairingStatus">${devicePairingStatusText()}</span></span><button class="adult-btn" id="pairDevice">${state.device.deviceToken?'Pair again':'Pair tablet'}</button></div>
        <div class="settings-row"><span><strong>Sync Companion</strong><br><span class="small-note" id="companionSyncStatus">${companionSyncStatusText()}</span></span><button class="adult-btn" id="syncCompanion" ${state.device.deviceToken?'':'disabled'}>Sync now</button></div>
        <div class="settings-row"><span><strong>Wonder Log</strong><br><span class="small-note">Records play sessions and activity for the Companion.</span></span><button class="adult-btn" id="insightsBtn">${analyticsEnabled()?'On':'Off'}</button></div>
        <div class="settings-row"><span><strong>Clear tablet Wonder Log</strong><br><span class="small-note">Useful for testing or starting fresh. Synced Companion history is separate.</span></span><button class="adult-btn danger-soft" id="clearWonderLog">Clear</button></div>
      </section>
      <section class="settings-section"><h3>About</h3>
        <div class="settings-row version-row"><span><strong>Wonder Lab version</strong><br><span class="small-note">Confirms the tablet received the latest update.</span></span><strong id="buildVersionValue">${buildVersion}</strong></div>
      </section>
      <section class="settings-section reset-section"><h3>Reset</h3>
        ${resetCurrentRow}
        <div class="settings-row"><span><strong>Reset all Labs</strong><br><span class="small-note">Clears the activity state for every Lab.</span></span><button class="adult-btn danger" id="resetAll">Reset all</button></div>
      </section>
    </div><div class="modal-actions"><button class="adult-btn primary" id="doneSettings">Done</button></div></div>`;
    document.body.appendChild(bg); const close=()=>bg.remove(); bg.onclick=e=>{if(e.target===bg)close();}; bg.querySelector('#doneSettings').onclick=close;
    refreshBuildVersion().then(version=>{const el=bg.querySelector('#buildVersionValue');if(el)el.textContent=version;});
    bg.querySelector('#voiceBtn').onclick=async e=>{state.preferences.voiceResponses=!state.preferences.voiceResponses;e.target.textContent=state.preferences.voiceResponses?'On':'Off';await save('preferences');if(state.preferences.voiceResponses)speak('Voice responses on');};
    bg.querySelector('#effectsBtn').onclick=async e=>{state.preferences.soundEffects=!state.preferences.soundEffects;e.target.textContent=state.preferences.soundEffects?'On':'Off';await save('preferences');if(!state.preferences.soundEffects)stopAllLoops();else{if(state.currentScreen==='switchboard')syncSwitchSounds();playNamed('ui','click',MIX.ui);}};
    bg.querySelector('#volume').oninput=async e=>{state.preferences.volume=+e.target.value;updateLoopVolumes();await save('preferences');};
    bg.querySelector('#tiltBtn').onclick=async e=>{state.preferences.tilt=!state.preferences.tilt;e.target.textContent=state.preferences.tilt?'On':'Off';await save('preferences');};
    bg.querySelector('#insightsBtn').onclick=async e=>{const turningOn=!analyticsEnabled();if(!turningOn)endSession();state.preferences.usageInsights=turningOn;e.target.textContent=turningOn?'On':'Off';await save('preferences');if(turningOn)startSession();if(state.device.deviceToken&&navigator.onLine)syncWonderLog(false).catch(()=>{});};
    bg.querySelector('#clearWonderLog').onclick=()=>confirmClearWonderLog(bg);
    bg.querySelector('#syncCompanion').onclick=async()=>{const button=bg.querySelector('#syncCompanion'),status=bg.querySelector('#companionSyncStatus');button.disabled=true;status.textContent='Syncing pictures, drawings & Wonder Log…';await syncCompanionNow(true);status.textContent=companionSyncStatusText();button.disabled=!state.device.deviceToken;};
    bg.querySelector('#pairDevice').onclick=()=>{close();openDevicePairing();};
    const resetButton=bg.querySelector('#resetCurrent');if(resetButton)resetButton.onclick=async()=>{close();await resetCurrent(false);};
    bg.querySelector('#resetAll').onclick=()=>confirmResetAll(bg);
  }

  function confirmResetAll(parent){
    parent.remove(); const bg=document.createElement('div'); bg.className='modal-backdrop'; bg.innerHTML=`<div class="modal"><h2>Reset Everything?</h2><p>This clears every lab, including the current drawing. Type <strong>RESET</strong>.</p><input id="resetWord" autocomplete="off"><div class="modal-actions"><button class="adult-btn" id="cancel">Cancel</button><button class="adult-btn danger" id="confirm">Reset all</button></div></div>`; document.body.appendChild(bg);
    bg.querySelector('#cancel').onclick=()=>bg.remove(); bg.querySelector('#confirm').onclick=async()=>{ if(bg.querySelector('#resetWord').value.trim().toUpperCase()!=='RESET')return; for(const k of activities.map(a=>a.id)){state[k]=clone(defaults[k]);await save(k);} bg.remove();navigate('home');toast('All labs reset'); };
  }

  async function drawingThumbnailDataUrl(dataUrl){
    return new Promise((resolve,reject)=>{
      const image=new Image();
      image.onload=()=>{
        const size=260,canvas=document.createElement('canvas');canvas.width=size;canvas.height=size;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,size,size);
        const scale=Math.min(size/image.width,size/image.height);
        const w=image.width*scale,h=image.height*scale;
        ctx.drawImage(image,(size-w)/2,(size-h)/2,w,h);
        resolve(canvas.toDataURL('image/jpeg',.72));
      };
      image.onerror=()=>reject(new Error('Could not prepare the drawing preview.'));
      image.src=dataUrl;
    });
  }

  async function queueCurrentDrawing(trySync=false){
    if(state.currentScreen==='drawing')await saveDrawingState();
    if(!state.drawing.dataUrl){toast('Draw something first');return false;}
    const createdAt=nowISO();
    const stamp=createdAt.slice(0,19).replace(/[:T]/g,'-');
    const thumbnailDataUrl=await drawingThumbnailDataUrl(state.drawing.dataUrl);
    state.drawings.queue.push({
      id:crypto.randomUUID(),createdAt,
      fileName:`wonder-lab-drawing-${stamp}`,
      imageBase64:state.drawing.dataUrl.replace(/^data:image\/png;base64,/,''),
      thumbnailDataUrl,attempts:0,
    });
    state.drawings.lastError=navigator.onLine?(state.device.deviceToken?null:'Pair tablet to sync'):'Waiting for internet';
    await save('drawings');
    logEvent('drawing','drawing_saved',{offline:!navigator.onLine,paired:Boolean(state.device.deviceToken)});
    toast('Drawing saved ★');
    if(trySync&&navigator.onLine&&state.device.deviceToken)syncDrawingQueue(false).catch(()=>{});
    return true;
  }

  let drawingSyncing=false;
  async function syncDrawingQueue(showMessage=false){
    if(drawingSyncing||!navigator.onLine||!state.device.deviceToken||!state.drawings.queue.length)return false;
    drawingSyncing=true;state.drawings.lastError=null;await save('drawings');
    try{
      while(state.drawings.queue.length){
        const item=state.drawings.queue[0];item.attempts=(item.attempts||0)+1;await save('drawings');
        await sendTabletCommand('uploadDrawing',{
          createdAt:item.createdAt,fileName:item.fileName,imageBase64:item.imageBase64,thumbnailDataUrl:item.thumbnailDataUrl,
        });
        state.drawings.queue.shift();state.drawings.lastSyncAt=nowISO();state.drawings.lastError=null;await save('drawings');
        logEvent('drawing','drawing_synced',{});
      }
      if(showMessage)toast('Drawings synced');
      return true;
    }catch(error){
      state.drawings.lastError=error.message||'Drawing sync failed';await save('drawings');
      if(showMessage)toast(state.drawings.lastError);
      return false;
    }finally{drawingSyncing=false;}
  }



  function pendingWonderLogCount(){
    const events=state.analytics.events.filter(item=>!item.syncedAt).length;
    const sessions=state.analytics.sessions.filter(item=>!item.syncedAt).length;
    const milestones=Object.values(state.analytics.milestones).filter(item=>!item.syncedAt).length;
    return events+sessions+milestones;
  }

  async function syncWonderLog(showMessage=false){
    if(wonderLogSyncing||!navigator.onLine||!state.device.deviceToken)return false;
    let pending=pendingWonderLogCount();
    if(!pending){
      state.analytics.lastError=null;
      if(showMessage)toast('Wonder Log is up to date');
      return true;
    }
    wonderLogSyncing=true;state.analytics.lastError=null;await save('analytics');
    try{
      let batches=0;
      while(pendingWonderLogCount()&&batches<80){
        const events=state.analytics.events.filter(item=>!item.syncedAt).slice(0,75).map(({syncedAt,...item})=>item);
        const sessions=state.analytics.sessions.filter(item=>!item.syncedAt).slice(0,20).map(({syncedAt,...item})=>item);
        const milestones=Object.values(state.analytics.milestones).filter(item=>!item.syncedAt).slice(0,20).map(({syncedAt,...item})=>item);
        const result=await sendTabletCommand('syncWonderLog',{
          eventsJson:JSON.stringify(events),sessionsJson:JSON.stringify(sessions),milestonesJson:JSON.stringify(milestones),
        });
        const syncedAt=result.syncedAt||nowISO();
        const eventIds=new Set(result.acceptedEventIds||[]),sessionIds=new Set(result.acceptedSessionIds||[]),milestoneKeys=new Set(result.acceptedMilestoneKeys||[]);
        state.analytics.events.forEach(item=>{if(eventIds.has(item.id))item.syncedAt=syncedAt;});
        state.analytics.sessions.forEach(item=>{if(sessionIds.has(item.id))item.syncedAt=syncedAt;});
        Object.entries(state.analytics.milestones).forEach(([key,item])=>{if(milestoneKeys.has(key))item.syncedAt=syncedAt;});
        state.analytics.lastSyncAt=syncedAt;state.analytics.lastError=null;await save('analytics');batches++;
        if(!events.length&&!sessions.length&&!milestones.length)break;
      }
      if(showMessage)toast('Wonder Log synced');
      return true;
    }catch(error){
      state.analytics.lastError=error.message||'Wonder Log sync failed';await save('analytics');
      if(showMessage)toast(state.analytics.lastError);
      return false;
    }finally{wonderLogSyncing=false;}
  }

  function confirmClearWonderLog(parent){
    parent.remove(); const bg=document.createElement('div'); bg.className='modal-backdrop';
    bg.innerHTML=`<div class="modal"><h2>Clear Tablet Wonder Log?</h2><p>This clears the Wonder Log history stored on this tablet. It does not erase data already synced to the Companion. Type <strong>ERASE</strong>.</p><input id="eraseWord" autocomplete="off"><div class="modal-actions"><button class="adult-btn" id="cancelErase">Cancel</button><button class="adult-btn danger" id="confirmErase">Erase</button></div></div>`;
    document.body.appendChild(bg);bg.querySelector('#cancelErase').onclick=()=>bg.remove();bg.querySelector('#confirmErase').onclick=async()=>{if(bg.querySelector('#eraseWord').value.trim().toUpperCase()!=='ERASE')return;state.analytics=clone(defaults.analytics);await save('analytics');startSession();bg.remove();toast('Tablet Wonder Log cleared');};
  }

  // A small global margin for near-missed touch/button presses. Mouse input is unchanged.
  let forgivingTouchStart=null;
  document.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse')return;forgivingTouchStart={id:e.pointerId,x:e.clientX,y:e.clientY,target:e.target}},true);
  document.addEventListener('pointerup',e=>{
    const start=forgivingTouchStart;forgivingTouchStart=null;if(!start||start.id!==e.pointerId||e.pointerType==='mouse')return;
    if(Math.hypot(e.clientX-start.x,e.clientY-start.y)>14||e.target.closest('button,input,select,textarea,label,.picture-playfield'))return;
    let best=null,bestD=Infinity;document.querySelectorAll('button:not(:disabled)').forEach(btn=>{const r=btn.getBoundingClientRect(),style=getComputedStyle(btn);if(!r.width||!r.height||style.display==='none'||style.visibility==='hidden')return;const dx=e.clientX<r.left?r.left-e.clientX:e.clientX>r.right?e.clientX-r.right:0,dy=e.clientY<r.top?r.top-e.clientY:e.clientY>r.bottom?e.clientY-r.bottom:0,d=Math.hypot(dx,dy);if(d<=14&&d<bestD){best=btn;bestD=d}});if(best){e.preventDefault();best.click()}
  },true);

  let batteryInfo=null;
  async function initBattery(){
    if(!navigator.getBattery)return;
    try{ batteryInfo=await navigator.getBattery(); const update=()=>{ lowPower=batteryInfo.level<=.05&&!batteryInfo.charging; updateBatteryUI(); }; ['levelchange','chargingchange'].forEach(e=>batteryInfo.addEventListener(e,update)); update(); }catch{}
  }
  function updateBatteryUI(){
    const el=document.getElementById('battery'); if(!el||!batteryInfo)return;
    const pct=Math.round(batteryInfo.level*100),fill=el.querySelector('.battery-fill'); fill.style.width=`${pct}%`;
    const charging=!!batteryInfo.charging;
    el.classList.toggle('low',pct<=20||charging);
    el.classList.toggle('critical',pct<=10&&!charging);
    el.classList.toggle('very-low',pct<=5&&!charging);
    el.classList.toggle('charging',charging);
    fill.style.background=charging?'#2a9d8f':pct<=10?'#e63946':pct<=20?'#ffd23f':'#2a9d8f';
    el.setAttribute('aria-label',charging?`${pct}% battery, charging`:`${pct}% battery${pct<=10?', critically low':pct<=20?', low':''}`);
  }

  // Wonder Lab owns long-press gestures. Never let the browser turn them into
  // native context menus, image previews, or drag interactions.
  document.addEventListener('contextmenu', event => {
    event.preventDefault();
  }, {capture:true});

  document.addEventListener('dragstart', event => {
    event.preventDefault();
  }, {capture:true});

  async function init(){
    await openDB(); await loadState(); await initBattery(); await refreshBuildVersion();
    if(state.analytics.currentSession){
      const stale=state.analytics.currentSession;
      state.analytics.sessions.push({id:stale.id,startedAt:stale.startedAt,endedAt:nowISO(),durationMs:Math.min(4*60*60*1000,Math.max(0,Date.now()-new Date(stale.startedAt).getTime())),batteryStart:stale.batteryStart,batteryEnd:batteryInfo?Math.round(batteryInfo.level*100):null,recovered:true,syncedAt:null});
      state.analytics.currentSession=null;
    }
    startSession();
    if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
    if(state.device.deviceToken&&navigator.onLine){await syncPictureLibraryFromBackend(false);await syncDrawingQueue(false);await syncWonderLog(false);}
    renderActivityOrHome();
    document.addEventListener('visibilitychange',()=>{if(document.hidden)endSession();else resumeSession();});
    window.addEventListener('pagehide',endSession);
    window.addEventListener('online',()=>{if(state.device.deviceToken){syncPictureLibraryFromBackend(false).catch(()=>{});syncDrawingQueue(false).catch(()=>{});syncWonderLog(false).catch(()=>{});}});
    setInterval(()=>{if(state.device.deviceToken&&navigator.onLine)syncWonderLog(false).catch(()=>{});},5*60*1000);
  }
  function renderActivityOrHome(){ const s=activities.some(a=>a.id===state.currentScreen&&!a.disabled)?state.currentScreen:'home'; if(s==='home')renderHome();else renderActivity(s); }

  init().catch(err=>{ console.error(err); renderHome(); });
})();
