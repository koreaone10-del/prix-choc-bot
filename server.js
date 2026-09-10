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
            .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g,'')
            .replace(/[’'`]/g,'')
            .replace(/[-_/.,]/g,' ')
            .replace(/\s+/g,' ')
            .trim()
            .toLowerCase();

        const visible = el => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 1 && r.height > 1 &&
                   s.visibility !== 'hidden' &&
                   s.display !== 'none' &&
                   s.opacity !== '0';
        };

        const words = hints.map(x => norm(x)).filter(Boolean);
        const wanted = targets.map(norm).filter(Boolean);
        const isWilaya = hints.some(h => /wilaya/i.test(String(h)));

        const codeOf = text => {
            const m = String(text || '').trim().match(/^(?:0?)(\d{1,2})\s*[-–—:]/);
            return m ? String(Number(m[1])).padStart(2,'0') : '';
        };

        const wantedCodes = wanted
            .map(x => /^\d{1,2}$/.test(x) ? String(Number(x)).padStart(2,'0') : '')
            .filter(Boolean);

        const optionText = o => norm(
            o?.textContent || o?.innerText || o?.getAttribute?.('aria-label') || ''
        );

        function optionMatches(option) {
            const text = optionText(option);
            if (!text) return false;

            if (isWilaya && wantedCodes.length && wantedCodes.includes(codeOf(option.textContent))) {
                return true;
            }

            return wanted.some(t =>
                text === t || text.includes(t) || t.includes(text)
            );
        }

        function fieldScore(el) {
            const attrs = [
                el.id,
                el.name,
                el.getAttribute('aria-label'),
                el.getAttribute('placeholder'),
                el.getAttribute('data-testid')
            ].map(norm).join(' ');

            let nearby = '';

            if (el.id) {
                const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (label) nearby += ' ' + norm(label.innerText);
            }

            const parent = el.closest('label,fieldset,form,div');
            if (parent) nearby += ' ' + norm((parent.innerText || '').slice(0,250));

            let score = 0;
            for (const w of words) {
                if ((attrs + ' ' + nearby).includes(w)) score += 5;
            }

            if (el.getAttribute('role') === 'combobox') score += 3;
            if (el.tagName.toLowerCase() === 'select') score += 4;

            return score;
        }

        function inspectNativeSelects() {
            return Array.from(document.querySelectorAll('select'))
                .filter(visible)
                .map((el, index) => {
                    const options = Array.from(el.options)
                        .filter(o => !o.disabled && optionText(o));

                    const matching = options.filter(optionMatches);

                    return {
                        el,
                        index,
                        fieldScore: fieldScore(el),
                        matching,
                        optionCount: options.length
                    };
                });
        }

        function pickNativeSelect() {
            const inspected = inspectNativeSelects();

            // CRITICAL FIX:
            // Do NOT choose one select only from the field label/parent.
            // The checkout contains both Wilaya and Commune selects, and their
            // surrounding React container can mention "commune" for both.
            // The actual target option is therefore the strongest evidence.
            const withTarget = inspected
                .filter(x => x.matching.length > 0)
                .sort((a,b) => {
                    const targetDiff = b.matching.length - a.matching.length;
                    if (targetDiff !== 0) return targetDiff;
                    return b.fieldScore - a.fieldScore;
                });

            if (withTarget.length) return withTarget[0];

            // For Wilaya only, a select with many numbered Wilaya options is a
            // useful fallback while options are still settling.
            if (isWilaya) {
                const numbered = inspected
                    .filter(x => x.optionCount >= 40)
                    .sort((a,b) => {
                        if (b.optionCount !== a.optionCount) return b.optionCount - a.optionCount;
                        return b.fieldScore - a.fieldScore;
                    });

                if (numbered.length) return numbered[0];
            }

            return null;
        }

        // The Commune options are populated asynchronously after Wilaya changes.
        // Poll instead of assuming 900 ms is always enough.
        const deadline = Date.now() + (isWilaya ? 5000 : 10000);
        let native = null;

        while (Date.now() < deadline) {
            native = pickNativeSelect();

            if (native) {
                const options = Array.from(native.el.options)
                    .filter(o => !o.disabled && optionText(o));

                let option = null;

                if (isWilaya && wantedCodes.length) {
                    option = options.find(o =>
                        wantedCodes.includes(codeOf(o.textContent))
                    );
                }

                if (!option) {
                    option = options.find(o => {
                        const x = optionText(o);
                        return wanted.includes(x);
                    });
                }

                if (!option) {
                    const hits = options.filter(o => {
                        const x = optionText(o);
                        return wanted.some(t =>
                            x === t || x.includes(t) || t.includes(x)
                        );
                    });

                    hits.sort((a,b) => optionText(a).length - optionText(b).length);
                    option = hits[0];
                }

                if (option) {
                    native.el.focus();
                    native.el.value = option.value;
                    native.el.dispatchEvent(new Event('input',{bubbles:true}));
                    native.el.dispatchEvent(new Event('change',{bubbles:true}));
                    native.el.dispatchEvent(new Event('blur',{bubbles:true}));

                    return {
                        ok:true,
                        mode:'native-select',
                        text:String(option.textContent || '').trim(),
                        index:native.index,
                        optionValue:String(option.value || '')
                    };
                }
            }

            await new Promise(resolve => setTimeout(resolve, 350));
        }

        // Custom/React combobox fallback remains intact.
        const candidates = Array.from(document.querySelectorAll(
            '[role="combobox"],input,button,[aria-haspopup="listbox"],' +
            '[aria-haspopup="true"],[data-radix-select-trigger],[data-slot="select-trigger"]'
        ))
        .filter(visible)
        .map(el=>({el,score:fieldScore(el)}))
        .sort((a,b)=>b.score-a.score);

        const control = candidates.find(x=>x.score>0)?.el;
        if (!control) {
            return {
                ok:false,
                reason:'location-control-not-found',
                nativeSelects:Array.from(document.querySelectorAll('select'))
                    .filter(visible)
                    .map((el,index)=>({
                        index,
                        id:el.id||'',
                        name:el.name||'',
                        options:Array.from(el.options)
                            .filter(o=>!o.disabled)
                            .slice(0,80)
                            .map(o=>String(o.textContent||'').trim())
                    }))
            };
        }

        control.scrollIntoView({block:'center',inline:'center'});
        control.focus?.();

        try {
            control.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'mouse'}));
            control.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));
            control.click();
            control.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));
            control.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerType:'mouse'}));
        } catch (_) {
            try { control.click(); } catch (_) {}
        }

        const sleep = ms => new Promise(r=>setTimeout(r,ms));
        await sleep(350);

        function visibleOptions() {
            return Array.from(document.querySelectorAll(
                '[role="option"], [role="listbox"] li, [role="listbox"] button,' +
                ' [data-radix-collection-item], [data-value]'
            ))
            .filter(visible)
            .filter(el => {
                const t = norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
                return t && t.length <= 140;
            });
        }

        function findOption() {
            const options = visibleOptions();

            if (isWilaya && wantedCodes.length) {
                const byCode = options.find(o =>
                    wantedCodes.includes(codeOf(
                        o.innerText || o.textContent || o.getAttribute('aria-label')
                    ))
                );
                if (byCode) return byCode;
            }

            const exact = options.find(o =>
                wanted.includes(norm(o.innerText || o.textContent || o.getAttribute('aria-label')))
            );
            if (exact) return exact;

            const hits = options.filter(o => {
                const x = norm(o.innerText || o.textContent || o.getAttribute('aria-label'));
                return wanted.some(t => x===t || x.includes(t) || t.includes(x));
            });

            hits.sort((a,b) =>
                norm(a.innerText||a.textContent).length -
                norm(b.innerText||b.textContent).length
            );

            return hits[0] || null;
        }

        let option = findOption();

        if (!option && (control.tagName || '').toLowerCase() === 'input') {
            const typeTarget = isWilaya && wantedCodes.length
                ? wantedCodes[0]
                : (targets.find(x=>/[A-Za-zÀ-ÿ]/.test(x)) || targets[0]);

            try {
                const proto = HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto,'value')?.set;

                if (setter) setter.call(control,'');
                else control.value='';

                control.dispatchEvent(new Event('input',{bubbles:true}));
                control.dispatchEvent(new Event('change',{bubbles:true}));
                control.focus();

                for (const ch of String(typeTarget || '')) {
                    control.dispatchEvent(new KeyboardEvent('keydown',{key:ch,bubbles:true}));

                    if (setter) setter.call(control,(control.value||'')+ch);
                    else control.value=(control.value||'')+ch;

                    control.dispatchEvent(new InputEvent('input',{
                        bubbles:true,
                        data:ch,
                        inputType:'insertText'
                    }));

                    control.dispatchEvent(new KeyboardEvent('keyup',{key:ch,bubbles:true}));
                }

                await sleep(500);
                option = findOption();
            } catch (_) {}
        }

        if (!option) {
            return {
                ok:false,
                reason:'custom-options-not-found',
                available:visibleOptions()
                    .slice(0,80)
                    .map(o=>o.innerText||o.textContent||'')
            };
        }

        const text = option.innerText || option.textContent ||
            option.getAttribute('aria-label') || '';

        option.scrollIntoView({block:'center',inline:'nearest'});

        try {
            option.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'mouse'}));
            option.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));
            option.click();
            option.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));
            option.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerType:'mouse'}));
        } catch (_) {
            try { option.click(); } catch (_) {}
        }

        return {ok:true,mode:'custom-combobox',text:String(text).trim()};
    }, {hints, targets:allTargets});

    if (!result.ok) {
        console.log(`   🔎 Location selector diagnostics (${hints.join(',')}): ${JSON.stringify(result)}`);
    } else {
        console.log(`   🧭 ${hints.join('/')} selector mode=${result.mode}, selected="${result.text}"`);
    }

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


