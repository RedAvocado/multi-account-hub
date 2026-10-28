'use strict';
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const childProcess=require('node:child_process');
const {AdminError}=require('./admin-service.cjs');
const {ConnectError}=require('./claude-connect-service.cjs');

function unusedPort() {
  return new Promise((resolve,reject)=>{
    const server=net.createServer();server.on('error',reject);
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});
  });
}
function createProviderConnect({directory,admin,helper=path.join(directory,'cliproxyapi-auth-helper'),
  now=Date.now,spawn=childProcess.spawn}) {
  const root=path.join(directory,'pending-logins'),flows=new Map();
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  fs.chmodSync(root,0o700);
  function removeStage(stage) {
    try {
      if (path.dirname(stage)!==root || !/^auth-[A-Za-z0-9]+$/.test(path.basename(stage)) || !fs.lstatSync(stage).isDirectory()) return;
      fs.rmSync(stage,{recursive:true,force:true});
    } catch (_) {}
  }
  // Reap interrupted sign-ins left by a portal restart. Verify both the helper
  // executable and its exact staging config before signaling a recorded PID.
  for (const name of fs.readdirSync(root)) {
    if (!/^auth-[A-Za-z0-9]+$/.test(name)) continue;
    const stage=path.join(root,name);
    try {
      if (!fs.lstatSync(stage).isDirectory()) continue;
      const pid=Number(fs.readFileSync(path.join(stage,'pid'),'utf8'));
      if (Number.isSafeInteger(pid) && pid>1) {
        const result=childProcess.spawnSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8',timeout:2000});
        const command=result.stdout || '';
        if (command.includes(helper) && command.includes(path.join(stage,'config.yaml'))) { try {process.kill(pid,'SIGTERM');} catch (_) {} }
      }
    } catch (_) {}
    removeStage(stage);
  }
  function stop(flow) {
    if (flow.child && flow.child.exitCode===null && !flow.child.killed) {try {flow.child.kill('SIGTERM');} catch (_) {}}
    if (flow.stage) removeStage(flow.stage);
    flow.output='';
  }
  function clean() {
    for (const [id,flow] of flows) if (flow.expires<=now()) {flows.delete(id);stop(flow);}
  }
  const timer=setInterval(clean,60000);timer.unref();
  const owns=(flow,identity)=>flow && flow.name===identity.name && flow.email===identity.email;
  function current(identity) {clean();const flow=flows.get(identity.id);return owns(flow,identity)?flow:null;}
  function describe(flow) {
    if (!flow) return {status:'idle'};
    if (flow.status==='waiting') return {status:'waiting',provider:flow.provider,visibility:flow.visibility,
      ...(flow.provider==='claude'?{url:flow.url}:{url:'https://auth.openai.com/codex/device',deviceCode:flow.deviceCode})};
    if (flow.status==='complete') return {status:'complete',provider:flow.provider,account:flow.account,assigned:flow.assigned,visibility:flow.visibility};
    if (flow.status==='failed') return {status:'failed',message:flow.message || 'Provider sign-in did not complete. Please try again.'};
    return {status:flow.status,provider:flow.provider};
  }
  async function start(identity,input) {
    if (!input || Object.keys(input).sort().join(',')!=='provider,visibility' || !['claude','codex'].includes(input.provider) || !['personal','team'].includes(input.visibility)) throw new ConnectError(400,'Choose a provider and sharing setting.');
    let flow=current(identity);
    if (flow && ['starting','waiting','exchanging','finishing'].includes(flow.status)) return describe(flow);
    if (flows.size>=16) throw new ConnectError(503,'Provider sign-in is busy. Please try again shortly.');
    flow={name:identity.name,email:identity.email,provider:input.provider,visibility:input.visibility,status:'starting',
      expires:now()+(input.provider==='codex'?15:5)*60*1000,output:'',done:false};
    flows.set(identity.id,flow);
    try {
      const stage=fs.mkdtempSync(path.join(root,'auth-'));fs.chmodSync(stage,0o700);flow.stage=stage;
      const authDir=path.join(stage,'auth');fs.mkdirSync(authDir,{mode:0o700});flow.authDir=authDir;
      const config=path.join(stage,'config.yaml');
      fs.writeFileSync(config,`host: "127.0.0.1"\nport: 0\nauth-dir: ${JSON.stringify(authDir)}\ndebug: false\nlogging-to-file: false\n`,{mode:0o600,flag:'wx'});
      const args=['-config',config,input.provider==='claude'?'-claude-login':'-codex-device-login','-no-browser'];
      if (input.provider==='claude') args.push('-oauth-callback-port',String(await unusedPort()));
      if (flows.get(identity.id)!==flow) throw new Error('cancelled');
      const child=spawn(helper,args,{cwd:stage,stdio:['pipe','pipe','pipe']});flow.child=child;
      fs.writeFileSync(path.join(stage,'pid'),String(child.pid),{mode:0o600,flag:'wx'});
      const ready=await new Promise((resolve,reject)=>{
        let settled=false;
        const timeout=setTimeout(()=>finish(new Error('timeout')),25000);
        function finish(error,value) {if(settled)return;settled=true;clearTimeout(timeout);error?reject(error):resolve(value);}
        function output(chunk) {
          flow.output=(flow.output+chunk.toString('utf8')).slice(-65536);
          if (input.provider==='claude') {
            const match=/https:\/\/claude\.ai\/oauth\/authorize\?[^\s]+/.exec(flow.output);
            if (match) {
              try {
                const url=new URL(match[0]);const state=url.searchParams.get('state');
                if (!/^[a-f0-9]{32}$/.test(state||'') || url.searchParams.get('redirect_uri')!=='http://localhost:54545/callback' || url.searchParams.get('code_challenge_method')!=='S256') throw new Error('invalid URL');
                flow.state=state;finish(null,{url:url.href});
              } catch (_) {finish(new Error('invalid URL'));}
            }
          } else {
            const match=/Codex device code:\s*([A-Z0-9-]{4,32})/i.exec(flow.output);
            if (match) finish(null,{deviceCode:match[1]});
          }
        }
        child.stdout.on('data',output);child.stderr.on('data',output);
        child.on('error',()=>finish(new Error('start failed')));
        child.on('close',code=>{flow.done=true;flow.exitCode=code;finish(new Error('login stopped'));});
      });
      if (flows.get(identity.id)!==flow) throw new Error('cancelled');
      Object.assign(flow,ready,{status:'waiting',output:''});
      return describe(flow);
    } catch (_) {
      if (flows.get(identity.id)===flow) flows.delete(identity.id);
      stop(flow);throw new ConnectError(503,'Provider sign-in could not be started. Please try again.');
    }
  }
  async function submit(identity,input) {
    const flow=current(identity);
    if (!flow || flow.provider!=='claude' || flow.status!=='waiting') throw new ConnectError(409,'Start a new Claude sign-in.');
    if (!input || Object.keys(input).join(',')!=='callback' || typeof input.callback!=='string' || input.callback.length>3500) throw new ConnectError(400,'Paste the complete address from your browser.');
    let callback;try{callback=new URL(input.callback.trim());}catch(_){throw new ConnectError(400,'Paste the complete address from your browser.');}
    const code=callback.searchParams.get('code');
    if (callback.origin!=='http://localhost:54545' || callback.pathname!=='/callback' || callback.username || callback.password || callback.hash ||
        callback.searchParams.getAll('state').length!==1 || callback.searchParams.getAll('code').length!==1 || callback.searchParams.get('state')!==flow.state ||
        !code || code.length>2048 || /[\s\x00-\x1f\x7f]/.test(code)) throw new ConnectError(400,'That address does not match this sign-in. Start over if it expired.');
    if (flow.done || !flow.child?.stdin?.writable) throw new ConnectError(409,'That sign-in has expired. Please start again.');
    flow.status='exchanging';
    flow.child.stdin.write(callback.href+'\n');
    return describe(flow);
  }
  async function status(identity) {
    const flow=current(identity);
    if (!flow || !['waiting','exchanging','finishing'].includes(flow.status) || !flow.done) return describe(flow);
    if (flow.finishing) return flow.finishing;
    flow.status='finishing';
    flow.finishing=(async()=>{
      try {
        const files=fs.readdirSync(flow.authDir).filter(file=>file.endsWith('.json'));
        if (flow.exitCode!==0 || files.length!==1 || path.basename(files[0])!==files[0]) throw new Error('no account');
        const target=path.join(flow.authDir,files[0]);
        if (!fs.lstatSync(target).isFile() || fs.statSync(target).size>1024*1024) throw new Error('invalid account');
        const record=JSON.parse(fs.readFileSync(target,'utf8'));
        if (record.type!==flow.provider) throw new Error('wrong provider');
        if (flows.get(identity.id)!==flow) return {status:'idle'};
        const result=await admin.claimAccount(identity,record,flow.visibility);
        if (flows.get(identity.id)!==flow) return {status:'idle'};
        flow.account=result.email;flow.assigned=result.assigned;flow.status='complete';
      } catch (error) {
        flow.status='failed';flow.message=error instanceof AdminError?error.message:'Provider sign-in did not complete. Please try again.';
      } finally {stop(flow);}
      return describe(flow);
    })();
    return flow.finishing;
  }
  async function cancel(identity) {const flow=current(identity);if(flow){flows.delete(identity.id);stop(flow);}}
  function close() {clearInterval(timer);for(const flow of flows.values())stop(flow);flows.clear();}
  return {start,submit,status,cancel,close};
}
module.exports={createProviderConnect};
