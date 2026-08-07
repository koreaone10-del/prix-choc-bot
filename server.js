const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// إعدادات بابا الجزائر
// ─────────────────────────────────────────────
const BABA_BASE_URL = 'https://www.babaalgeria.com';
const LOGIN_URL     = `${BABA_BASE_URL}/login`;

// اقرأ بيانات الدخول من متغيرات البيئة
const BABA_EMAIL    = process.env.BABA_EMAIL    || '';
const BABA_PASSWORD = process.env.BABA_PASSWORD || '';

// ─────────────────────────────────────────────
// خريطة الولايات (58 ولاية)
// ─────────────────────────────────────────────
const wilayasMap = {
  "1":  "أدرار", "2":  "الشلف", "3":  "الأغواط", "4":  "أم البواقي",
  "5":  "باتنة", "6":  "بجاية", "7":  "بسكرة", "8":  "بشار",
  "9":  "البليدة", "10": "البويرة", "11": "تمنراست", "12": "تبسة",
  "13": "تلمسان", "14": "تيارت", "15": "تيزي وزو", "16": "الجزائر",
  "17": "الجلفة", "18": "جيجل", "19": "سطيف", "20": "سعيدة",
  "21": "سكيكدة", "22": "سيدي بلعباس", "23": "عنابة", "24": "قالمة",
  "25": "قسنطينة", "26": "المدية", "27": "مستغانم", "28": "المسيلة",
  "29": "معسكر", "30": "ورقلة", "31": "وهران", "32": "البيض",
  "33": "إليزي", "34": "برج بوعريريج", "35": "بومرداس", "36": "الطارف",
  "37": "تندوف", "38": "تيسمسيلت", "39": "الوادي", "40": "خنشلة",
  "41": "سوق أهراس", "42": "تيبازة", "43": "ميلة", "44": "عين الدفلى",
  "45": "النعامة", "46": "عين تموشنت", "47": "غرداية", "48": "غليزان",
  "49": "المغير", "50": "المنيعة", "51": "أولاد جلال", "52": "بني عباس",
  "53": "تيميمون", "54": "توقرت", "55": "جانت", "56": "عين صالح",
  "57": "عين قزام", "58": "الطارف"
};

// ─────────────────────────────────────────────
// نقطة الاستقبال من Vercel
// ─────────────────────────────────────────────
app.post('/automate-order', async (req, res) => {
  const { orderId, productUrl, customerName, customerPhone, customerAddress, wilayaNumber, commune } = req.body;

  // رد فوري لـ Vercel
  res.json({ success: true, message: 'جاري المعالجة في الخلفية', orderId });

  let browser;
  try {
    console.log(`\n🚀 [${orderId}] بدء الأتمتة...`);

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    // ── 1. تسجيل الدخول ──
    console.log(`[${orderId}] ⏳ تسجيل الدخول...`);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
    await page.type('input[type="email"], input[name="email"]', BABA_EMAIL);

    await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 15000 });
    await page.type('input[type="password"], input[name="password"]', BABA_PASSWORD);

    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
    ]);

    await new Promise(r => setTimeout(r, 5000));

    const urlAfterLogin = page.url();
    if (urlAfterLogin.includes('/login')) {
      throw new Error('فشل تسجيل الدخول');
    }
    console.log(`[${orderId}] ✅ تم الدخول بنجاح`);

    // ── 2. فتح صفحة المنتج ──
    const targetUrl = productUrl || `${BABA_BASE_URL}/product/323`;
    console.log(`[${orderId}] 🔗 فتح: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // ── 3. البحث عن زر "ابدأ البيع الآن" ──
    console.log(`[${orderId}] 🛒 البحث عن زر البيع...`);
    
    let clicked = await page.evaluate(() => {
      const all = document.querySelectorAll('a, button, span, div');
      for (const el of all) {
        const text = el.textContent.trim();
        if (text.includes('ابدأ البيع') || text.includes('ابدا البيع') || text.includes('ابدء البيع')) {
          el.click();
          return true;
        }
      }
      return false;
    });

    if (!clicked) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      await new Promise(r => setTimeout(r, 2000));
      
      clicked = await page.evaluate(() => {
        const all = document.querySelectorAll('a, button, span, div');
        for (const el of all) {
          const text = el.textContent.trim();
          if (text.includes('ابدأ البيع') || text.includes('ابدا البيع')) {
            el.click();
            return true;
          }
        }
        return false;
      });
    }

    if (!clicked) {
      await page.screenshot({ path: `/tmp/debug-${orderId}.png`, fullPage: true });
      throw new Error('زر "ابدأ البيع الآن" غير موجود');
    }

    console.log(`[${orderId}] ✅ تم النقر على زر البيع`);
    await new Promise(r => setTimeout(r, 4000));

    // ── 4. تعبئة الاستمارة ──
    console.log(`[${orderId}] 📝 تعبئة البيانات...`);

    await page.evaluate((name) => {
      const el = document.querySelector('input[name="name"], input[name="customer_name"], input[placeholder*="اسم"]');
      if (el) { el.value = name; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, customerName || 'عميل');

    await page.evaluate((phone) => {
      const el = document.querySelector('input[name="phone"], input[name="customer_phone"], input[type="tel"]');
      if (el) { el.value = phone; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, customerPhone || '05');

    await page.evaluate((addr) => {
      const el = document.querySelector('input[name="address"], textarea[name="address"]');
      if (el) { el.value = addr; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, customerAddress || '');

    if (wilayaNumber && wilayasMap[wilayaNumber]) {
      const wilayaName = wilayasMap[wilayaNumber];
      await page.evaluate((name) => {
        const select = document.querySelector('select');
        if (select) {
          const opts = Array.from(select.options);
          const match = opts.find(o => o.text.includes(name));
          if (match) { select.value = match.value; select.dispatchEvent(new Event('change', { bubbles: true })); return; }
        }
        const input = document.querySelector('input[name*="wilaya"], input[placeholder*="ولاية"]');
        if (input) { input.value = name; input.dispatchEvent(new Event('input', { bubbles: true })); }
      }, wilayaName);
    }

    if (commune) {
      await page.evaluate((c) => {
        const el = document.querySelector('input[name*="commune"], input[placeholder*="بلدية"]');
        if (el) { el.value = c; el.dispatchEvent(new Event('input', { bubbles: true })); }
      }, commune);
    }

    await new Promise(r => setTimeout(r, 1500));

    // ── 5. إرسال الطلب ──
    console.log(`[${orderId}] 📤 إرسال الطلب...`);
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"], .btn-submit, input[type="submit"]');
      if (btn) btn.click();
    });

    await new Promise(r => setTimeout(r, 5000));
    await page.screenshot({ path: `/tmp/success-${orderId}.png` });
    console.log(`[${orderId}] 🎉 تم إرسال الطلبية بنجاح!`);

  } catch (err) {
    console.error(`[${orderId}] ❌ خطأ:`, err.message);
  } finally {
    if (browser) {
      await new Promise(r => setTimeout(r, 2000));
      await browser.close();
      console.log(`[${orderId}] 🔒 تم إغلاق المتصفح\n`);
    }
  }
});

// ── نقطة صحية ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'prix-choc-bot', time: new Date().toISOString() });
});

// ── تشغيل الخادم ──
const PORT = process.env.PORT || 10000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 Prix Choc Bot يعمل على المنفذ ${PORT}`);
  console.log(`🔗 الرابط: https://prix-choc-bot.onrender.com`);
});
