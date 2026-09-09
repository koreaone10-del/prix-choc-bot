const express = require('express');
const cors = require('cors');
let puppeteer = null;
let chromium = null;

async function loadBrowserModules() {
    if (!puppeteer) {
        const puppeteerModule = await import('puppeteer-core');
        puppeteer = puppeteerModule.default || puppeteerModule;
    }
    if (!chromium) {
        const chromiumModule = await import('@sparticuz/chromium');
        chromium = chromiumModule.default || chromiumModule;
    }
    return { puppeteer, chromium };
}
const locationTools = require('./locations.js');

const app = express();
app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const CLEAN_TEXT_RE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;
function cleanText(value) {
    return String(value || '').normalize('NFKC').replace(CLEAN_TEXT_RE, '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
const orderQueue = [];
let isProcessing = false;
const orderStates = new Map();
let nextOrderNumber = 1;

function getProductId(value) {
    const match = String(value || '').match(/\/(?:product|store)\/(\d+)/i);
    return match ? match[1] : '';
}

function normalizeProductUrl(value) {
    const id = getProductId(value);
    return id ? `https://affiliate.sawa9ly.pro/store/${id}` : String(value || '');
}

function getDeliveryType(order) {
    if (order && (order.deliveryType === 'home' || order.deliveryType === 'desk')) return order.deliveryType;
    const address = String(order?.address || '');
    return /طلب\s*استلام\s*من\s*المكتب|stop\s*desk/i.test(address) ? 'desk' : 'home';
}

async function clickFirstMatchingText(page, texts, options = {}) {
    const lowered = texts.map(cleanText);
    const timeout = options.timeout || 15000;
    const started = Date.now();

    // Search the main document, open shadow roots, and same-origin frames.
    // Sawa9ly's React UI can render interactive content through nested components,
    // so a plain button query is not reliable enough.
    async function clickInContext(context) {
        return context.evaluate((words) => {
            const normalize = t => String(t || '')
                .normalize('NFKC')
                .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
                .replace(/\u00A0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
            const visible = el => {
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
            };
            const clickable = el => {
                if (!el) return false;
                const tag = el.tagName?.toLowerCase();
                if (['button','a'].includes(tag) || el.getAttribute('role') === 'button') return true;
                const s = getComputedStyle(el);
                return s.cursor === 'pointer' || typeof el.onclick === 'function' || el.hasAttribute('tabindex');
            };
            const candidates = [];
            const add = (el, mode) => {
                if (!el || !visible(el)) return;
                const raw = el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '';
                const text = normalize(raw);
                if (!text || text.length > 160) return;
                if (!words.some(w => text === w || text.includes(w))) return;
                candidates.push({el, text, mode});
            };

            // Real interactive controls first.
            document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]')
                .forEach(el => add(el, 'interactive'));

            // Then visible text nodes/elements and clickable ancestors.
            document.querySelectorAll('body *').forEach(el => {
                if (!visible(el)) return;
                const raw = el.innerText || el.textContent || '';
                const text = normalize(raw);
                if (!text || text.length > 100 || !words.some(w => text === w || text.includes(w))) return;
                let target = el;
                for (let i = 0; i < 7 && target; i++, target = target.parentElement) {
                    if (clickable(target)) {
                        add(target, 'ancestor');
                        break;
                    }
                }
            });

            // Prefer the shortest matching text: this avoids clicking a large
            // container that merely contains the button label.
            candidates.sort((a,b) => a.text.length - b.text.length);
            const picked = candidates[0];
            if (!picked) return {ok:false, candidates:[]};

            picked.el.scrollIntoView({block:'center', inline:'center'});
            picked.el.focus?.();
            // Native click is preferred; dispatching a pointer sequence helps
            // React/UI libraries that listen to pointer events.
            try {
                picked.el.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, pointerType:'mouse'}));
                picked.el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window}));
                picked.el.click();
                picked.el.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, view:window}));
                picked.el.dispatchEvent(new PointerEvent('pointerup', {bubbles:true, cancelable:true, pointerType:'mouse'}));
            } catch (_) { picked.el.click(); }
            return {ok:true, text:picked.text, tag:picked.el.tagName.toLowerCase(), mode:picked.mode};
        }, lowered);
    }

    while (Date.now() - started < timeout) {
        try {
            const result = await clickInContext(page);
            if (result?.ok) return `${result.text} [${result.mode}]`;

            // Search same-origin frames too.
            for (const frame of page.frames()) {
                if (frame === page.mainFrame()) continue;
                try {
                    const r = await clickInContext(frame);
                    if (r?.ok) return `${r.text} [frame:${r.mode}]`;
                } catch (_) {}
            }
        } catch (_) {}
        await delay(400);
    }

    // Final diagnostics: print every visible interactive label and matching
    // text candidate. This makes the next failure actionable instead of guesswork.
    try {
        const diagnostics = await page.evaluate((words) => {
            const normalize = t => String(t || '').normalize('NFKC')
                .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
                .replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
            const visible = el => { const r=el.getBoundingClientRect(), s=getComputedStyle(el); return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'; };
            return Array.from(document.querySelectorAll('button,a,[role="button"],input,body *'))
                .filter(visible)
                .map(el => ({tag:el.tagName.toLowerCase(), text:normalize(el.innerText||el.textContent||el.value||el.getAttribute('aria-label')||''), cls:String(el.className||'').slice(0,120)}))
                .filter(x => x.text && (x.text.length <= 100 || words.some(w=>x.text.toLowerCase().includes(w))))
                .filter((x,i,a)=>i===a.findIndex(y=>y.tag===x.tag&&y.text===x.text))
                .slice(0,80);
        }, lowered);
        console.log(`   🔎 Click diagnostics: ${JSON.stringify(diagnostics)}`);
    } catch (e) {
        console.log(`   🔎 Click diagnostics unavailable: ${e.message}`);
    }
    return '';
}

