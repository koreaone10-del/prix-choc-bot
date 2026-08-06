const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ⚠️ تأكد من صحة الرابط - لا تنسَ "ia" في النهاية!
const BABA_BASE_URL = 'https://www.babaalgeria.com';
const LOGIN_URL = `${BABA_BASE_URL}/login`;
const ORDERS_URL = `${BABA_BASE_URL}/orders`;

// بيانات دخولك على بابا الجزائر
const BABA_EMAIL = process.env.BABA_EMAIL || 'your-email@example.com';
const BABA_PASSWORD = process.env.BABA_PASSWORD || 'your-password';

// خريطة الولايات (مثال)
const wilayasMap = {
  "1""1": "أدرار", "2": "الشلف", "3": "الأغواط", "4": "أم البواقي", "5": "باتنة",
    "6": "بجاية", "7": "بسكرة", "8": "بشار", "9": "البليدة", "10": "البويرة",
    "11": "تمنراست", "12": "تبسة", "13": "تلمسان", "14": "تيارت", "15": "تيزي وزو",
    "16": "الجزائر", "17": "الجلفة", "18": "جيجل", "19": "سطيف", "20": "سعيدة",
    "21": "سكيكدة", "22": "سيدي بلعباس", "23": "عنابة", "24": "قالمة", "25": "قسنطينة",
    "26": "المدية", "27": "مستغانم", "28": "المسيلة", "29": "معسكر", "30": "ورقلة",
    "31": "وهران", "32": "البيض", "33": "إليزي", "34": "برج بوعريريج", "35": "بومرداس",
    "36": "الطارف", "37": "تندوف", "38": "تيسمسيلت", "39": "الوادي", "40": "خنشلة",
    "41": "سوق أهراس", "42": "تيبازة", "43": "ميلة", "44": "عين الدفلى", "45": "النعامة",
    "46": "عين تموشنت", "47": "غرداية", "48": "غليزان", "49": "تيميمون", "50": "برج باجي مختار",
    "51": "أولاد جلال", "52": "بني عباس", "53": "عين صالح", "54": "عين قزام", "55": "تقرت",
    "56": "جانت", "57": "المغير", "58": "المنيعة"
  // ... أكمل بقية الولايات حسب حاجتك
};

