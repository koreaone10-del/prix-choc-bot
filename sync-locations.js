const fs = require('fs');
const path = require('path');
const locationTools = require('./locations.js');

let puppeteer = null;
let chromium = null;

const delay = ms => new Promise(r => setTimeout(r, ms));
const clean = value => String(value || '')
  .normalize('NFKC')
  .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
  .replace(/\u00A0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const norm = value => clean(value)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’'`]/g, '').replace(/[-_/.,]/g, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase();

async function loadBrowserModules() {
  if (!puppeteer) {
    const m = await import('puppeteer-core');
    puppeteer = m.default || m;
  }
  if (!chromium) {
    const m = await import('@sparticuz/chromium');
    chromium = m.default || m;
  }
}

async function login(page) {
  const loginUrl = process.env.SAWA9LY_LOGIN_URL || 'https://affiliate.sawa9ly.pro/login';
  const email = process.env.SAWA9LY_EMAIL || '';
  const password = process.env.SAWA9LY_PASSWORD || '';
  if (!email || !password) throw new Error('SAWA9LY_EMAIL / SAWA9LY_PASSWORD غير موجودين في Environment Variables.');

  await page.goto(loginUrl, {waitUntil:'domcontentloaded', timeout:60000});
  await page.waitForSelector('input[type="email"]', {timeout:20000});
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  const submit = await page.$('button[type="submit"]');
  if (submit) await submit.click(); else await page.keyboard.press('Enter');
  await delay(5000);
  if (/\/login/i.test(page.url())) throw new Error('تسجيل الدخول إلى Sawa9ly لم ينجح.');
  console.log(`✅ Logged in: ${page.url()}`);
}

async function openCheckout(page) {
  const configured = process.env.SAWA9LY_LOCATION_PRODUCT_URL;
  if (configured) {
    await page.goto(configured, {waitUntil:'networkidle2', timeout:60000});
  } else {
    const id = process.env.SAWA9LY_LOCATION_PRODUCT_ID || '6252';
    await page.goto(`https://affiliate.sawa9ly.pro/store/${id}`, {waitUntil:'networkidle2', timeout:60000});
  }
  await delay(2500);

  const clicked = await page.evaluate(() => {
    const wanted = ['commander maintenant','commander','اطلب الآن','طلب الآن','buy now'];
    const norm = t => String(t || '').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
    const visible = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'; };
    const els = Array.from(document.querySelectorAll('button,a,[role="button"]')).filter(visible);
    const hit = els.find(el => { const t=norm(el.innerText||el.textContent||el.getAttribute('aria-label')); return wanted.some(w=>t===w||t.includes(w)); });
    if (!hit) return false;
    hit.click(); return true;
  });
  if (!clicked) throw new Error('لم أجد زر Commander maintenant في منتج المزامنة.');
  await delay(1200);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(500);
}

async function inspectControls(page) {
  return page.evaluate(() => {
    const visible = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'; };
    return Array.from(document.querySelectorAll('select')).filter(visible).map((el,index)=>({
      index,
      id:el.id||'', name:el.name||'', aria:el.getAttribute('aria-label')||'',
      options:Array.from(el.options).map(o=>({text:(o.textContent||'').trim(),value:o.value,disabled:o.disabled})).filter(o=>o.text)
    }));
  });
}

function codeOf(text) {
  const m = String(text || '').trim().match(/^(?:0?)(\d{1,2})\s*[-–—:]/);
  return m ? String(Number(m[1])).padStart(2,'0') : '';
}

async function selectWilayaNative(page, code, french) {
  const result = await page.evaluate(({code,french}) => {
    const norm = t => String(t||'').normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’'`]/g,'').replace(/[-_/.,]/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
    const visible = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'; };
    const selects=Array.from(document.querySelectorAll('select')).filter(visible);
    const wantedCode=String(code).padStart(2,'0');
    let best=null;
    for(const el of selects){
      const opts=Array.from(el.options).filter(o=>!o.disabled&&String(o.textContent||'').trim());
      const byCode=opts.find(o=>{const m=String(o.textContent||'').trim().match(/^(?:0?)(\d{1,2})\s*[-–—:]/);return m&&String(Number(m[1])).padStart(2,'0')===wantedCode;});
      const byName=opts.find(o=>norm(o.textContent)===norm(french)||norm(o.textContent).includes(norm(french)));
      if(byCode||byName){best={el,opt:byCode||byName};break;}
    }
    if(!best)return {ok:false,reason:'wilaya-native-select-not-found'};
    best.el.value=best.opt.value;
    best.el.dispatchEvent(new Event('input',{bubbles:true}));
    best.el.dispatchEvent(new Event('change',{bubbles:true}));
    best.el.dispatchEvent(new Event('blur',{bubbles:true}));
    return {ok:true,text:best.opt.textContent,value:best.opt.value};
  },{code,french});
  if(!result.ok) return result;
  await delay(1000);
  return result;
}

async function extractCommuneOptions(page) {
  return page.evaluate(() => {
    const visible = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'; };
    const selects=Array.from(document.querySelectorAll('select')).filter(visible);
    const candidates=selects.map((el,index)=>({el,index,options:Array.from(el.options).filter(o=>!o.disabled&&String(o.textContent||'').trim()).map(o=>({text:String(o.textContent||'').trim(),value:String(o.value||'')}))})).filter(x=>x.options.length>=2);
    // After a wilaya is selected, the commune select is normally the control
    // whose option set is not the 58-wilaya list. Prefer the richest non-wilaya list.
    const scored=candidates.map(x=>{const hasCodes=x.options.filter(o=>/^(?:0?)(?:[1-9]|[1-5]\d|58)\s*[-–—:]/.test(o.text)).length; return {...x,score:x.options.length*2-hasCodes*10};}).sort((a,b)=>b.score-a.score);
    const picked=scored[0];
    return picked ? {index:picked.index,options:picked.options} : {index:-1,options:[]};
  });
}

async function waitForCommuneOptions(page, previousSignature='') {
  const start=Date.now();
  while(Date.now()-start<15000){
    const data=await extractCommuneOptions(page);
    const sig=data.options.map(o=>o.value+'|'+o.text).join('§');
    if(data.options.length>=2 && sig!==previousSignature) return data;
    await delay(500);
  }
  return extractCommuneOptions(page);
}

function databaseArabicCommunes() {
  const dbPath = process.env.PRX_DATABASE_PATH || path.resolve(__dirname,'../database.js');
  if(!fs.existsSync(dbPath)) return {};
  const source=fs.readFileSync(dbPath,'utf8');
  const data=Function(`${source}\nreturn wilayasData;`)();
  return data || {};
}

function buildArabicIndex(db, code) {
  const entry=Object.values(db).find(x=>String(x?.code||'').padStart(2,'0')===code);
  return entry?.communes || [];
}

function bestArabicMatch(ar, options) {
  const candidates=[ar];
  try { candidates.push(locationTools.arabicToLatin(ar)); } catch (_) {}
  const wanted=[...new Set(candidates.map(norm).filter(Boolean))];
  let best=null;
  for(const o of options){
    const n=norm(o.text);
    if(wanted.includes(n)) return {option:o,score:100};
    for(const w of wanted){
      if(n.includes(w)||w.includes(n)) best = (!best || Math.max(n.length,w.length)>best.scoreRaw) ? {option:o,score:85,scoreRaw:Math.max(n.length,w.length)} : best;
    }
  }
  return best ? {option:best.option,score:best.score} : null;
}

async function main(){
  await loadBrowserModules();
  chromium.setGraphicsMode=false;
  const executablePath=await chromium.executablePath();
  const args=await puppeteer.defaultArgs({args:[...chromium.args,'--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote'],headless:'shell'});
  const browser=await puppeteer.launch({executablePath,headless:'shell',args,defaultViewport:chromium.defaultViewport});
  const page=await browser.newPage();
  await page.setViewport({width:1280,height:900});
  const db=databaseArabicCommunes();
  const result={generatedAt:new Date().toISOString(),source:'Sawa9ly Affiliate live checkout',wilayas:{},summary:{wilayas:0,communes:0,matchedArabic:0,unmatchedArabic:0}};
  try{
    await login(page);
    await openCheckout(page);
    for(let n=1;n<=58;n++){
      const code=String(n).padStart(2,'0');
      const french=locationTools.WILAYA_FR_BY_CODE?.[code] || '';
      console.log(`\n🏁 ${code} - ${french}`);
      const controls=await inspectControls(page);
      console.log(`   Native selects visible: ${controls.length}`);
      const selected=await selectWilayaNative(page,code,french);
      if(!selected.ok){
        console.log(`   ❌ ${selected.reason}`);
        result.wilayas[code]={nameFr:french,ok:false,error:selected.reason,communes:[]};
        continue;
      }
      console.log(`   ✅ Wilaya: ${selected.text}`);
      const extracted=await waitForCommuneOptions(page);
      const options=extracted.options;
      console.log(`   📋 Sawa9ly communes found: ${options.length}`);
      const arList=buildArabicIndex(db,code);
      const communes=options.map((o,index)=>({order:index+1,fr:o.text,value:o.value}));
      const mapped=[];
      const used=new Set();
      for(const ar of arList){
        const match=bestArabicMatch(ar,options.filter(o=>!used.has(o.value)));
        if(match){used.add(match.option.value);mapped.push({ar,fr:match.option.text,value:match.option.value,matchScore:match.score});result.summary.matchedArabic++;}
        else{mapped.push({ar,fr:'',value:'',matchScore:0});result.summary.unmatchedArabic++;}
      }
      result.wilayas[code]={nameFr:french,selectedText:selected.text,ok:true,communes,mappedArabic:mapped};
      result.summary.wilayas++;
      result.summary.communes+=communes.length;
    }
    const out=process.env.PRX_LOCATION_OUTPUT || path.resolve(__dirname,'sawa9ly-locations.json');
    fs.writeFileSync(out,JSON.stringify(result,null,2),'utf8');
    console.log(`\n✅ Saved: ${out}`);
    console.log(JSON.stringify(result.summary));
    if(result.summary.wilayas<58) process.exitCode=2;
  } finally { await browser.close(); }
}

main().catch(err=>{console.error('❌ Location sync failed:',err.stack||err.message);process.exitCode=1;});