async function closeSawa9lyDrawer(page) {
    // After Commander maintenant, the new Sawa9ly checkout can leave the cart
    // drawer open on the right. In the real UI, tapping the page away from the
    // drawer closes it. Reproduce that first, then use semantic close controls.
    try {
        await page.mouse.click(80, 420);
        await delay(500);
    } catch (_) {}
    for (let attempt = 0; attempt < 3; attempt++) {
        const closed = await page.evaluate(() => {
            const norm = t => String(t || '').normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g,'').replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
            const visible = el => { const r=el.getBoundingClientRect(), s=getComputedStyle(el); return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'; };
            const labels = ['fermer','close','×','✕','إغلاق'];
            const els = Array.from(document.querySelectorAll('button,[role="button"],a'));
            for (const el of els) {
                if (!visible(el)) continue;
                const text = norm(el.innerText || el.textContent || el.getAttribute('aria-label') || el.title);
                if (labels.includes(text) || labels.some(x => text === x)) { el.click(); return true; }
            }
            // If no close control is exposed, click a safe point on the left
            // side of the checkout (outside the right drawer) like a human user.
            const drawer = els.map(e=>e.parentElement).find(e => e && visible(e) && /mon panier|panier|cart/i.test(norm(e.innerText||'')));
            if (drawer) {
                const r = drawer.getBoundingClientRect();
                if (r.left > 250) {
                    const x = Math.max(20, Math.min(r.left - 30, window.innerWidth * 0.35));
                    const y = Math.min(window.innerHeight * 0.45, Math.max(80, r.top + 120));
                    const target = document.elementFromPoint(x,y);
                    target?.click();
                    return true;
                }
            }
            return false;
        }).catch(()=>false);
        if (!closed) break;
        await delay(500);
    }
}

async function waitForOrderForm(page, timeout=15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const detected = await page.evaluate(() => /finaliser la commande|produits sélectionnés|prix de vente|mode de livraison|informations client/i.test(document.body?.innerText || '')).catch(()=>false);
        if (detected) return true;
        await delay(500);
    }
    return false;
}