app.post('/automate-order', async (req, res) => {
  const { orderId, productUrl, customerName, customerPhone, customerAddress, wilayaNumber, commune } = req.body;
  
  // 1. الرد الفوري لـ Vercel (لتجنب Timeout)
  res.json({ success: true, message: 'تم استلام الطلبية وجاري تنفيذها في الخلفية', orderId });

  let browser;
  try {
    console.log(`\n🚀 بدء الأتمتة للطلبية: ${orderId}`);
    
    // إطلاق المتصفح
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // --- الخطوة 1: تسجيل الدخول ---
    console.log('⏳ جاري فتح صفحة الدخول...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // انتظار حقول الدخول
    await page.waitForSelector('input[type="email"], input[name="email"], #email', { timeout: 10000 });
    await page.type('input[type="email"], input[name="email"], #email', BABA_EMAIL);
    
    await page.waitForSelector('input[type="password"], input[name="password"], #password', { timeout: 10000 });
    await page.type('input[type="password"], input[name="password"], #password', BABA_PASSWORD);
    
    // الضغط على زر الدخول
    await Promise.all([
      page.click('button[type="submit"], .btn-login, input[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 })
    ]);
    
    console.log('✅ تم الدخول بنجاح!');
    
    // ⏱️ انتظار 5 ثوانٍ كاملة لزراعة الكوكيز والجلسة
    await new Promise(r => setTimeout(r, 5000));
    
    // التحقق من نجاح الدخول (هل نحن في لوحة التحكم؟)
    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
      throw new Error('فشل تسجيل الدخول - تأكد من البريد وكلمة المرور');
    }
    
    // --- الخطوة 2: الذهاب للمنتج ---
    const targetUrl = productUrl || `${BABA_BASE_URL}/product/323`;
    console.log(`🔗 جاري التوجه لصفحة المنتج: ${targetUrl}`);
    
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // انتظار تحميل الصفحة تماماً
    await new Promise(r => setTimeout(r, 3000));
    
    // --- الخطوة 3: البحث عن زر "ابدأ البيع الآن" ---
    console.log('🛒 جاري البحث عن زر "ابدأ البيع الآن"...');
    
    // جرب عدة سيليكتورات محتملة للزر
    const possibleSelectors = [
      'a:has-text("ابدأ البيع الآن")',
      'button:has-text("ابدأ البيع الآن")',
      'a[href*="orders/create"]',
      'a[href*="seller"]',
      '.btn-sell',
      '.start-selling',
      '[data-action="sell"]',
      'a:contains("ابدأ البيع")', // jQuery-like, Puppeteer لا يدعمها مباشرة
    ];
    
    let sellButtonFound = false;
    
    // البحث بالنص العربي مباشرة
    sellButtonFound = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('a, button, span'));
      const target = buttons.find(el => el.textContent.includes('ابدأ البيع'));
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    
    if (!sellButtonFound) {
      // محاولة أخرى: ربما الزر يظهر بعد scroll
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      await new Promise(r => setTimeout(r, 2000));
      
      sellButtonFound = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('a, button, input[type="submit"]'));
        const target = buttons.find(el => 
          el.textContent.includes('ابدأ البيع') || 
          el.textContent.includes('ابدا البيع') ||
          el.value?.includes('ابدأ')
        );
        if (target) { target.click(); return true; }
        return false;
      });
    }
    
    if (!sellButtonFound) {
      // التقاط صورة للتحقق من وضع الصفحة
      await page.screenshot({ path: `/tmp/debug-${orderId}.png`, fullPage: true });
      console.log(`📸 تم حفظ صورة التشخيص: /tmp/debug-${orderId}.png`);
      throw new Error('لم يتم العثور على زر "ابدأ البيع الآن" - ربما المنتج غير متاح للتسويق أو الجلسة منتهية');
    }
    
    console.log('✅ تم النقر على زر البيع!');
    
    // انتظار تحميل صفحة الطلب
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {
      console.log('⚠️ لم يحدث تنقل تلقائي، ربما فتح نافذة أو AJAX...');
    });
    
    await new Promise(r => setTimeout(r, 3000));
    
    // --- الخطوة 4: تعبئة استمارة الطلب ---
    console.log('📝 جاري تعبئة بيانات العميل...');
    
    // تعبئة الاسم
    await page.waitForSelector('input[name="name"], input[name="customer_name"], input[placeholder*="الاسم"]', { timeout: 10000 });
    await page.type('input[name="name"], input[name="customer_name"], input[placeholder*="الاسم"]', customerName || 'عميل');
    
    // تعبئة الهاتف
    await page.type('input[name="phone"], input[name="customer_phone"], input[type="tel"]', customerPhone || '05');
    
    // تعبئة العنوان
    await page.type('input[name="address"], textarea[name="address"]', customerAddress || 'عنوان العميل');
    
    // اختيار الولاية
    if (wilayaNumber && wilayasMap[wilayaNumber]) {
      const wilayaName = wilayasMap[wilayaNumber];
      // محاولة فتح قائمة الولايات
      const selectClicked = await page.evaluate((name) => {
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          if (sel.innerHTML.includes('ولاية') || sel.innerHTML.includes('الولاية')) {
            sel.click();
            return true;
          }
        }
        // أو البحث عن الولاية بالنص
        const options = Array.from(document.querySelectorAll('option'));
        const opt = options.find(o => o.textContent.includes(name));
        if (opt) {
          opt.selected = true;
          const event = new Event('change', { bubbles: true });
          opt.parentElement.dispatchEvent(event);
          return true;
        }
        return false;
      }, wilayaName);
      
      if (!selectClicked) {
        console.log(`⚠️ لم يتم العثور على قائمة الولايات، سيتم تخطيها`);
      }
    }
    
    // تعبئة البلدية
    if (commune) {
      await page.evaluate((communeName) => {
        const inputs = Array.from(document.querySelectorAll('input, select'));
        const target = inputs.find(el => 
          el.name?.includes('commune') || 
          el.placeholder?.includes('بلدية') ||
          el.placeholder?.includes('البلدية')
        );
        if (target) {
          target.value = communeName;
          target.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, commune);
    }
    
    // --- الخطوة 5: إرسال الطلب ---
    console.log('📤 جاري إرسال الطلب...');
    
    await Promise.all([
      page.click('button[type="submit"], .btn-submit, input[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
    ]);
    
    console.log(`🎉 تم إرسال الطلبية ${orderId} بنجاح!`);
    
    // التقاط صورة تأكيد
    await page.screenshot({ path: `/tmp/success-${orderId}.png` });
    
  } catch (error) {
    console.error(`❌ خطأ في الطلبية ${orderId}:`, error.message);
    // يمكنك هنا إرسال إشعار بريدي أو تيليغرام بالفشل
  } finally {
    if (browser) {
      await new Promise(r => setTimeout(r, 2000)); // انتظار قبل الإغلاق
      await browser.close();
      console.log('🔒 تم إغلاق المتصفح الآلي.\n');
    }
  }
});

// نقطة صحية للتحقق
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'prix-choc-bot', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🤖 Prix Choc Bot يعمل على المنفذ ${PORT}`);
});
