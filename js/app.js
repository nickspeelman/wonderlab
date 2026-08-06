(() => {
  'use strict';

  const APP_VERSION = 8;
  const DB_NAME = 'roscoes-playground';
  const STORE = 'state';
  const COLORS = ['#e63946', '#ffd23f', '#3a86ff'];
  const app = document.getElementById('app');

  const defaults = {
    currentScreen: 'home',
    preferences: { soundEffects: true, voiceResponses: true, volume: 0.45, tilt: true, usageInsights: true },
    switchboard: { light:false, rain:false, stars:false, bubbles:false, train:false, wind:false, snow:false, lightning:false, rainbow:false },
    tapAndMake: { selected:'circle', selectedColor:'red', shapes:[] },
    buttons: { events:[] },
    colorLight: { levels:[0,0,0], brightnessLevel:3, spot:{x:.5,y:.5,color:'red'} },
    drawing: { dataUrl:null, tool:'red', brushSize:'medium' },
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
      activityDurations: {}
    }
  };

  const state = structuredClone(defaults);
  let db;
  let audioCtx;
  let lowPower = false;
  let activeCleanup = () => {};
  let lastTouchSampleAt = 0;

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
    }
  };

  const LOOPING_SWITCHES = new Set(['rain','bubbles','train','wind','snow','lightning']);
  const ONE_SHOT_SWITCHES = new Set(['light','stars','rainbow']);
  const MIX = { voice:1, ui:.45, pop:.60, broom:.45, switchOneShot:.55, motion:.50, ambient:.32 };

  const clone = obj => JSON.parse(JSON.stringify(obj));

  async function openDB(){
    return new Promise((resolve,reject)=>{
      const req = indexedDB.open(DB_NAME, APP_VERSION);
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
    await Promise.all([save('switchboard'),save('colorLight'),save('drawing')]);
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
    state.analytics.events.push({time:nowISO(),activity,event,details});
    trimAnalytics();
    save('analytics').catch(()=>{});
  }

  function markMilestone(key,label,activity){
    if(!analyticsEnabled() || state.analytics.milestones[key]) return;
    state.analytics.milestones[key]={time:nowISO(),label,activity};
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
    closeActivitySegment(null);
    const cur=state.analytics.currentSession;
    state.analytics.sessions.push({
      id:cur.id,
      startedAt:cur.startedAt,
      endedAt:nowISO(),
      durationMs:Math.max(0,Date.now()-new Date(cur.startedAt).getTime()),
      batteryStart:cur.batteryStart,
      batteryEnd:batteryInfo?Math.round(batteryInfo.level*100):null
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

  function weeklySummary(){
    const cutoff=weekAgoMs(),a=state.analytics;
    const sessions=a.sessions.filter(s=>new Date(s.startedAt).getTime()>=cutoff);
    if(a.currentSession && new Date(a.currentSession.startedAt).getTime()>=cutoff){
      sessions.push({startedAt:a.currentSession.startedAt,durationMs:Date.now()-new Date(a.currentSession.startedAt).getTime()});
    }
    const events=a.events.filter(e=>new Date(e.time).getTime()>=cutoff);
    const durationByActivity={};
    for(const e of events){
      if(e.event==='activity_exit' && e.details?.durationMs) durationByActivity[e.activity]=(durationByActivity[e.activity]||0)+e.details.durationMs;
    }
    if(state.currentScreen!=='home' && a.activityStartedAt){ durationByActivity[state.currentScreen]=(durationByActivity[state.currentScreen]||0)+(Date.now()-a.activityStartedAt); }
    const favorite=Object.entries(durationByActivity).sort((x,y)=>y[1]-x[1])[0];
    const milestones=Object.values(a.milestones).filter(m=>new Date(m.time).getTime()>=cutoff).sort((x,y)=>new Date(y.time)-new Date(x.time));
    const colorCounts={red:0,yellow:0,blue:0,rainbow:0};
    for(const e of events) if(e.activity==='drawing'&&e.event==='draw_color'&&colorCounts[e.details?.color]!==undefined) colorCounts[e.details.color]++;
    const favoriteColor=Object.entries(colorCounts).sort((x,y)=>y[1]-x[1])[0];
    return {
      totalMs:sessions.reduce((n,s)=>n+(s.durationMs||0),0),
      averageMs:sessions.length?sessions.reduce((n,s)=>n+(s.durationMs||0),0)/sessions.length:0,
      sessions:sessions.length,
      favorite,
      newestMilestone:milestones[0],
      savedDrawings:events.filter(e=>e.activity==='drawing'&&['drawing_exported','drawing_drive_saved'].includes(e.event)).length,
      favoriteColor:favoriteColor&&favoriteColor[1]?favoriteColor[0]:null,
      durationByActivity
    };
  }

  function downloadBlob(blob,filename){
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  function exportUsage(format){
    const stamp=new Date().toISOString().slice(0,10);
    if(format==='json'){
      const payload={exportedAt:nowISO(),appVersion:APP_VERSION,analytics:state.analytics};
      downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),`roscoe-wonder-log-${stamp}.json`);
      logEvent('parent','usage_exported',{format:'json'}); return;
    }
    const rows=[['time','lab','event','details_json']];
    for(const e of state.analytics.events) rows.push([e.time,e.activity,e.event,JSON.stringify(e.details||{})]);
    const csv=rows.map(row=>row.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\n');
    downloadBlob(new Blob([csv],{type:'text/csv'}),`roscoe-wonder-log-${stamp}.csv`);
    logEvent('parent','usage_exported',{format:'csv'});
  }

  function masterVolume(){ return Math.max(0,Math.min(1,+state.preferences.volume||0)); }

  function oneShot(path, relativeVolume=.5, playbackRate=1){
    if(!state.preferences.soundEffects || !path) return null;
    try{
      const a=new Audio(path);
      a.preload='auto';
      a.volume=Math.min(1,masterVolume()*relativeVolume);
      a.playbackRate=playbackRate;
      a.play().catch(()=>{});
      return a;
    }catch{return null;}
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
      activeLoops.set(key,a);updateLoopVolumes();a.play().catch(()=>{});
    }catch{}
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
            <div id="battery" class="battery" aria-label="Low battery"><span class="battery-plug">🔌</span><div class="battery-fill"></div></div>
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
    {id:'physics', label:'Motion Lab', icon:'⚽', cls:'green'}
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
    if (screen==='home') renderHome(); else renderActivity(screen);
  }

  function renderHome(){
    const tiles=activities.map(a=>`<button class="tile ${a.cls}" data-screen="${a.id}"><span class="tile-icon">${a.icon}</span><span class="tile-label">${a.label}</span></button>`).join('');
    shell("Roscoe's Wonder Lab", `<div class="home-grid">${tiles}</div>`);
    document.querySelectorAll('.tile').forEach(btn=>btn.onclick=()=>{ speak(activityLabel(btn.dataset.screen)); navigate(btn.dataset.screen); });
  }

  function renderActivity(id){
    const map={switchboard:renderSwitchboard,tapAndMake:renderTapAndMake,buttons:renderButtons,colorLight:renderColorLight,drawing:renderDrawing,physics:renderPhysics};
    map[id]();
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
    shell('Art Lab',`<div class="activity-wrap"><div class="drawing-layout"><div class="drawing-tools"><div class="paint-grid">${colorButtons}</div><div class="brush-grid" aria-label="Brush sizes"><button class="brush-btn ${state.drawing.brushSize==='small'?'active':''}" data-size="small" aria-label="Small brush"><span class="brush-dot small"></span></button><button class="brush-btn ${state.drawing.brushSize==='medium'?'active':''}" data-size="medium" aria-label="Medium brush"><span class="brush-dot medium"></span></button><button class="brush-btn ${state.drawing.brushSize==='large'?'active':''}" data-size="large" aria-label="Large brush"><span class="brush-dot large"></span></button></div></div><canvas id="drawCanvas" class="draw-canvas"></canvas></div></div>`,true);
    const canvas=document.getElementById('drawCanvas'),ctx=canvas.getContext('2d',{willReadFrequently:true}); let tool=state.drawing.tool,drawing=false,last=null,hue=0,saveTimer;
    const widths={small:10,medium:22,large:44};
    const ink=()=>tool==='white'?'#fff':tool==='black'?'#111':tool==='rainbow'?`hsl(${hue},90%,55%)`:({red:COLORS[0],yellow:COLORS[1],blue:COLORS[2]})[tool];
    const resize=()=>{ const r=canvas.getBoundingClientRect(); canvas.width=Math.max(1,Math.floor(r.width*devicePixelRatio)); canvas.height=Math.max(1,Math.floor(r.height*devicePixelRatio)); ctx.scale(devicePixelRatio,devicePixelRatio); ctx.lineCap='round';ctx.lineJoin='round'; if(state.drawing.dataUrl){ const im=new Image(); im.onload=()=>ctx.drawImage(im,0,0,r.width,r.height); im.src=state.drawing.dataUrl; } };
    requestAnimationFrame(resize); window.addEventListener('resize',resize); activeCleanup=()=>window.removeEventListener('resize',resize);
    document.querySelectorAll('.paint-btn').forEach(b=>b.onclick=()=>{ tool=state.drawing.tool=b.dataset.tool; document.querySelectorAll('.paint-btn').forEach(x=>x.classList.toggle('active',x===b)); save('drawing'); logEvent('drawing','tool_selected',{tool}); speak(tool==='white'?'White':tool[0].toUpperCase()+tool.slice(1)); });
    document.querySelectorAll('.brush-btn').forEach(b=>b.onclick=()=>{state.drawing.brushSize=b.dataset.size;document.querySelectorAll('.brush-btn').forEach(x=>x.classList.toggle('active',x===b));save('drawing');speak(`${b.dataset.size} brush`);});
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
      tiltGravity={x:deadZone(x)*.9,y:deadZone(y)*.9};
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
    const bg=document.createElement('div'); bg.className='modal-backdrop'; bg.innerHTML=`<div class="modal"><h2>Wonder Lab Settings</h2><p>Type <strong>ENTER</strong> to continue.</p><input id="gateInput" autocomplete="off" inputmode="text" aria-label="Type ENTER"><div class="modal-actions"><button class="adult-btn" id="cancelGate">Cancel</button><button class="adult-btn primary" id="enterGate">Continue</button></div></div>`;
    document.body.appendChild(bg); const input=bg.querySelector('#gateInput'); input.focus();
    const close=()=>bg.remove(); bg.onclick=e=>{if(e.target===bg)close();}; bg.querySelector('#cancelGate').onclick=close; bg.querySelector('#enterGate').onclick=()=>{ if(input.value.trim().toUpperCase()==='ENTER'){close();openParentControls();} else {input.value='';input.placeholder='Please type ENTER';} };
    input.onkeydown=e=>{if(e.key==='Enter')bg.querySelector('#enterGate').click();};
  }

  function openParentControls(){
    const bg=document.createElement('div'); bg.className='modal-backdrop'; bg.innerHTML=`<div class="modal"><h2>Wonder Lab Settings</h2><div class="settings-list">
      <div class="settings-row"><span><strong>Voice responses</strong><br><span class="small-note">Short spoken words describe Roscoe's actions.</span></span><button class="adult-btn" id="voiceBtn">${state.preferences.voiceResponses?'On':'Off'}</button></div>
      <div class="settings-row"><span><strong>Sound effects</strong><br><span class="small-note">Every lab still works when these are off.</span></span><button class="adult-btn" id="effectsBtn">${state.preferences.soundEffects?'On':'Off'}</button></div>
      <div class="settings-row"><label for="volume"><strong>Audio volume</strong></label><input id="volume" type="range" min="0" max="1" step="0.05" value="${state.preferences.volume}"></div>
      <div class="settings-row"><span><strong>Tilt controls</strong></span><button class="adult-btn" id="tiltBtn">${state.preferences.tilt?'On':'Off'}</button></div>
      <div class="settings-row"><span><strong>Usage insights</strong><br><span class="small-note">Stored only on this tablet.</span></span><button class="adult-btn" id="insightsBtn">${analyticsEnabled()?'On':'Off'}</button></div>
      <div class="settings-row"><span><strong>Engagement dashboard</strong></span><button class="adult-btn" id="dashboardBtn">View</button></div>
      <div class="settings-row"><span><strong>Export usage data</strong></span><span><button class="adult-btn" id="exportCsv">CSV</button> <button class="adult-btn" id="exportJson">JSON</button></span></div>
      <div class="settings-row"><span><strong>Current Art Lab drawing</strong><br><span class="small-note">Queues safely when offline.</span></span><button class="adult-btn primary" id="saveDrive">Save to Drive</button></div>
      <div class="settings-row"><span><strong>Google Drive</strong><br><span class="small-note" id="driveStatus">${driveStatusText()}</span></span><button class="adult-btn" id="syncDrive">${driveAccessToken?'Sync now':'Connect / sync'}</button></div>
      <div class="settings-row"><span><strong>Reset this lab</strong></span><button class="adult-btn" id="resetCurrent">Reset</button></div>
      <div class="settings-row"><span><strong>Reset all labs</strong></span><button class="adult-btn danger" id="resetAll">Reset all</button></div>
    </div><div class="modal-actions"><button class="adult-btn primary" id="doneSettings">Done</button></div></div>`;
    document.body.appendChild(bg); const close=()=>bg.remove(); bg.onclick=e=>{if(e.target===bg)close();}; bg.querySelector('#doneSettings').onclick=close;
    bg.querySelector('#voiceBtn').onclick=async e=>{state.preferences.voiceResponses=!state.preferences.voiceResponses;e.target.textContent=state.preferences.voiceResponses?'On':'Off';await save('preferences');if(state.preferences.voiceResponses)speak('Voice responses on');};
    bg.querySelector('#effectsBtn').onclick=async e=>{state.preferences.soundEffects=!state.preferences.soundEffects;e.target.textContent=state.preferences.soundEffects?'On':'Off';await save('preferences');if(!state.preferences.soundEffects)stopAllLoops();else{if(state.currentScreen==='switchboard')syncSwitchSounds();playNamed('ui','click',MIX.ui);}};
    bg.querySelector('#volume').oninput=async e=>{state.preferences.volume=+e.target.value;updateLoopVolumes();await save('preferences');};
    bg.querySelector('#tiltBtn').onclick=async e=>{state.preferences.tilt=!state.preferences.tilt;e.target.textContent=state.preferences.tilt?'On':'Off';await save('preferences');};
    bg.querySelector('#insightsBtn').onclick=async e=>{const turningOn=!analyticsEnabled();if(!turningOn)endSession();state.preferences.usageInsights=turningOn;e.target.textContent=turningOn?'On':'Off';await save('preferences');if(turningOn)startSession();};
    bg.querySelector('#dashboardBtn').onclick=()=>{close();openDashboard();};
    bg.querySelector('#exportCsv').onclick=()=>exportUsage('csv');
    bg.querySelector('#exportJson').onclick=()=>exportUsage('json');
    bg.querySelector('#saveDrive').onclick=async()=>{await queueCurrentDrawing(true);const status=bg.querySelector('#driveStatus');if(status)status.textContent=driveStatusText();};
    bg.querySelector('#syncDrive').onclick=async()=>{await authorizeAndSyncDrive();const status=bg.querySelector('#driveStatus');if(status)status.textContent=driveStatusText();};
    bg.querySelector('#resetCurrent').onclick=async()=>{close();await resetCurrent(false);};
    bg.querySelector('#resetAll').onclick=()=>confirmResetAll(bg);
  }

  function confirmResetAll(parent){
    parent.remove(); const bg=document.createElement('div'); bg.className='modal-backdrop'; bg.innerHTML=`<div class="modal"><h2>Reset Everything?</h2><p>This clears every lab, including the current drawing. Type <strong>RESET</strong>.</p><input id="resetWord" autocomplete="off"><div class="modal-actions"><button class="adult-btn" id="cancel">Cancel</button><button class="adult-btn danger" id="confirm">Reset all</button></div></div>`; document.body.appendChild(bg);
    bg.querySelector('#cancel').onclick=()=>bg.remove(); bg.querySelector('#confirm').onclick=async()=>{ if(bg.querySelector('#resetWord').value.trim().toUpperCase()!=='RESET')return; for(const k of activities.map(a=>a.id)){state[k]=clone(defaults[k]);await save(k);} bg.remove();navigate('home');toast('All labs reset'); };
  }

  function drawingBlob(){
    return new Promise(resolve=>{ if(!state.drawing.dataUrl){resolve(null);return;} fetch(state.drawing.dataUrl).then(r=>r.blob()).then(resolve).catch(()=>resolve(null)); });
  }

  const driveConfig = () => window.ROSCOE_CONFIG || {};
  let driveAccessToken = null;
  let driveTokenExpiresAt = 0;
  let driveTokenClient = null;
  let driveSyncing = false;
  let pendingDriveAuthorization = null;

  function driveConfigured(){
    const id=driveConfig().GOOGLE_CLIENT_ID||'';
    return id && !id.startsWith('PASTE-');
  }

  function driveStatusText(){
    const queued=state.drive?.queue?.length||0;
    if(!driveConfigured()) return 'Setup required in js/config.js.';
    if(driveSyncing) return `Syncing ${queued||''}`.trim();
    if(state.drive?.lastError) return `${queued?`${queued} waiting. `:''}${state.drive.lastError}`;
    if(queued) return `${queued} drawing${queued===1?'':'s'} waiting to sync.`;
    if(state.drive?.lastSyncAt) return `Up to date. Last saved ${new Date(state.drive.lastSyncAt).toLocaleString()}.`;
    return driveAccessToken?'Connected and ready.':'Ready to connect.';
  }

  function initDriveTokenClient(){
    if(driveTokenClient || !driveConfigured() || !window.google?.accounts?.oauth2) return !!driveTokenClient;
    driveTokenClient=google.accounts.oauth2.initTokenClient({
      client_id:driveConfig().GOOGLE_CLIENT_ID,
      scope:'https://www.googleapis.com/auth/drive.file',
      callback:response=>{
        if(response.error){
          state.drive.lastError='Google authorization was not completed.';
          save('drive').catch(()=>{});
          pendingDriveAuthorization?.reject(new Error(response.error));
          pendingDriveAuthorization=null;
          return;
        }
        driveAccessToken=response.access_token;
        driveTokenExpiresAt=Date.now()+Math.max(0,(response.expires_in||3600)-60)*1000;
        state.drive.lastError=null;
        save('drive').catch(()=>{});
        pendingDriveAuthorization?.resolve(driveAccessToken);
        pendingDriveAuthorization=null;
      },
      error_callback:error=>{
        state.drive.lastError=error?.type==='popup_closed'?'Drive connection was closed.':'Could not open Google authorization.';
        save('drive').catch(()=>{});
        pendingDriveAuthorization?.reject(new Error(state.drive.lastError));
        pendingDriveAuthorization=null;
      }
    });
    return true;
  }

  function requestDriveToken(){
    if(driveAccessToken && Date.now()<driveTokenExpiresAt) return Promise.resolve(driveAccessToken);
    if(!driveConfigured()) return Promise.reject(new Error('Google Drive is not configured yet.'));
    if(!initDriveTokenClient()) return Promise.reject(new Error('Google authorization is still loading. Try again.'));
    if(pendingDriveAuthorization) return pendingDriveAuthorization.promise;
    let resolve,reject;
    const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});
    pendingDriveAuthorization={promise,resolve,reject};
    driveTokenClient.requestAccessToken({prompt:''});
    return promise;
  }

  async function driveFetch(url,options={}){
    if(!driveAccessToken || Date.now()>=driveTokenExpiresAt) throw new Error('Drive needs to be reconnected.');
    const headers=new Headers(options.headers||{});headers.set('Authorization',`Bearer ${driveAccessToken}`);
    const response=await fetch(url,{...options,headers});
    if(response.status===401){driveAccessToken=null;driveTokenExpiresAt=0;throw new Error('Drive authorization expired. Tap Connect / sync.');}
    if(!response.ok){let msg=`Drive error ${response.status}`;try{const j=await response.json();msg=j.error?.message||msg;}catch{}throw new Error(msg);}
    return response;
  }

  function escapeDriveQuery(value){return String(value).replaceAll('\\','\\\\').replaceAll("'","\\'");}

  async function findOrCreateDriveFolder(name,parentId=null){
    const q=[`name='${escapeDriveQuery(name)}'`,`mimeType='application/vnd.google-apps.folder'`,`trashed=false`];
    if(parentId)q.push(`'${escapeDriveQuery(parentId)}' in parents`);
    const url=`https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id,name)&pageSize=10&q=${encodeURIComponent(q.join(' and '))}`;
    const found=await (await driveFetch(url)).json();
    if(found.files?.length)return found.files[0].id;
    const metadata={name,mimeType:'application/vnd.google-apps.folder'};if(parentId)metadata.parents=[parentId];
    const created=await (await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id,name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(metadata)})).json();
    return created.id;
  }

  async function ensureDriveFolder(){
    const cfg=driveConfig();
    if(cfg.DRIVE_FOLDER_ID){state.drive.drawingsFolderId=cfg.DRIVE_FOLDER_ID;await save('drive');return cfg.DRIVE_FOLDER_ID;}
    if(state.drive.drawingsFolderId)return state.drive.drawingsFolderId;
    const root=state.drive.rootFolderId||await findOrCreateDriveFolder(cfg.DRIVE_ROOT_FOLDER_NAME||"Roscoe's Wonder Lab");
    const drawings=await findOrCreateDriveFolder(cfg.DRIVE_DRAWINGS_FOLDER_NAME||'Drawings',root);
    state.drive.rootFolderId=root;state.drive.drawingsFolderId=drawings;await save('drive');return drawings;
  }

  async function uploadQueuedDrawing(item,folderId){
    const blob=await fetch(item.dataUrl).then(r=>r.blob());
    const boundary=`roscoe_${crypto.randomUUID()}`;
    const metadata={name:item.filename,mimeType:'image/png',parents:[folderId],description:'Created in Roscoe\'s Wonder Lab'};
    const body=new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: image/png\r\n\r\n`,blob,`\r\n--${boundary}--`
    ],{type:`multipart/related; boundary=${boundary}`});
    return (await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body})).json();
  }

  async function queueCurrentDrawing(trySync=false){
    if(state.currentScreen==='drawing')await saveDrawingState();
    const blob=await drawingBlob();if(!blob){toast('There is no drawing to save yet.');return;}
    const stamp=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    const item={id:crypto.randomUUID(),createdAt:nowISO(),filename:`roscoe-wonder-lab-drawing-${stamp}.png`,dataUrl:state.drawing.dataUrl,attempts:0};
    state.drive.queue.push(item);state.drive.lastError=navigator.onLine?null:'Waiting for internet.';await save('drive');
    logEvent('drawing','drawing_drive_queued',{offline:!navigator.onLine});toast(navigator.onLine?'Drawing queued for Drive':'Drawing saved; waiting for internet');
    if(trySync&&navigator.onLine){try{await authorizeAndSyncDrive();}catch{}}
  }

  async function syncDriveQueue(){
    if(driveSyncing||!navigator.onLine||!state.drive.queue.length)return;
    if(!driveAccessToken||Date.now()>=driveTokenExpiresAt)throw new Error('Drive needs to be connected.');
    driveSyncing=true;state.drive.lastError=null;await save('drive');
    try{
      const folderId=await ensureDriveFolder();
      while(state.drive.queue.length){
        const item=state.drive.queue[0];item.attempts=(item.attempts||0)+1;await save('drive');
        const result=await uploadQueuedDrawing(item,folderId);
        state.drive.queue.shift();state.drive.lastSyncAt=nowISO();state.drive.lastError=null;await save('drive');
        logEvent('drawing','drawing_drive_saved',{fileId:result.id,filename:result.name});
      }
      toast('Drawing saved to Google Drive');
    }catch(error){
      state.drive.lastError=error.message||'Drive sync failed.';await save('drive');throw error;
    }finally{driveSyncing=false;}
  }

  async function authorizeAndSyncDrive(){
    if(!navigator.onLine){state.drive.lastError='Waiting for internet.';await save('drive');toast('Waiting for internet');return;}
    try{await requestDriveToken();await syncDriveQueue();if(!state.drive.queue.length)toast('Google Drive is up to date');}
    catch(error){toast(error.message||'Could not connect to Drive');throw error;}
  }


  function openDashboard(){
    const summary=weeklySummary();
    const bg=document.createElement('div'); bg.className='modal-backdrop';
    const durationRows=activities.map(a=>`<tr><td>${a.label}</td><td>${fmtDuration(summary.durationByActivity[a.id]||0)}</td></tr>`).join('');
    bg.innerHTML=`<div class="modal dashboard-modal"><h2>Wonder Log</h2>
      <p class="small-note">Local observations only. These are not developmental scores.</p>
      <div class="dashboard-cards">
        <div class="stat-card"><strong>${fmtDuration(summary.totalMs)}</strong><span>Lab time this week</span></div>
        <div class="stat-card"><strong>${summary.favorite?activityLabel(summary.favorite[0]):'—'}</strong><span>Favorite lab this week</span></div>
        <div class="stat-card"><strong>${summary.sessions}</strong><span>Sessions this week</span></div>
        <div class="stat-card"><strong>${fmtDuration(summary.averageMs)}</strong><span>Average session</span></div>
        <div class="stat-card"><strong>${summary.savedDrawings}</strong><span>Drawings saved to Drive</span></div>
        <div class="stat-card"><strong>${summary.favoriteColor||'—'}</strong><span>Most-used paint</span></div>
      </div>
      <div class="dashboard-section"><h3>Recent discovery</h3><p>${summary.newestMilestone?`${summary.newestMilestone.label}<br><span class="small-note">${new Date(summary.newestMilestone.time).toLocaleString()}</span>`:'No discoveries recorded yet.'}</p></div>
      <div class="dashboard-section"><h3>Time by lab</h3><table class="usage-table"><tbody>${durationRows}</tbody></table></div>
      <div class="dashboard-section"><div class="heatmap-heading"><h3>Touch heat map</h3><select id="heatActivity">${activities.map(a=>`<option value="${a.id}">${a.label}</option>`).join('')}</select></div><canvas id="heatCanvas" class="heat-canvas" width="600" height="280"></canvas><p class="small-note">Sampled touch locations from the last seven days.</p></div>
      <div class="modal-actions"><button class="adult-btn danger" id="clearUsage">Erase usage history</button><button class="adult-btn primary" id="closeDashboard">Done</button></div>
    </div>`;
    document.body.appendChild(bg);
    const draw=()=>drawHeatmap(bg.querySelector('#heatCanvas'),bg.querySelector('#heatActivity').value);
    bg.querySelector('#heatActivity').onchange=draw; requestAnimationFrame(draw);
    bg.querySelector('#closeDashboard').onclick=()=>bg.remove(); bg.onclick=e=>{if(e.target===bg)bg.remove();};
    bg.querySelector('#clearUsage').onclick=()=>confirmClearUsage(bg);
  }

  function drawHeatmap(canvas,activity){
    const ctx=canvas.getContext('2d'),cutoff=weekAgoMs();
    const pts=state.analytics.touches.filter(p=>p.activity===activity&&new Date(p.time).getTime()>=cutoff);
    ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#fffdf7';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle='#17324d';ctx.lineWidth=5;ctx.strokeRect(2.5,2.5,canvas.width-5,canvas.height-5);
    for(const p of pts){
      const g=ctx.createRadialGradient(p.x*canvas.width,p.y*canvas.height,0,p.x*canvas.width,p.y*canvas.height,32);
      g.addColorStop(0,'rgba(230,57,70,.30)');g.addColorStop(.55,'rgba(255,210,63,.16)');g.addColorStop(1,'rgba(58,134,255,0)');
      ctx.fillStyle=g;ctx.fillRect(p.x*canvas.width-32,p.y*canvas.height-32,64,64);
    }
    if(!pts.length){ctx.fillStyle='#17324d';ctx.font='700 20px system-ui';ctx.textAlign='center';ctx.fillText('No touch samples yet',canvas.width/2,canvas.height/2);}
  }

  function confirmClearUsage(parent){
    parent.remove(); const bg=document.createElement('div'); bg.className='modal-backdrop';
    bg.innerHTML=`<div class="modal"><h2>Erase Usage History?</h2><p>This clears sessions, milestones, and heat-map data. It does not change Roscoe's labs or drawings. Type <strong>ERASE</strong>.</p><input id="eraseWord" autocomplete="off"><div class="modal-actions"><button class="adult-btn" id="cancelErase">Cancel</button><button class="adult-btn danger" id="confirmErase">Erase</button></div></div>`;
    document.body.appendChild(bg);bg.querySelector('#cancelErase').onclick=()=>bg.remove();bg.querySelector('#confirmErase').onclick=async()=>{if(bg.querySelector('#eraseWord').value.trim().toUpperCase()!=='ERASE')return;state.analytics=clone(defaults.analytics);await save('analytics');startSession();bg.remove();toast('Usage history erased');};
  }

  let batteryInfo=null;
  async function initBattery(){
    if(!navigator.getBattery)return;
    try{ batteryInfo=await navigator.getBattery(); const update=()=>{ lowPower=batteryInfo.level<=.05&&!batteryInfo.charging; updateBatteryUI(); }; ['levelchange','chargingchange'].forEach(e=>batteryInfo.addEventListener(e,update)); update(); }catch{}
  }
  function updateBatteryUI(){
    const el=document.getElementById('battery'); if(!el||!batteryInfo)return;
    const pct=Math.round(batteryInfo.level*100),fill=el.querySelector('.battery-fill'); fill.style.width=`${pct}%`;
    el.classList.toggle('low',pct<=20||batteryInfo.charging);el.classList.toggle('critical',pct<=10&&!batteryInfo.charging);el.classList.toggle('very-low',pct<=5&&!batteryInfo.charging);el.classList.toggle('charging',batteryInfo.charging);
    fill.style.background=pct<=10?'#e63946':pct<=20?'#ffd23f':'#2a9d8f'; el.setAttribute('aria-label',`${pct}% battery${batteryInfo.charging?', charging':''}`);
  }

  async function init(){
    await openDB(); await loadState(); await initBattery();
    if(state.analytics.currentSession){
      const stale=state.analytics.currentSession;
      state.analytics.sessions.push({id:stale.id,startedAt:stale.startedAt,endedAt:nowISO(),durationMs:Math.min(4*60*60*1000,Math.max(0,Date.now()-new Date(stale.startedAt).getTime())),batteryStart:stale.batteryStart,batteryEnd:batteryInfo?Math.round(batteryInfo.level*100):null,recovered:true});
      state.analytics.currentSession=null;
    }
    startSession();
    if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
    renderActivityOrHome();
    document.addEventListener('visibilitychange',()=>{if(document.hidden)endSession();else resumeSession();});
    window.addEventListener('pagehide',endSession);
    window.addEventListener('online',()=>{if(driveAccessToken&&state.drive.queue.length)syncDriveQueue().catch(()=>{});});
  }
  function renderActivityOrHome(){ const s=activities.some(a=>a.id===state.currentScreen)?state.currentScreen:'home'; if(s==='home')renderHome();else renderActivity(s); }

  init().catch(err=>{ console.error(err); renderHome(); });
})();