async function fillFieldByHints(page, hints, value) {
    if (value === undefined || value === null || String(value) === '') return false;
    return page.evaluate(({ hints, value }) => {
        const words = hints.map(x => String(x).toLowerCase());
        const norm = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const visible = el => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const labelText = el => {
            let out = '';
            if (el.id) {
                const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (label) out += ' ' + label.innerText;
            }
            const previous = el.previousElementSibling;
            if (previous) out += ' ' + previous.innerText;
            const parent = el.closest('label,fieldset');
            if (parent) out += ' ' + parent.innerText;
            return norm(out);
        };
        const fields = Array.from(document.querySelectorAll('input,textarea')).filter(visible);
        let best = null, bestScore = 0;
        for (const el of fields) {
            const attrs = [el.placeholder, el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('autocomplete')].map(norm).join(' ');
            const text = attrs + ' ' + labelText(el);
            let score = 0;
            for (const w of words) {
                if (text.includes(w)) score += 3;
            }
            if (el.type === 'number' && words.some(w => /prix|price|السعر/.test(w))) score += 2;
            if (score > bestScore) { best = el; bestScore = score; }
        }
        if (!best || bestScore === 0) return false;
        best.focus();
        const proto = best.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(best, String(value)); else best.value = String(value);
        best.dispatchEvent(new Event('input', { bubbles: true }));
        best.dispatchEvent(new Event('change', { bubbles: true }));
        best.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
    }, { hints, value: String(value) });
}
async function selectByHints(page, hints, target, extraTargets = []) {
    if (!target && (!extraTargets || !extraTargets.length)) return false;
    const targets = [target, ...(Array.isArray(extraTargets) ? extraTargets : [])]
        .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
        .map(v => String(v).trim());
    const generated = [];
    for (const t of targets) {
        try { generated.push(locationTools.arabicToLatin(t)); } catch (_) {}
    }
    const allTargets = [...new Set([...targets, ...generated].filter(Boolean))];

    const result = await page.evaluate(async ({ hints, targets }) => {
        const norm = t => String(t || '').normalize('NFKC').normalize('NFD')
            .replace(/[\u0300-\u036f]/g,'')
            .replace(/[’'`]/g,'').replace(/[-_/.,]/g,' ')
            .replace(/\s+/g,' ').trim().toLowerCase();
        const visible = el => {
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        };
        const wanted = targets.map(norm).filter(Boolean);
        const codeOf = text => {
            const m = String(text || '').trim().match(/^(?:0?)(\d{1,2})\s*[-–—:]/);
            return m ? String(Number(m[1])).padStart(2,'0') : '';
        };
        const isWilaya = hints.some(h => /wilaya/i.test(String(h)));

        // 1) Native selects: identify the commune select structurally, not only by label.
        const selects = Array.from(document.querySelectorAll('select')).filter(visible);
        const nativeCandidates = selects.map((el,index) => ({
            el,index,
            options: Array.from(el.options).filter(o => String(o.textContent||'').trim()).map(o => ({
                text:String(o.textContent||'').trim(), value:String(o.value||''), disabled:o.disabled
            }))
        }));
        let candidates = nativeCandidates;
        if (!isWilaya) {
            candidates = nativeCandidates.filter(x => {
                const real = x.options.filter(o => !o.disabled && norm(o.text) && !/^[-–—]?$/.test(o.text));
                const wilayaLike = real.filter(o => /^\d{1,2}\s*[-–—:]/.test(o.text)).length;
                return real.length >= 1 && wilayaLike < Math.max(3, real.length * 0.35);
            });
        }

        function bestOption(options) {
            let exact = options.find(o => wanted.includes(norm(o.text)));
            if (exact) return exact;
            let best = null;
            for (const o of options) {
                const x = norm(o.text); if (!x) continue;
                for (const t of wanted) {
                    if (x === t || x.includes(t) || t.includes(x)) {
                        const score = x === t ? 100 : 70 - Math.abs(x.length - t.length);
                        if (!best || score > best.score) best = {option:o,score};
                    }
                }
            }
            return best?.option || null;
        }

        candidates.sort((a,b) => b.options.length - a.options.length);
        for (const c of candidates) {
            const opts = c.options.filter(o => !o.disabled && norm(o.text));
            const option = bestOption(opts);
            if (option) {
                c.el.value = option.value;
                c.el.dispatchEvent(new Event('input',{bubbles:true}));
                c.el.dispatchEvent(new Event('change',{bubbles:true}));
                c.el.dispatchEvent(new Event('blur',{bubbles:true}));
                return {ok:true,mode:'native-structural',text:option.text,index:c.index,value:option.value};
            }
        }

        // 2) Custom controls: first use labelled controls; if labels are missing,
        // fall back to the visible combobox/input that is nearest a location label.
        const controls = Array.from(document.querySelectorAll(
            '[role="combobox"],input,button,[aria-haspopup="listbox"],[aria-haspopup="true"],[data-radix-select-trigger],[data-slot="select-trigger"]'
        )).filter(visible);
        const fieldText = el => {
            const parent = el.closest('label,fieldset,form,div');
            return norm([el.id,el.name,el.getAttribute('aria-label'),el.getAttribute('placeholder'),parent?.innerText||''].join(' '));
        };
        const hintWords = hints.map(norm);
        const scored = controls.map((el,index)=>({el,index,score:hintWords.reduce((n,h)=>n+(fieldText(el).includes(h)?5:0),0)}))
            .sort((a,b)=>b.score-a.score);
        let control = scored.find(x=>x.score>0)?.el;
        if (!control && !isWilaya && controls.length) {
            // After a successful wilaya selection, commune is usually the next
            // location control. Prefer a control below/near the wilaya control.
            const wilayaEl = scored.find(x=>/wilaya/.test(fieldText(x.el)))?.el;
            const wr = wilayaEl?.getBoundingClientRect();
            const below = controls.filter(x => x !== wilayaEl).map(el=>({el,r:el.getBoundingClientRect()}))
                .filter(x=>!wr || x.r.top >= wr.top-20)
                .sort((a,b)=>a.r.top-b.r.top);
            control = below[0]?.el || controls[0];
        }
        if (!control) return {ok:false,reason:'location-control-not-found'};
        control.scrollIntoView({block:'center',inline:'center'}); control.focus?.();
        try { control.click(); } catch (_) {}
        await new Promise(r=>setTimeout(r,500));

        const visibleOptions = () => Array.from(document.querySelectorAll(
            '[role="option"],[role="listbox"] li,[role="listbox"] button,[data-radix-collection-item],[data-value]'
        )).filter(visible).map(el=>({el,text:String(el.innerText||el.textContent||el.getAttribute('aria-label')||'').trim()})).filter(x=>x.text);
        let opts=visibleOptions();
        let picked=opts.find(x=>wanted.includes(norm(x.text)));
        if(!picked) {
            const hits=opts.map(x=>({x,score:Math.max(...wanted.map(t=>norm(x.text)===t?100:(norm(x.text).includes(t)||t.includes(norm(x.text))?70-Math.abs(norm(x.text).length-t.length):0)))})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
            picked=hits[0]?.x;
        }
        if(!picked && control.tagName?.toLowerCase()==='input') {
            const typeTarget=targets.find(x=>/[A-Za-zÀ-ÿ]/.test(x)) || targets[0];
            try {
                const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
                setter?.call(control,''); control.dispatchEvent(new Event('input',{bubbles:true}));
                for(const ch of String(typeTarget||'')) { setter?.call(control,(control.value||'')+ch); control.dispatchEvent(new InputEvent('input',{bubbles:true,data:ch,inputType:'insertText'})); }
                await new Promise(r=>setTimeout(r,600)); opts=visibleOptions(); picked=opts.find(x=>wanted.includes(norm(x.text)));
            } catch (_) {}
        }
        if(!picked) return {ok:false,reason:'custom-options-not-found',available:opts.slice(0,80).map(x=>x.text)};
        picked.el.click();
        return {ok:true,mode:'custom-structural',text:picked.text};
    }, {hints, targets:allTargets});

    if (!result.ok) console.log(`   🔎 Location selector diagnostics (${hints.join(',')}): ${JSON.stringify(result)}`);
    else console.log(`   🧭 ${hints.join('/')} selector mode=${result.mode}, selected="${result.text}"`);
    return !!result.ok;
}
async function login(page) {
    const loginUrl = process.env.SAWA9LY_LOGIN_URL || 'https://affiliate.sawa9ly.pro/login';
    console.log('1️⃣ Opening new Sawa9ly login...');
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.type('input[type="email"]', process.env.SAWA9LY_EMAIL || '');
    await page.type('input[type="password"]', process.env.SAWA9LY_PASSWORD || '');
    const submit = await page.$('button[type="submit"]');
    if (submit) await submit.click(); else await page.keyboard.press('Enter');
    await delay(5000);
    if (/\/login/i.test(page.url())) throw new Error('تسجيل الدخول إلى Sawa9ly الجديد لم ينجح.');
    console.log(`   ✅ Logged in: ${page.url()}`);
}

function resolveOrderLocations(order) {
    const wilayaCode = String(order?.wilayaCode || locationTools.wilayaCode(order?.wilayaAr || order?.wilayaFr || order?.wilaya || '') || '').padStart(2,'0');
    const wilayaFr = String(order?.wilayaFr || order?.wilaya || (wilayaCode && locationTools.WILAYA_FR_BY_CODE?.[wilayaCode]) || '').trim();
    const wilayaAr = String(order?.wilayaAr || '').trim();
    const communeFrRaw = String(order?.communeFr || order?.commune || '').trim();
    const communeAr = String(order?.communeAr || '').trim();
    const communeCanonical = locationTools.canonicalCommune ? locationTools.canonicalCommune(communeFrRaw) : '';
    const communeFr = communeCanonical || communeFrRaw;
    const communeGenerated = communeAr && locationTools.arabicToLatin ? locationTools.arabicToLatin(communeAr) : '';
    return { wilayaCode, wilayaFr, wilayaAr, communeFr, communeAr, communeGenerated };
}

async function submitNewSawa9ly(order) {
    // Load the ESM browser packages explicitly. Node can expose an ESM package
    // through require() as a namespace object, which is why executablePath()
    // was previously seen as "not a function" on Render.
    await loadBrowserModules();
    chromium.setGraphicsMode = false;
    const executablePath = await chromium.executablePath();
    const launchArgs = await puppeteer.defaultArgs({
        args: [
            ...chromium.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote'
        ],
        headless: 'shell'
    });
    console.log(`   🖥️ Chromium executable: ${executablePath}`);
    const browser = await puppeteer.launch({
        executablePath,
        headless: 'shell',
        args: launchArgs,
        defaultViewport: chromium.defaultViewport
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });
    try {
        console.log(`\n================================`);
        console.log(`🚀 New Sawa9ly order: ${order.customerName}`);
        await login(page);

        const productUrl = normalizeProductUrl(order.sawa9lyLink);
        if (!getProductId(productUrl)) throw new Error(`رابط المنتج غير صالح: ${order.sawa9lyLink}`);
        console.log(`2️⃣ Product: ${productUrl}`);
        await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(2500);
        await page.waitForFunction(() => document.body && document.body.innerText && document.body.innerText.length > 100, {timeout:15000}).catch(()=>{});

        console.log('3️⃣ Clicking Commander maintenant / اطلب الآن...');
        const orderButton = await clickFirstMatchingText(page, [
            'commander maintenant', 'اطلب maintenant', 'commander', 'اطلب الآن', 'طلب الآن', 'buy now'
        ], {timeout:20000});
        if (!orderButton) throw new Error('لم أجد زر Commander maintenant / اطلب الآن في المنتج الجديد.');
        console.log(`   ✅ Clicked: ${orderButton}`);
        await delay(1000);
        console.log(`   🌐 After click URL: ${page.url()}`);
        const orderFormVisible = await waitForOrderForm(page, 15000);
        console.log(`   🧾 Order form detected: ${orderFormVisible ? 'YES' : 'NO'}`);
        if (!orderFormVisible) throw new Error('تم الضغط على Commander maintenant لكن نموذج Finaliser la commande لم يظهر.');
        await closeSawa9lyDrawer(page);
        await delay(700);
        console.log('   🧹 Checkout drawer handled; continuing with the form...');

        const deliveryType = getDeliveryType(order);
        console.log(`4️⃣ Selecting delivery mode: ${deliveryType === 'desk' ? 'Stop desk' : 'À domicile'}...`);
        const deliveryOk = await clickFirstMatchingText(page, deliveryType === 'desk'
            ? ['stop desk']
            : ['à domicile','a domicile']);
        if (!deliveryOk) throw new Error('لم أتمكن من تحديد طريقة التوصيل في نموذج Sawa9ly الجديد.');
        await delay(600);

        console.log('5️⃣ Setting selling price...');
        const priceSet = await fillFieldByHints(page, ['prix de vente','prix vente','selling price','price','سعر البيع'], order.sellingPrice);
        if (!priceSet) throw new Error(`لم أتمكن من إدخال سعر البيع: ${order.sellingPrice}`);
        console.log(`   ✅ Selling price set to ${order.sellingPrice} DA.`);
        await delay(400);

        const locations = resolveOrderLocations(order);
        console.log('6️⃣ Selecting wilaya...');
        const wilayaOk = await selectByHints(page, ['wilaya'], locations.wilayaCode || locations.wilayaFr, [locations.wilayaFr, locations.wilayaAr]);
        if (!wilayaOk) throw new Error(`لم أتمكن من اختيار الولاية: ${locations.wilayaFr || locations.wilayaAr || locations.wilayaCode}`);
        console.log(`   ✅ Wilaya selected: ${locations.wilayaFr || locations.wilayaCode}`);
        await delay(900);

        console.log('7️⃣ Selecting commune...');
        const communeOk = await selectByHints(page, ['commune'], locations.communeFr, [locations.communeGenerated, locations.communeAr]);
        if (!communeOk) throw new Error(`لم أتمكن من اختيار البلدية: ${locations.communeFr || locations.communeAr}`);
        console.log(`   ✅ Commune selected: ${locations.communeFr || locations.communeGenerated}`);
        await delay(500);

        console.log('8️⃣ Filling customer information...');
        const fields = [
            [['nom complet','full name','name','الاسم الكامل'], order.customerName],
            [['téléphone','telephone','phone','numéro de téléphone','رقم الهاتف','الهاتف'], order.phone],
            [['adresse','address','rue, bâtiment','عنوان التوصيل','العنوان'], String(order.address || '').replace(/\s*\|\s*\(طلب استلام من المكتب\)\s*$/,'') ]
        ];
        for (const [hints, value] of fields) {
            const ok = await fillFieldByHints(page, hints, value);
            if (!ok) throw new Error(`لم أتمكن من ملء الحقل: ${hints[0]}`);
            console.log(`   ✅ ${hints[0]}`);
        }

        console.log('9️⃣ Looking for final order confirmation...');
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(700);
        const confirm = await clickFirstMatchingText(page, [
            'confirmer la commande','confirmer la commande ','confirmer','valider la commande','valider','passer commande',
            'تأكيد الطلب','تأكيد','إتمام الطلب','place order','confirm order'
        ]);
        if (!confirm) throw new Error('لم أجد زر التأكيد النهائي في نموذج Sawa9ly الجديد.');
        console.log(`   ✅ Confirmation clicked: ${confirm}`);
        await delay(3500);

        const finalUrl = page.url();
        const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(()=> '');
        const success = /succès|succ[eè]s|commande.*(créée|confirm|success)|order.*(success|confirmed)|تم.*(الطلب|الطلبية)|نجاح|شكرا|merci/i.test(bodyText) || /success|confirmation|order|commande/i.test(finalUrl);
        if (success) console.log('🎉 Sawa9ly returned a confirmation/success signal.');
        else console.log('⚠️ Confirmation click completed, but no unambiguous success signal was detected.');
        console.log(`   Final URL: ${finalUrl}`);
        console.log('================================\n');
        return success;
    } finally {
        await browser.close();
    }
}

async function submitToSawa9ly(order) {
    return submitNewSawa9ly(order);
}

async function processQueue() {
    if (isProcessing || orderQueue.length === 0) return;
    isProcessing = true;
    const item = orderQueue.shift();
    const orderId = item.orderId;
    const order = item.order;
    orderStates.set(orderId, { status:'processing', updatedAt:Date.now() });
    try {
        let success = false;
        let lastError = '';
        for (let attempt = 1; attempt <= 2; attempt++) {
            console.log(`🚀 Processing order ${orderId} (attempt ${attempt}/2)`);
            try {
                success = await submitToSawa9ly(order);
                if (success) break;
                lastError = 'Sawa9ly لم يعط إشارة نجاح مؤكدة.';
            } catch (error) {
                lastError = error?.message || String(error);
                console.error(`❌ Order ${orderId} attempt ${attempt}: ${lastError}`);
            }
            if (!success && attempt < 2) await delay(1200);
        }
        if (success) orderStates.set(orderId, { status:'success', updatedAt:Date.now() });
        else orderStates.set(orderId, { status:'failed', error:lastError || 'فشل إرسال الطلب إلى Sawa9ly.', updatedAt:Date.now() });
    } finally {
        isProcessing = false;
        processQueue();
    }
}

app.post('/api/order', (req,res) => {
    const orderId = `PX-${Date.now()}-${nextOrderNumber++}`;
    orderStates.set(orderId, { status:'queued', updatedAt:Date.now() });
    orderQueue.push({ orderId, order:req.body || {} });
    console.log(`📥 New order queued: ${orderId}. Waiting: ${orderQueue.length}`);
    processQueue();
    res.status(202).json({ success:true, orderId, status:'queued', message:'تم استلام الطلب وبدأت معالجته.' });
});

app.get('/api/order/:orderId', (req,res) => {
    const state = orderStates.get(req.params.orderId);
    if (!state) return res.status(404).json({ success:false, status:'not_found' });
    return res.json({ success: state.status === 'success', orderId:req.params.orderId, ...state });
});

setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id,state] of orderStates) if ((state.updatedAt || 0) < cutoff) orderStates.delete(id);
}, 5 * 60 * 1000);

app.get('/health', (_req,res) => res.json({ ok:true, platform:'sawa9ly-affiliate', queue:orderQueue.length, processing:isProcessing, browserRuntime:'sparticuz-chromium' }));

// Deployment smoke test: verifies that Render can extract and launch Chromium
// before a real customer order is attempted. It never logs credentials.
app.get('/health/browser', async (_req,res) => {
    let browser;
    try {
        await loadBrowserModules();
        chromium.setGraphicsMode = false;
        const executablePath = await chromium.executablePath();
        const args = await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' });
        browser = await puppeteer.launch({
            executablePath,
            headless: 'shell',
            args,
            defaultViewport: chromium.defaultViewport
        });
        const page = await browser.newPage();
        const version = await browser.version();
        await page.close();
        return res.json({ ok:true, browser:'chromium', version, executablePath });
    } catch (error) {
        console.error('❌ Browser health check failed:', error.message);
        return res.status(500).json({ ok:false, browser:'chromium', error:error.message });
    } finally {
        if (browser) await browser.close().catch(()=>{});
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Prix-Choc bot (new Sawa9ly) listening on ${PORT}`));
