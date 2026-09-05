const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const orderQueue = [];
let isProcessing = false;

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

async function clickFirstMatchingText(page, texts) {
    const lowered = texts.map(t => String(t).toLowerCase());
    const clicked = await page.evaluate((words) => {
        const elements = Array.from(document.querySelectorAll('button,a,[role="button"]'));
        const visible = el => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const normalize = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
        for (const el of elements) {
            if (!visible(el)) continue;
            const text = normalize(el.innerText || el.textContent);
            if (words.some(w => text.includes(w))) {
                el.click();
                return text;
            }
        }
        return '';
    }, lowered);
    return clicked || '';
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
async function selectByHints(page, hints, target) {
    if (!target) return false;
    const result = await page.evaluate(({ hints, target }) => {
        const words = hints.map(x => String(x).toLowerCase());
        const norm = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const arabicNorm = t => norm(t).replace(/[أإآا]/g,'ا').replace(/ة/g,'ه');
        const visible = el => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const score = el => {
            const attrs = [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder')].map(norm).join(' ');
            let label = '';
            if (el.id) {
                const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (l) label += ' ' + norm(l.innerText);
            }
            return words.reduce((n,w) => n + ((attrs + ' ' + label).includes(w) ? 1 : 0), 0);
        };
        const selects = Array.from(document.querySelectorAll('select')).filter(visible);
        let best = null, bestScore = 0;
        for (const el of selects) {
            const sc = score(el);
            if (sc > bestScore) { best = el; bestScore = sc; }
        }
        if (!best || bestScore === 0) return {ok:false};
        const wanted = arabicNorm(target);
        const option = Array.from(best.options).find(o => {
            const t = arabicNorm(o.text);
            return t === wanted || t.includes(wanted) || wanted.includes(t);
        });
        if (!option) return {ok:false};
        best.value = option.value;
        best.dispatchEvent(new Event('input',{bubbles:true}));
        best.dispatchEvent(new Event('change',{bubbles:true}));
        best.dispatchEvent(new Event('blur',{bubbles:true}));
        return {ok:true};
    }, { hints, target: String(target) });
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

async function submitNewSawa9ly(order) {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--single-process']
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

        console.log('3️⃣ Clicking Commander maintenant / اطلب الآن...');
        const orderButton = await clickFirstMatchingText(page, [
            'commander maintenant', 'commander', 'اطلب الآن', 'طلب الآن', 'buy now'
        ]);
        if (!orderButton) throw new Error('لم أجد زر Commander maintenant / اطلب الآن في المنتج الجديد.');
        console.log(`   ✅ Clicked: ${orderButton}`);
        await delay(1800);

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

        console.log('6️⃣ Selecting wilaya...');
        const wilayaOk = await selectByHints(page, ['wilaya'], order.wilaya);
        if (!wilayaOk) throw new Error(`لم أتمكن من اختيار الولاية: ${order.wilaya}`);
        await delay(800);

        console.log('7️⃣ Selecting commune...');
        const communeOk = await selectByHints(page, ['commune'], order.commune);
        if (!communeOk) throw new Error(`لم أتمكن من اختيار البلدية: ${order.commune}`);
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
            'confirmer la commande','confirmer','valider la commande','valider','passer commande',
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
    const order = orderQueue.shift();
    try { await submitToSawa9ly(order); }
    catch (error) { console.error(`❌ فشل الطلب [${order.customerName || ''}]:`, error.message); }
    isProcessing = false;
    processQueue();
}

app.post('/api/order', (req,res) => {
    res.status(200).json({ success:true, message:'تم إرسال الطلبية إلى طابور المعالجة' });
    orderQueue.push(req.body || {});
    console.log(`📥 New order queued. Waiting: ${orderQueue.length}`);
    processQueue();
});

app.get('/health', (_req,res) => res.json({ ok:true, platform:'sawa9ly-affiliate', queue:orderQueue.length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Prix-Choc bot (new Sawa9ly) listening on ${PORT}`));
