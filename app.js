(function(){
'use strict';
var $=function(id){return document.getElementById(id)};
var SEV={1:'Critical',2:'Urgent',3:'Semi-urgent',4:'Non-urgent'};
var THRESH={1:10,2:30,3:60,4:120};      // maximum-wait monitor, minutes
var MEAN={1:30,2:20,3:14,4:8};           // mean treatment time, minutes
var MIX=[0.08,0.30,0.70,1.0];           // cumulative severity mix
var ORDER=['ICU','VENT','XRAY'];        // fixed global acquisition order
var RNAME={ICU:'ICU beds',VENT:'Ventilators',XRAY:'X-ray unit'};
var HEARTBEAT_DEADLINE=5, RECOVERY=3;
function rng(seed){var a=seed>>>0;return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function mkPatient(r,id,arrival){
  var x=r(),sev=x<MIX[0]?1:x<MIX[1]?2:x<MIX[2]?3:4;
  var need=[];
  if(sev===1){need.push('ICU'); if(r()<0.5) need.push('VENT');}
  else if(sev===2){ if(r()<0.25) need.push('ICU'); }
  else if(sev===3){ if(r()<0.35) need.push('XRAY'); }
  return {id:id,sev:sev,arrival:arrival,treat:Math.max(2,Math.round(MEAN[sev]*(0.6+0.8*r()))),need:need,start:null,done:null,requeued:0,viol:false};
}
function workload(seed,perHour,dur){
  var r=rng(seed),lam=perHour/60,t=0,out=[],id=1;
  for(;;){t+=-Math.log(1-r())/lam; if(t>=dur)break; out.push(mkPatient(r,id++,Math.floor(t)));}
  return out;
}
function weights(){return {a:$('wA').value/100,b:$('wB').value/100,g:$('wG').value/100}}
function score(p,t,w){var wait=t-p.arrival;return w.a*((5-p.sev)/4)+w.b*Math.min(wait/90,1)+w.g*Math.min(Math.max(0,wait-20)/60,1)}
function cmpFn(strategy,t,w){
  if(strategy==='fcfs')return function(x,y){return x.arrival-y.arrival||x.id-y.id};
  if(strategy==='priority')return function(x,y){return x.sev-y.sev||x.arrival-y.arrival||x.id-y.id};
  return function(x,y){return score(y,t,w)-score(x,t,w)||x.arrival-y.arrival||x.id-y.id};
}
function Sim(cfg){
  this.cfg=cfg; this.t=0; this.pending=cfg.load.map(function(p){return Object.assign({},p,{need:p.need.slice()})});
  this.pi=0; this.queue=[]; this.all=[]; this.log=[]; this.hist=[]; this.lockOps=0; this.faults=[]; this.nextId=100000;
  this.sems={ICU:{n:5,cap:5,q:[]},VENT:{n:2,cap:2,q:[]},XRAY:{n:1,cap:1,q:[]}};
  this.docs=[]; for(var i=0;i<cfg.doctors;i++)this.docs.push({id:i,state:'IDLE',p:null,held:[],need:[],rem:0,beat:0,busy:0,fstart:0,until:0,blocked:null});
  this.dispatched=0;
}
Sim.prototype.say=function(msg,kind){this.log.push({t:this.t,msg:msg,kind:kind||''});if(this.log.length>120)this.log.shift()};
Sim.prototype.surge=function(n,seed){var r=rng(seed);for(var i=0;i<n;i++){var p=mkPatient(r,this.nextId++,this.t);this.pending.splice(this.pi,0,p)}this.say('Arrival surge: '+n+' patients registered','a')};
Sim.prototype.injectFault=function(){
  var c=this.docs.filter(function(d){return d.state==='TREAT'});
  if(!c.length){this.say('No doctor is treating a patient, fault not injected');return}
  var d=c[0];d.state='FAULT';d.fstart=this.t;this.say('Doctor '+(d.id+1)+' stopped responding (injected fault)','f');
};
Sim.prototype.release=function(d){
  for(var i=0;i<d.held.length;i++){this.sems[d.held[i]].n++;this.lockOps++}
  d.held=[];
  for(var k in this.sems){var q=this.sems[k].q,ix=q.indexOf(d.id);if(ix>=0)q.splice(ix,1)}
};
Sim.prototype.step=function(){
  var t=this.t,cfg=this.cfg,self=this,w=cfg.w();
  // producer: arrival generator
  while(this.pi<this.pending.length&&this.pending[this.pi].arrival<=t){var p=this.pending[this.pi++];this.queue.push(p);this.all.push(p);this.lockOps++;
    if(p.sev===1)this.say('P1 critical patient #'+p.id+' registered','c');}
  // dispatcher (single authority for assignment)
  this.dispatched=0;
  var cmp=cmpFn(cfg.strategy(),t,w);
  for(;;){
    var d=null;for(var i=0;i<this.docs.length;i++){if(this.docs[i].state==='IDLE'){d=this.docs[i];break}}
    if(!d||!this.queue.length)break;
    this.queue.sort(cmp); var pt=this.queue.shift(); this.lockOps++; this.dispatched++;
    d.p=pt;d.state='ACQUIRE';d.need=ORDER.filter(function(r){return pt.need.indexOf(r)>=0});d.held=[];d.blocked=null;d.beat=t;
    this.say('Dispatch #'+pt.id+' (P'+pt.sev+') to Doctor '+(d.id+1),'a');
  }
  // doctor threads
  for(var j=0;j<this.docs.length;j++){
    var dd=this.docs[j];
    if(dd.state==='ACQUIRE'){
      dd.beat=t;dd.blocked=null;
      while(dd.need.length){
        var r=dd.need[0],s=this.sems[r];
        if(s.n>0&&(s.q.length===0||s.q[0]===dd.id)){s.n--;this.lockOps++;if(s.q[0]===dd.id)s.q.shift();dd.held.push(r);dd.need.shift();}
        else{if(s.q.indexOf(dd.id)<0)s.q.push(dd.id);dd.blocked=r;break}
      }
      if(!dd.need.length){dd.state='TREAT';dd.rem=dd.p.treat;if(dd.p.start===null)dd.p.start=t;}
    }
    if(dd.state==='TREAT'){
      dd.rem--;dd.busy++;dd.beat=t;
      if(dd.rem<=0){dd.p.done=t;this.release(dd);dd.state='IDLE';dd.p=null;}
    } else if(dd.state==='RECOVER'&&t>=dd.until){dd.state='IDLE';this.say('Doctor '+(dd.id+1)+' restarted under controlled ownership','a')}
  }
  // fault monitor (heartbeat check)
  for(var k2=0;k2<this.docs.length;k2++){
    var fd=this.docs[k2];
    if(fd.state==='FAULT'&&t-fd.beat>=HEARTBEAT_DEADLINE){
      var pp=fd.p;this.release(fd);pp.requeued++;pp.start=null;this.queue.push(pp);fd.p=null;fd.state='RECOVER';fd.until=t+RECOVERY;
      this.faults.push({doc:fd.id+1,detect:t-fd.fstart,recover:RECOVERY});
      this.say('Missed heartbeat: Doctor '+(fd.id+1)+' marked stale, patient #'+pp.id+' returned to queue','f');
    }
  }
  // maximum-wait monitor
  for(var m=0;m<this.queue.length;m++){var q=this.queue[m];if(!q.viol&&t-q.arrival>THRESH[q.sev]){q.viol=true;this.say('Wait threshold exceeded: P'+q.sev+' #'+q.id+' ('+(t-q.arrival)+' min)','f')}}
  // history sample
  var c=[0,0,0,0];this.queue.forEach(function(x){c[x.sev-1]++});this.hist.push(c);
  this.t=t+1;
};
Sim.prototype.stats=function(){
  var t=this.t,s={n:{1:0,2:0,3:0,4:0},sum:{1:0,2:0,3:0,4:0},max:{1:0,2:0,3:0,4:0},treated:0,viol:0},self=this;
  this.all.forEach(function(p){
    var w=p.start!==null?p.start-p.arrival:t-p.arrival;
    if(p.start!==null){s.n[p.sev]++;s.sum[p.sev]+=w}
    if(w>s.max[p.sev])s.max[p.sev]=w;
    if(p.done!==null)s.treated++;
    if(p.viol||w>THRESH[p.sev])s.viol++;
  });
  s.avg={};var tn=0,ts=0;for(var k=1;k<=4;k++){s.avg[k]=s.n[k]?s.sum[k]/s.n[k]:0;tn+=s.n[k];ts+=s.sum[k]}
  s.avg.all=tn?ts/tn:0;
  s.waiting=this.queue.length;
  s.thru=t?s.treated/(t/60):0;
  var busy=0;this.docs.forEach(function(d){busy+=d.busy});s.util=t?busy/(this.docs.length*t):0;
  return s;
};
function headless(strategy,cfg){
  var c=Object.assign({},cfg,{strategy:function(){return strategy}});
  var s=new Sim(c);for(var i=0;i<cfg.dur;i++)s.step();return s;
}

// ---------- UI state
var sim,timer=null,acc=0,DUR=480,cmpResult=null;
function cfgNow(){
  return {load:workload(+$('nSeed').value,+$('nRate').value,DUR),doctors:Math.max(1,Math.min(6,+$('nDoc').value||3)),dur:DUR,
    strategy:function(){return $('sStrat').value},w:function(){return weights()}};
}
function reset(){stop();sim=new Sim(cfgNow());sim.say('Shift started: '+sim.cfg.load.length+' patients will arrive','a');render()}
function stop(){if(timer){clearInterval(timer);timer=null}$('bRun').textContent='Start';$('dot').classList.remove('on')}
function run(){
  if(timer){stop();return}
  if(sim.t>=DUR)reset();
  $('bRun').textContent='Pause';$('dot').classList.add('on');
  timer=setInterval(function(){
    acc+=(+$('sSpeed').value)/10;var n=Math.floor(acc);acc-=n;
    for(var i=0;i<n&&sim.t<DUR;i++)sim.step();
    if(sim.t>=DUR){stop();sim.say('Shift ended','a')}
    render();
  },100);
}
function fmtT(t){var m=8*60+t;return ('0'+Math.floor(m/60)%24).slice(-2)+':'+('0'+m%60).slice(-2)}
function esc(s){return String(s).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
function chip(p,t,solid){var wait=t-p.arrival;var aged=wait>THRESH[p.sev];return '<span class="pt c'+p.sev+(solid?' solid':'')+(aged?' aged':'')+'" title="Waiting '+wait+' min">P'+p.sev+' #'+p.id+(solid?'':' &middot; '+wait+'m')+'</span>'}
function threadRows(){
  var rows=[['Patient arrival generator','RUNNING',sim.pi+' / '+sim.pending.length+' arrived'],
   ['Dispatcher (scheduler)',sim.dispatched?'RUNNING':'WAITING',sim.dispatched?'assigned '+sim.dispatched:'cv wait'] ];
  sim.docs.forEach(function(d){
    var st,note;
    if(d.state==='IDLE'){st='WAITING';note='cv wait: no patient'}
    else if(d.state==='ACQUIRE'){ if(d.blocked){st='BLOCKED';note='sem: '+RNAME[d.blocked]}else{st='RUNNING';note='acquiring'} }
    else if(d.state==='TREAT'){st='RUNNING';note='treating #'+d.p.id}
    else if(d.state==='FAULT'){st='FAULT';note='no heartbeat'}
    else {st='RESTART';note='restarting'}
    rows.push(['Doctor thread '+(d.id+1),st,note]);
  });
  rows.push(['Fault monitor','RUNNING','deadline '+HEARTBEAT_DEADLINE+' min']);
  rows.push(['Metrics collector','RUNNING','sampling 1 min']);
  return rows;
}
function renderSpark(){
  var W=520,H=150,L=28,B=18,T=8,R=6,h=sim.hist,n=Math.max(h.length,2);
  var mx=1;h.forEach(function(c){var s=Math.max.apply(null,c);if(s>mx)mx=s});mx=Math.ceil(mx/5)*5||5;
  var x=function(i){return L+(W-L-R)*i/(DUR-1)},y=function(v){return T+(H-T-B)*(1-v/mx)};
  var g='';
  for(var k=0;k<=2;k++){var v=mx*k/2;g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="var(--line)"/><text x="'+(L-5)+'" y="'+(y(v)+4)+'" text-anchor="end" font-size="10" fill="var(--muted)" font-family="IBM Plex Mono,monospace">'+Math.round(v)+'</text>'}
  [0,120,240,360,480].forEach(function(m){var xx=x(Math.min(m,DUR-1));g+='<text x="'+xx+'" y="'+(H-4)+'" text-anchor="'+(m===0?'start':m===480?'end':'middle')+'" font-size="10" fill="var(--muted)" font-family="IBM Plex Mono,monospace">'+fmtT(m)+'</text>'});
  for(var s=0;s<4;s++){
    if(h.length<2)continue;
    var pts=h.map(function(c,i){return x(i).toFixed(1)+','+y(c[s]).toFixed(1)}).join(' ');
    g+='<polyline fill="none" stroke="var(--p'+(s+1)+')" stroke-width="1.8" stroke-linejoin="round" points="'+pts+'"/>';
    var last=h.length-1;g+='<circle cx="'+x(last)+'" cy="'+y(h[last][s])+'" r="3" fill="var(--p'+(s+1)+')"/>';
  }
  $('spark').innerHTML=g;
}
function render(){
  var t=sim.t,w=weights(),cmp=cmpFn($('sStrat').value,t,w);
  $('clock').innerHTML='<b>'+fmtT(t)+'</b>';$('shift').textContent='shift '+t+' / '+DUR+' min';
  $('formula').innerHTML='Score(p) = <b>'+w.a.toFixed(2)+'</b> &times; Severity + <b>'+w.b.toFixed(2)+'</b> &times; WaitingTime + <b>'+w.g.toFixed(2)+'</b> &times; Aging &nbsp;(used by the aging policy; severity is 1.0 for P1 down to 0.25 for P4)';
  $('docs').innerHTML=sim.docs.map(function(d){
    var st=d.state==='IDLE'?'WAITING':d.state==='ACQUIRE'?(d.blocked?'BLOCKED':'RUNNING'):d.state==='TREAT'?'RUNNING':d.state==='FAULT'?'FAULT':'RESTART';
    var lbl=d.state==='IDLE'?'IDLE':d.state==='ACQUIRE'?(d.blocked?'BLOCKED':'ACQUIRE'):d.state==='TREAT'?'BUSY':d.state==='FAULT'?'FAULT':'RESTART';
    var body=d.p?chip(d.p,t,true)+'<div class="sub">'+(d.blocked?'waiting for '+RNAME[d.blocked]:d.state==='TREAT'?d.rem+' min left':'')+(d.held.length?' &middot; holds '+d.held.join(', '):'')+'</div>':'<div class="sub">'+(d.state==='RECOVER'?'restarting':'waiting on condition variable')+'</div>';
    var pc=d.p&&d.state==='TREAT'?Math.round(100*(1-d.rem/d.p.treat)):0;
    return '<div class="doc"><div class="hd"><span>Doctor '+(d.id+1)+'</span><span class="pill '+st+'">'+lbl+'</span></div>'+body+'<div class="bar"><i style="width:'+pc+'%"></i></div></div>';
  }).join('');
  $('res').innerHTML=ORDER.map(function(k){var s=sim.sems[k],u='';for(var i=0;i<s.cap;i++)u+='<i class="'+(i<s.n?'free':'')+'"></i>';
    return '<div class="rs"><div class="hd"><span>'+RNAME[k]+'</span><span class="mono">'+s.n+' / '+s.cap+' free</span></div><div class="units">'+u+'</div><div class="sub" style="margin-top:6px">'+(s.q.length?s.q.length+' thread(s) blocked':'no waiters')+'</div></div>'}).join('');
  var sorted=sim.queue.slice().sort(cmp),qs='';
  for(var s=1;s<=4;s++){
    var list=sorted.filter(function(p){return p.sev===s}),shown=list.slice(0,10);
    qs+='<div class="q c'+s+'"><div class="hd"><b>P'+s+' '+SEV[s]+'</b><span>'+list.length+'</span></div><div class="chips">'+(shown.map(function(p){return chip(p,t)}).join('')||'<span class="sub">empty</span>')+(list.length>10?'<span class="sub">+'+(list.length-10)+' more</span>':'')+'</div></div>';
  }
  $('queues').innerHTML=qs;
  $('threads').innerHTML=threadRows().map(function(r){return '<tr><td>'+r[0]+'</td><td><span class="pill '+r[1]+'">'+r[1]+'</span></td><td>'+esc(r[2])+'</td></tr>'}).join('');
  $('lockinfo').textContent='mutex acquisitions: '+sim.lockOps;
  $('log').innerHTML=sim.log.slice(-14).reverse().map(function(e){return '<div class="'+(e.kind||'')+'"><time>'+fmtT(e.t)+'</time><span>'+esc(e.msg)+'</span></div>'}).join('');
  var st=sim.stats();
  var fr=sim.faults.length?sim.faults.map(function(f){return f.detect+'+'+f.recover}).join(', ')+' min':'none';
  $('tiles').innerHTML=[['Treated',st.treated,'patients done'],['Waiting',st.waiting,'in queues'],['Avg wait',st.avg.all.toFixed(1),'minutes, all priorities'],['Throughput',st.thru.toFixed(1),'patients / hour'],['Doctor use',Math.round(st.util*100)+'%','busy time'],['Threshold breaches',st.viol,'maximum-wait monitor'],['Faults handled',sim.faults.length,'detect + recover: '+fr]]
    .map(function(x){return '<div class="tile"><span class="lbl">'+x[0]+'</span><b>'+x[1]+'</b><span class="sub">'+x[2]+'</span></div>'}).join('');
  $('waitTable').innerHTML='<tr><th>Priority</th><th>Started</th><th>Avg wait</th><th>Max wait</th><th>Limit</th></tr>'+[1,2,3,4].map(function(k){return '<tr><td><span class="pt c'+k+'">P'+k+'</span> '+SEV[k]+'</td><td>'+st.n[k]+'</td><td>'+st.avg[k].toFixed(1)+'</td><td>'+st.max[k]+'</td><td>'+THRESH[k]+'</td></tr>'}).join('');
  renderSpark();
}
// ---------- comparison
var POL=[['fcfs','First come, first served','var(--muted)'],['priority','Strict priority','var(--p3)'],['aging','Priority + aging','var(--accent)']];
function compare(){
  var base={load:workload(+$('nSeed').value,+$('nRate').value,DUR),doctors:Math.max(1,Math.min(6,+$('nDoc').value||3)),dur:DUR,w:function(){return weights()}};
  cmpResult=POL.map(function(p){var s=headless(p[0],base);return {key:p[0],name:p[1],color:p[2],st:s.stats()}});
  drawCmp();
}
function drawCmp(){
  if(!cmpResult)return;
  var W=520,H=260,L=34,B=44,T=10,R=6,mx=1;
  cmpResult.forEach(function(r){for(var k=1;k<=4;k++)if(r.st.avg[k]>mx)mx=r.st.avg[k]});mx=Math.ceil(mx/10)*10;
  var gw=(W-L-R)/4,bw=Math.min(28,(gw-16)/3),g='';
  for(var i=0;i<=4;i++){var v=mx*i/4,yy=T+(H-T-B)*(1-v/mx);g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--line)"/><text x="'+(L-5)+'" y="'+(yy+4)+'" text-anchor="end" font-size="10" fill="var(--muted)" font-family="IBM Plex Mono,monospace">'+Math.round(v)+'</text>'}
  for(var k=1;k<=4;k++){
    var cx=L+gw*(k-1)+gw/2;
    cmpResult.forEach(function(r,j){var v=r.st.avg[k],hh=(H-T-B)*v/mx,x0=cx+(j-1)*(bw+3)-bw/2;
      g+='<rect x="'+x0+'" y="'+(H-B-hh)+'" width="'+bw+'" height="'+Math.max(hh,0.5)+'" rx="2" fill="'+r.color+'"/>';
      g+='<text x="'+(x0+bw/2)+'" y="'+(H-B-hh-4)+'" text-anchor="middle" font-size="9.5" fill="var(--ink)" font-family="IBM Plex Mono,monospace">'+v.toFixed(0)+'</text>'});
    g+='<text x="'+cx+'" y="'+(H-B+16)+'" text-anchor="middle" font-size="11" fill="var(--ink)" font-family="IBM Plex Sans,sans-serif">P'+k+' '+SEV[k]+'</text>';
  }
  g+='<text x="'+(L)+'" y="'+(H-4)+'" font-size="10" fill="var(--muted)" font-family="IBM Plex Sans,sans-serif">Average wait before treatment starts (minutes); measured in this simulation</text>';
  $('cmpChart').innerHTML=g;
  $('cmpLegend').innerHTML=cmpResult.map(function(r){return '<span><i style="background:'+r.color+'"></i>'+r.name+'</span>'}).join('');
  $('cmpTable').innerHTML='<tr><th>Policy</th><th>Avg wait</th><th>Max P1</th><th>Max P4</th><th>Breaches</th><th>Per hour</th></tr>'+cmpResult.map(function(r){return '<tr><td>'+r.name+'</td><td>'+r.st.avg.all.toFixed(1)+'</td><td>'+r.st.max[1]+'</td><td>'+r.st.max[4]+'</td><td>'+r.st.viol+'</td><td>'+r.st.thru.toFixed(1)+'</td></tr>'}).join('');
}
// ---------- csv
function copyText(text,ta){
  ta.hidden=false;ta.value=text;ta.focus();ta.select();
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).catch(function(){})}
}
function liveCsv(){
  var rows=['patient_id,priority,arrival_min,start_min,done_min,wait_min,requeued'];
  sim.all.forEach(function(p){rows.push([p.id,p.sev,p.arrival,p.start===null?'':p.start,p.done===null?'':p.done,p.start===null?'':p.start-p.arrival,p.requeued].join(','))});
  return rows.join('\n');
}
function cmpCsv(){
  var rows=['policy,priority,patients_started,avg_wait_min,max_wait_min'];
  cmpResult.forEach(function(r){for(var k=1;k<=4;k++)rows.push([r.name,'P'+k,r.st.n[k],r.st.avg[k].toFixed(2),r.st.max[k]].join(','))});
  return rows.join('\n');
}
// ---------- race lab
function Mutex(){this.locked=false;this.q=[]}
Mutex.prototype.lock=function(){var s=this;return new Promise(function(res){if(!s.locked){s.locked=true;res()}else s.q.push(res)})};
Mutex.prototype.unlock=function(){var n=this.q.shift();if(n)n();else this.locked=false};
function yieldSome(r){return r()<0.3?new Promise(function(res){setTimeout(res,0)}):Promise.resolve()}
async function raceRun(n,safe){
  var c=0,m=new Mutex(),r=rng(99+(safe?1:0));
  async function worker(){for(var i=0;i<n;i++){
    if(safe){await m.lock();var v=c;await yieldSome(r);c=v+1;m.unlock()}
    else{var u=c;await yieldSome(r);c=u+1}
  }}
  await Promise.all([worker(),worker(),worker()]);return c;
}
async function race(){
  var n=Math.max(50,Math.min(3000,+$('nOps').value||300)),exp=3*n;
  $('bRace').disabled=true;
  var bad=await raceRun(n,false),good=await raceRun(n,true);
  $('rBadV').textContent=bad+' / '+exp;$('rGoodV').textContent=good+' / '+exp;
  $('rBadS').textContent=(exp-bad)+' updates lost: two threads read the same value and both wrote it back.';
  $('rGoodS').textContent=good===exp?'No updates lost. The lock keeps each read-modify-write indivisible.':'Unexpected result: '+good;
  $('raceBad').className='r '+(bad<exp?'bad':'');$('raceGood').className='r '+(good===exp?'good':'');
  $('bRace').disabled=false;
}
// ---------- wiring
$('bRun').onclick=run;
$('bStep').onclick=function(){stop();if(sim.t<DUR)sim.step();render()};
$('bReset').onclick=reset;
$('bSurge').onclick=function(){sim.surge(10,sim.t+1234);render()};
$('bFault').onclick=function(){sim.injectFault();render()};
['nDoc','nRate','nSeed'].forEach(function(id){$(id).onchange=reset});
['sStrat','wA','wB','wG'].forEach(function(id){$(id).oninput=function(){render()}});
$('bCmp').onclick=compare;
$('bCsvLive').onclick=function(){copyText(liveCsv(),$('csvLive'))};
$('bCsvCmp').onclick=function(){if(!cmpResult)compare();copyText(cmpCsv(),$('csvCmp'))};
$('bRace').onclick=race;
if(window.matchMedia)window.matchMedia('(prefers-color-scheme: dark)').addEventListener&&window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(){drawCmp()});
reset();
// open in a realistic working state: run the first stretch of the shift so the floor is populated
var i0=0;while(i0<400&&!(sim.t>=120&&sim.queue.length>=5)){sim.step();i0++}
if(sim.t<30)for(;sim.t<150;)sim.step();
render();compare();
})();
