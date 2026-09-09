const fs = require('fs');
const path = require('path');

let puppeteer = null;
let chromium = null;
const delay = ms => new Promise(r => setTimeout(r, ms));

const clean = v => String(v ?? '')
  .normalize('NFKC')
  .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
  .replace(/\u00A0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const norm = v => clean(v).normalize('NFD')
  .replace(/[\u0300-\u036f]/g,'')
  .replace(/[’'`]/g,'')
  .replace(/[-_/.,]/g,' ')
  .replace(/\s+/g,' ')
  .trim().toLowerCase();

const codeOf = text => {
  const m = clean(text).match(/^(?:0?)(\d{1,2})\s*[-–—:]/);
  return m ? String(Number(m[1])).padStart(2,'0') : '';
};

async function loadBrowserModules(){
  if(!puppeteer){ const m=await import('puppeteer-core'); puppeteer=m.default||m; }
  if(!chromium){ const m=await import('@sparticuz/chromium'); chromium=m.default||m; }
}

async function login(page){
  const url=process.env.SAWA9LY_LOGIN_URL||'https://affiliate.sawa9ly.pro/login';
  if(!process.env.SAWA9LY_EMAIL||!process.env.SAWA9LY_PASSWORD)
    throw new Error('SAWA9LY_EMAIL / SAWA9LY_PASSWORD غير موجودين.');
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForSelector('input[type="email"]',{timeout:20000});
  await page.type('input[type="email"]',process.env.SAWA9LY_EMAIL);
  await page.type('input[type="password"]',process.env.SAWA9LY_PASSWORD);
  const submit=await page.$('button[type="submit"]');
  if(submit) await submit.click(); else await page.keyboard.press('Enter');
  await delay(5000);
  if(/\/login/i.test(page.url())) throw new Error('تسجيل الدخول إلى Sawa9ly لم ينجح.');
  console.log(`✅ Logged in: ${page.url()}`);
}

async function waitForOrderForm(page,timeout=20000){
  const start=Date.now();
  while(Date.now()-start<timeout){
    const ok=await page.evaluate(()=>/finaliser la commande|produits sélectionnés|prix de vente|mode de livraison|informations client/i.test(document.body?.innerText||'')).catch(()=>false);
    if(ok) return true;
    await delay(500);
  }
  return false;
}

async function closeDrawer(page){
  try{ await page.mouse.click(80,420); await delay(500); }catch(_){}
  for(let i=0;i<4;i++){
    const changed=await page.evaluate(()=>{
      const norm=t=>String(t||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
      const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'};
      const labels=['fermer','close','×','✕','إغلاق'];
      for(const e of document.querySelectorAll('button,[role="button"],a')){
        if(!visible(e)) continue;
        const t=norm(e.innerText||e.textContent||e.getAttribute('aria-label')||e.title);
        if(labels.includes(t)){e.click();return true;}
      }
      return false;
    }).catch(()=>false);
    if(!changed) break;
    await delay(500);
  }
}

async function openCheckout(page){
  const id=process.env.SAWA9LY_LOCATION_PRODUCT_ID||'6252';
  const url=process.env.SAWA9LY_LOCATION_PRODUCT_URL||`https://affiliate.sawa9ly.pro/store/${id}`;
  await page.goto(url,{waitUntil:'networkidle2',timeout:60000});
  await delay(2500);
  const clicked=await page.evaluate(()=>{
    const wanted=['commander maintenant','commander','اطلب الآن','طلب الآن','buy now'];
    const norm=t=>String(t||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'};
    const els=Array.from(document.querySelectorAll('button,a,[role="button"]')).filter(visible);
    const hit=els.find(e=>{const t=norm(e.innerText||e.textContent||e.getAttribute('aria-label'));return wanted.some(w=>t===w||t.includes(w));});
    if(!hit) return false; hit.scrollIntoView({block:'center'}); hit.click(); return true;
  });
  if(!clicked) throw new Error('لم أجد Commander maintenant.');
  await delay(1000);
  if(!(await waitForOrderForm(page,20000))) throw new Error('Checkout لم يظهر.');
  await closeDrawer(page);
  await delay(1200);
}

async function inspectSelects(page){
  return page.evaluate(()=>{
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'};
    return Array.from(document.querySelectorAll('select')).filter(visible).map((el,index)=>({
      index,id:el.id||'',name:el.name||'',aria:el.getAttribute('aria-label')||'',
      options:Array.from(el.options).filter(o=>!o.disabled&&String(o.textContent||'').trim()).map(o=>({text:String(o.textContent||'').trim(),value:String(o.value||'')}))
    }));
  });
}

async function waitForWilayaReady(page,timeout=30000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const s=await inspectSelects(page);
    if(s.some(x=>x.options.length>=40)) return s;
    await delay(500);
  }
  return inspectSelects(page);
}

async function selectWilaya(page,code,french){
  const result=await page.evaluate(({code,french})=>{
    const clean=v=>String(v||'').normalize('NFKC').replace(/\s+/g,' ').trim();
    const norm=v=>clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'};
    const code2=String(code).padStart(2,'0');
    const selects=Array.from(document.querySelectorAll('select')).filter(visible);
    const pick=selects.find((el,i)=>i===0 && Array.from(el.options).some(o=>/^(?:0?)(\d{1,2})\s*[-–—:]/.test(clean(o.textContent)))) || selects[0];
    if(!pick) return {ok:false,reason:'wilaya-select-missing'};
    const opts=Array.from(pick.options).filter(o=>!o.disabled&&clean(o.textContent));
    const codeOf=t=>{const m=clean(t).match(/^(?:0?)(\d{1,2})\s*[-–—:]/);return m?String(Number(m[1])).padStart(2,'0'):''};
    let option=opts.find(o=>codeOf(o.textContent)===code2);
    if(!option) option=opts.find(o=>String(o.value||'').padStart(2,'0')===code2);
    if(!option) option=opts.find(o=>norm(o.textContent)===norm(french));
    if(!option) return {ok:false,reason:'wilaya-option-not-found',diagnostics:selects.map((el,i)=>({i,count:el.options.length,options:Array.from(el.options).slice(0,8).map(o=>clean(o.textContent))}))};
    pick.focus();pick.value=option.value;
    pick.dispatchEvent(new Event('input',{bubbles:true}));
    pick.dispatchEvent(new Event('change',{bubbles:true}));
    pick.dispatchEvent(new Event('blur',{bubbles:true}));
    return {ok:true,text:clean(option.textContent),value:String(option.value||''),index:selects.indexOf(pick)};
  },{code,french});
  if(result.ok) console.log(`   🧭 Wilaya selected: ${result.text}`);
  else console.log(`   ❌ Wilaya diagnostics: ${JSON.stringify(result)}`);
  return result;
}

async function waitForCommunes(page,excludeIndex=0,timeout=25000){
  const end=Date.now()+timeout;
  let last=[];
  while(Date.now()<end){
    const s=await inspectSelects(page);
    last=s;
    const candidates=s.filter(x=>x.index!==excludeIndex && x.options.length>=2);
    if(candidates.length){
      candidates.sort((a,b)=>b.options.length-a.options.length);
      return candidates[0];
    }
    await delay(500);
  }
  return last.filter(x=>x.index!==excludeIndex).sort((a,b)=>b.options.length-a.options.length)[0] || {index:-1,options:[]};
}

function loadArabicDatabase(){
  const dbPath=process.env.PRX_DATABASE_PATH||path.resolve(__dirname,'../database.js');
  if(!fs.existsSync(dbPath)) return {};
  try{
    const source=fs.readFileSync(dbPath,'utf8');
    return Function(`${source}\nreturn typeof wilayasData!=='undefined'?wilayasData:{};`)();
  }catch(_){return {};}
}

function bestArabic(ar,options){
  const wanted=norm(ar);
  if(!wanted) return null;
  let hit=options.find(o=>norm(o.text)===wanted);
  if(hit) return hit;
  const translit=(()=>{try{return norm(require('./locations.js').arabicToLatin(ar));}catch(_){return ''}})();
  hit=options.find(o=>translit && norm(o.text)===translit);
  if(hit) return hit;
  const candidates=options.filter(o=>norm(o.text).includes(wanted)||wanted.includes(norm(o.text)));
  return candidates[0]||null;
}

async function main(){
  await loadBrowserModules();
  chromium.setGraphicsMode=false;
  const executablePath=await chromium.executablePath();
  const args=await puppeteer.defaultArgs({args:[...chromium.args,'--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote'],headless:'shell'});
  const browser=await puppeteer.launch({executablePath,headless:'shell',args,defaultViewport:chromium.defaultViewport});
  const page=await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36');
  await page.setViewport({width:1280,height:900});

  const locations=require('./locations.js');
  const arabicDb=loadArabicDatabase();
  const result={generatedAt:new Date().toISOString(),source:'Sawa9ly Affiliate live checkout',wilayas:{},summary:{wilayas:0,communes:0,matchedArabic:0,unmatchedArabic:0}};

  try{
    await login(page);
    for(let n=1;n<=58;n++){
      const code=String(n).padStart(2,'0');
      const french=locations.WILAYA_FR_BY_CODE?.[code]||'';
      console.log(`\n🏁 ${code} - ${french}`);

      // Fresh checkout for every wilaya avoids stale React controls.
      await openCheckout(page);
      const controls=await waitForWilayaReady(page,30000);
      console.log(`   Native selects visible: ${controls.length}`);
      console.log(`   Wilaya option counts: ${controls.map(x=>x.options.length).join(', ')}`);

      let selected=await selectWilaya(page,code,french);
      if(!selected.ok){
        await delay(3000);
        selected=await selectWilaya(page,code,french);
      }
      if(!selected.ok){
        result.wilayas[code]={nameFr:french,ok:false,error:selected.reason,communes:[]};
        continue;
      }

      await delay(1000);
      const communeControl=await waitForCommunes(page,selected.index,25000);
      console.log(`   📋 Sawa9ly communes found: ${communeControl.options.length}`);

      const communes=communeControl.options.map((o,i)=>({
        order:i+1,fr:o.text,value:o.value
      }));

      const arEntry=arabicDb?.[french] || arabicDb?.[locations.WILAYA_AR_TO_CODE?.[code]] || null;
      const arList=Array.isArray(arEntry?.communes)?arEntry.communes:[];
      const mappedArabic=[];
      const used=new Set();

      for(const ar of arList){
        const m=bestArabic(ar,communes);
        if(m && !used.has(m.value)){
          used.add(m.value);
          mappedArabic.push({ar,fr:m.text,value:m.value});
          result.summary.matchedArabic++;
        }else{
          mappedArabic.push({ar,fr:'',value:''});
          result.summary.unmatchedArabic++;
        }
      }

      result.wilayas[code]={
        nameFr:french,
        selectedText:selected.text,
        ok:true,
        communes,
        mappedArabic
      };
      result.summary.wilayas++;
      result.summary.communes+=communes.length;
    }

    const out=process.env.PRX_LOCATION_OUTPUT||path.resolve(__dirname,'sawa9ly-locations.json');
    fs.writeFileSync(out,JSON.stringify(result,null,2),'utf8');
    console.log(`\n✅ Saved: ${out}`);
    console.log(JSON.stringify(result.summary));
    if(result.summary.wilayas!==58) process.exitCode=2;
    if(result.summary.communes<1500) process.exitCode=2;
  }finally{
    await browser.close();
  }
}
main().catch(e=>{console.error('❌ Location sync failed:',e.stack||e.message);process.exitCode=1;});