async function openSawa9lyProductRobust(page, productUrl) {
    const productId = getProductId(productUrl);
    if (!productId) throw new Error(`رابط المنتج غير صالح: ${productUrl}`);

    const base = 'https://affiliate.sawa9ly.pro';
    const directUrl = `${base}/store/${productId}`;
    const candidateUrls = [
        directUrl,
        `${base}/store/product/${productId}`,
        `${base}/product/${productId}`,
        `${base}/store?id=${productId}`
    ];

    async function pageLooksLikeProduct() {
        return page.evaluate((id) => {
            const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
            const lower = text.toLowerCase();
            const notFound =
                lower.includes('page not found') ||
                lower.includes("the page you're looking for doesn't exist") ||
                lower.includes('404');
            const hasOrder =
                /commander maintenant|اطلب الآن|طلب الآن|commander|buy now/i.test(text);
            const hasProductSignal =
                !!document.querySelector('button, a, [role="button"]') &&
                (hasOrder || lower.includes(String(id)));
            return { ok: !notFound && hasProductSignal, notFound, url: location.href };
        }, productId).catch(() => ({ ok:false, notFound:false, url:page.url() }));
    }

    for (let i = 0; i < candidateUrls.length; i++) {
        const url = candidateUrls[i];
        try {
            console.log(`   🔎 Product route attempt ${i + 1}/${candidateUrls.length}: ${url}`);
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            await delay(1800);
            const state = await pageLooksLikeProduct();
            if (state.ok) {
                console.log(`   ✅ Product page found: ${page.url()}`);
                return true;
            }
            if (state.notFound) {
                console.log(`   ⚠️ Route returned Page Not Found: ${page.url()}`);
            }
        } catch (e) {
            console.log(`   ⚠️ Route failed: ${e.message}`);
        }
    }

    // Last resort: open the authenticated Store catalog and search for the product ID.
    // This protects orders when Sawa9ly changes the direct product route.
    console.log(`   🔍 Direct product route failed; searching Sawa9ly Store for ID ${productId}...`);
    await page.goto(`${base}/store`, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(1800);

    const searchResult = await page.evaluate((id) => {
        const norm = s => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
        const visible = el => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return r.width > 1 && r.height > 1 && st.display !== 'none' && st.visibility !== 'hidden';
        };

        // First prefer an existing product link containing the numeric ID.
        const links = [...document.querySelectorAll('a[href]')].filter(visible);
        const direct = links.find(a => {
            const href = a.getAttribute('href') || '';
            return new RegExp(`(?:store|product)[/]${id}(?:[/?#]|$)`, 'i').test(href);
        });
        if (direct) {
            direct.click();
            return {mode:'link', text:(direct.innerText || '').trim().slice(0,120), href:direct.href};
        }

        // Otherwise find a search input and let the React catalog perform its own search.
        const inputs = [...document.querySelectorAll('input')].filter(visible);
        const search = inputs.find(i => {
            const meta = norm([
                i.placeholder, i.getAttribute('aria-label'),
                i.name, i.type, i.parentElement?.innerText
            ].join(' '));
            return i.type === 'search' || /recherch|search|بحث/.test(meta);
        });
        if (search) {
            search.focus();
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter ? setter.call(search, String(id)) : (search.value = String(id));
            search.dispatchEvent(new Event('input', {bubbles:true}));
            search.dispatchEvent(new Event('change', {bubbles:true}));
            search.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
            search.dispatchEvent(new KeyboardEvent('keyup', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
            return {mode:'search', placeholder:search.placeholder || ''};
        }
        return {mode:'none'};
    }, productId);

    console.log(`   🧭 Store search mode: ${searchResult.mode}`);
    await delay(2500);

    // After search/navigation, inspect links and click the first link that resolves to this ID.
    const clicked = await page.evaluate((id) => {
        const visible = el => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return r.width > 1 && r.height > 1 && st.display !== 'none' && st.visibility !== 'hidden';
        };
        const links = [...document.querySelectorAll('a[href]')].filter(visible);
        const hit = links.find(a => {
            const href = a.getAttribute('href') || '';
            return new RegExp(`(?:store|product)[/]${id}(?:[/?#]|$)`, 'i').test(href);
        });
        if (hit) { hit.scrollIntoView({block:'center'}); hit.click(); return true; }
        return false;
    }, productId);

    if (clicked) {
        await delay(2200);
        const state = await pageLooksLikeProduct();
        if (state.ok) {
            console.log(`   ✅ Product found from Store catalog: ${page.url()}`);
            return true;
        }
    }

    throw new Error(`منتج Sawa9ly رقم ${productId} غير متاح عبر رابط المنتج أو كتالوج Store الحالي.`);
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
        await openSawa9lyProductRobust(page, productUrl);
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

app.get('/health', (_req,res) => res.json({ ok:true, platform:'sawa9ly-affiliate', queue:orderQueue.length, browserRuntime:'sparticuz-chromium' }));

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
