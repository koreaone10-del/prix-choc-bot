const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

// دالة التوقف الإجباري (لا يمكن تخطيها)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// 🛒 نظام الطابور (Queue) لحماية الخادم من الانهيار
// ==========================================
const orderQueue = [];
let isProcessing = false;

async function processQueue() {
    if (isProcessing || orderQueue.length === 0) return;
    isProcessing = true;
    
    const order = orderQueue.shift(); // سحب الطلب الأول
    try {
        await submitToSawa9ly(order);
    } catch (error) {
        console.error(`❌ فشل نهائي في الطلبية الخاصة بـ [${order.customerName}]:`, error.message);
    }
    
    isProcessing = false;
    processQueue(); // الانتقال للطلب التالي في الطابور
}

// استقبال الطلبات من Vercel ووضعها في الطابور
app.post('/api/order', (req, res) => {
    res.status(200).json({ success: true, message: "تم إرسال الطلبية إلى طابور المعالجة" });
    orderQueue.push(req.body);
    console.log(`📥 طلب جديد أضيف للطابور. (الطلبات المنتظرة: ${orderQueue.length})`);
    processQueue();
});

// ==========================================
// 🤖 العقل المدبر لأتمتة موقع سوقلي
// ==========================================
async function submitToSawa9ly(order) {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)');
    await page.setViewport({ width: 1280, height: 800 });

    try {
        console.log(`\n================================`);
        console.log(`🚀 بدء معالجة طلبية: ${order.customerName}`);
        
        // 1. تسجيل الدخول
        console.log("1️⃣ جاري فتح صفحة تسجيل الدخول...");
        await page.goto('https://sawa9ly.app/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('input[type="email"]', { timeout: 15000 });
        await page.type('input[type="email"]', process.env.SAWA9LY_EMAIL);
        await page.type('input[type="password"]', process.env.SAWA9LY_PASSWORD);
        
        console.log("   - الضغط على دخول...");
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
            page.click('button[type="submit"]')
        ]);
        await delay(3000);

        // 2. صفحة المنتج
        console.log("2️⃣ التوجه المباشر لرابط المنتج...");
        await page.goto(order.sawa9lyLink, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(3000);
        
        // 3. زر قدم طلبك
        console.log("3️⃣ الضغط على زر 'قدم طلبك' الأخضر...");
        const [addBtn] = await page.$x("//button[contains(., 'قدم طلبك')]");
        if(!addBtn) throw new Error("لم أجد زر قدم طلبك");
        await addBtn.click();
        await delay(5000); // ننتظر 5 ثواني لفتح الاستمارة

        // 4. تعديل السعر
        console.log(`4️⃣ تعديل السعر إلى ${order.sellingPrice} د.ج...`);
        const [priceInput] = await page.$x("//input[@type='number' or contains(@class, 'price')]");
        if(priceInput) {
            await priceInput.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            await priceInput.type(order.sellingPrice.toString(), { delay: 100 });
            await page.evaluate(el => {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }, priceInput);
            await delay(2000);
        } else {
            console.log("   ⚠️ لم أجد خانة السعر، ربما غير قابلة للتعديل في هذا المنتج.");
        }

        // 5. زر استمرار
        console.log("5️⃣ الضغط على زر 'استمرار' الأصفر...");
        const [continueBtn] = await page.$x("//button[contains(., 'استمرار')]");
        if(!continueBtn) throw new Error("لم أجد زر استمرار");
        await continueBtn.click();
        await delay(4000); // ننتظر 4 ثواني لظهور خانات معلومات الزبون

        // 6. بيانات الزبون (دالة صارمة)
        console.log("6️⃣ كتابة معلومات الزبون (الاسم، الهاتف، العنوان)...");
        const typeField = async (label, text) => {
            const [el] = await page.$x(`//*[contains(text(), '${label}')]/following::input[1]`);
            if(el) {
                await el.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await el.type(text, { delay: 50 });
                await delay(500);
            }
        };
        await typeField('الاسم الكامل', order.customerName);
        await typeField('رقم الهاتف', order.phone);
        await typeField('عنوان التوصيل', order.address);

        // 7. القوائم المنسدلة (الولاية ثم البلدية) - التوقيت هنا مصيري!
        const selectDropdown = async (label, targetText) => {
            console.log(`   - البحث عن [${targetText}] في قائمة [${label}]...`);
            const [dropdown] = await page.$x(`//*[contains(text(), '${label}')]/following::select[1]`);
            if (dropdown) {
                const val = await page.evaluate((sel, target) => {
                    const clean = t => t.replace(/[أإآا]/g, 'ا').replace(/ة/g, 'ه').toLowerCase().trim();
                    const s = clean(target);
                    for (let opt of sel.options) {
                        if (clean(opt.text).includes(s) || s.includes(clean(opt.text))) return opt.value;
                    }
                    return null;
                }, dropdown, targetText);

                if (val) {
                    await dropdown.select(val);
                    await page.evaluate(sel => sel.dispatchEvent(new Event('change', { bubbles: true })), dropdown);
                    console.log(`   ✅ تم اختيار [${targetText}] بنجاح.`);
                    return true;
                }
            }
            console.log(`   ❌ لم يتم العثور على [${targetText}].`);
            return false;
        };

        console.log("7️⃣ اختيار الولاية والمدينة...");
        const wilayaSuccess = await selectDropdown('ولاية', order.wilaya);
        
        if (wilayaSuccess) {
            console.log("   ⏳ انتظار 4 ثواني لتحميل البلديات من سيرفر سوقلي...");
            await delay(4000); // إجباري جداً!!
            await selectDropdown('مدينة', order.commune);
            await delay(2000);
        } else {
            throw new Error("فشل في اختيار الولاية، لا يمكن إكمال الطلب.");
        }

        // 8. تأكيد الطلب النهائي
        console.log("8️⃣ الضغط على 'تأكيد الطلب'...");
        const [submitBtn] = await page.$x("//button[contains(., 'تأكيد الطلب') or contains(., 'تأكيد')]");
        if(submitBtn) {
            await submitBtn.click();
        } else {
            throw new Error("لم أجد زر تأكيد الطلب النهائي.");
        }

        // 9. التحقق من النجاح الفعلي
        console.log("⏳ ننتظر صفحة التأكيد الخضراء من سوقلي...");
        try {
            await page.waitForXPath("//*[contains(text(), 'نجاح') or contains(text(), 'تأكيد طلبك')]", { timeout: 15000 });
            console.log("🎉 تمت الطلبية بنجاح 100%!");
        } catch(e) {
            console.log("❌ انتهى الوقت ولم تظهر رسالة النجاح. يرجى التفقد يدوياً.");
        }
        console.log(`================================\n`);

    } catch (error) {
        console.error("❌ توقف مسار البوت بسبب:", error.message);
    } finally {
        await browser.close();
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🤖 نظام الطابور يعمل على ${PORT}`); });
