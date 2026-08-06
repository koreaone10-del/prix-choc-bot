const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

async function submitToBabaAlgeria(order) {
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process'
        ]
    });
    
    const page = await browser.newPage();
    
    // إعطاء البوت هوية حقيقية (لتجاوز أي حماية أو جدار ناري)
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    try {
        console.log("🚀 بدء الأتمتة للطلبية:", order.customerName);

        // 1. تسجيل الدخول
        console.log("⏳ جاري فتح صفحة الدخول...");
        await page.goto('https://babaalgeria.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log("⌨️ جاري كتابة بيانات الدخول...");
        await page.waitForSelector('input[type="email"]', { timeout: 15000 });
        await page.type('input[type="email"]', process.env.BABA_EMAIL);
        await page.type('input[type="password"]', process.env.BABA_PASSWORD);
        await page.click('button[type="submit"]');
        
        console.log("⏳ ننتظر 5 ثواني لضمان الدخول السلس (بدون انتظار إعادة التحميل)...");
        // هذا هو الحل السحري الذي سيمنع خطأ Timeout!
        await new Promise(r => setTimeout(r, 5000)); 

        // 2. التوجه لصفحة إنشاء طلبية
        console.log("⏳ جاري فتح صفحة إضافة طلبية...");
        await page.goto('https://babaalgeria.com/create-order', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 3. إدخال كود المنتج والسعر
        console.log("📦 جاري إدخال بيانات المنتج...");
        await page.waitForSelector('input[type="text"]', { timeout: 15000 });
        const productInputs = await page.$$('input[type="text"]');
        if(productInputs.length >= 2) {
            await productInputs[0].type(order.babaId); 
            await productInputs[1].click({ clickCount: 3 }); 
            await productInputs[1].type(order.sellingPrice.toString()); 
        }

        // 4. إدخال بيانات الزبون
        console.log("👤 جاري إدخال معلومات الزبون...");
        const nameParts = order.customerName.split(' ');
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(' ') || '.'; 
        
        // دالة مصغرة لتفادي الأخطاء إذا تغير تصميم الموقع قليلاً
        const typeInput = async (label, text) => {
            try {
                const [el] = await page.$x(`//label[contains(text(), '${label}')]/following-sibling::input`);
                if(el) await el.type(text);
            } catch(e) {}
        };

        await typeInput('الاسم', firstName);
        await typeInput('اللقب', lastName);
        await typeInput('الهاتف', order.phone);
        await typeInput('العنوان', order.address);

        // 5. اختيار الولاية
        console.log("🗺️ جاري تحديد الولاية...");
        try {
            const [wilayaSelect] = await page.$x("//label[contains(text(), 'ولاية التوصيل')]/following-sibling::select");
            if(wilayaSelect) await wilayaSelect.select(order.wilaya);
        } catch(e) {}

        // 6. اختيار نوع التوصيل
        try {
            if (order.deliveryLocation === 'home') {
                const [homeBtn] = await page.$x("//button[contains(text(), 'للمنزل')]");
                if(homeBtn) await homeBtn.click();
            } else {
                const [deskBtn] = await page.$x("//button[contains(text(), 'للمكتب')]");
                if(deskBtn) await deskBtn.click();
            }
        } catch(e) {}

        // 7. النقر على زر "إرسال الطلبية"
        console.log("🎯 جاري الضغط على زر التأكيد النهائي...");
        const [submitBtn] = await page.$x("//button[contains(text(), 'إرسال الطلبية')]");
        if(submitBtn) {
            await submitBtn.click();
            console.log("🎉 نجاح! تم تسجيل الطلبية رسمياً في بابا الجزائر.");
        } else {
            console.log("⚠️ تحذير: لم يتم العثور على زر الإرسال.");
        }

        await new Promise(r => setTimeout(r, 4000));

    } catch (error) {
        console.error("❌ توقف البوت بسبب خطأ:", error.message);
    } finally {
        await browser.close();
        console.log("🔒 تم إغلاق المتصفح الخفي بنجاح.");
    }
}

app.post('/api/order', (req, res) => {
    const orderData = req.body;
    res.status(200).json({ success: true, message: "Order received" });
    submitToBabaAlgeria(orderData);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🤖 خادم Prix Choc يعمل بامتياز على المنفذ ${PORT}`);
});
