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
    // تقليل حجم الشاشة لتسريع التحميل
    await page.setViewport({ width: 800, height: 600 });

    try {
        console.log("🚀 بدء الأتمتة للطلبية:", order.customerName);

        // 1. تسجيل الدخول (استخدام domcontentloaded لسرعة فائقة)
        console.log("⏳ جاري فتح صفحة الدخول...");
        await page.goto('https://babaalgeria.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log("⌨️ جاري كتابة البيانات...");
        await page.type('input[type="email"]', process.env.BABA_EMAIL);
        await page.type('input[type="password"]', process.env.BABA_PASSWORD);
        await page.click('button[type="submit"]');
        
        console.log("⏳ ننتظر الدخول للحساب...");
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log("✅ تم الدخول بنجاح!");

        // 2. التوجه لصفحة إنشاء طلبية
        console.log("⏳ جاري فتح صفحة إضافة طلبية...");
        await page.goto('https://babaalgeria.com/create-order', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 3. إدخال كود المنتج والسعر
        console.log("📦 جاري إدخال بيانات المنتج...");
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
        
        const [firstNameEl] = await page.$x("//label[contains(text(), 'الاسم')]/following-sibling::input");
        if(firstNameEl) await firstNameEl.type(firstName);

        const [lastNameEl] = await page.$x("//label[contains(text(), 'اللقب')]/following-sibling::input");
        if(lastNameEl) await lastNameEl.type(lastName);

        const [phoneEl] = await page.$x("//label[contains(text(), 'الهاتف')]/following-sibling::input");
        if(phoneEl) await phoneEl.type(order.phone);

        const [addressEl] = await page.$x("//label[contains(text(), 'العنوان')]/following-sibling::input");
        if(addressEl) await addressEl.type(order.address);

        // 5. اختيار الولاية
        console.log("🗺️ جاري تحديد الولاية...");
        const [wilayaSelect] = await page.$x("//label[contains(text(), 'ولاية التوصيل')]/following-sibling::select");
        if(wilayaSelect) await wilayaSelect.select(order.wilaya);

        // 6. اختيار نوع التوصيل
        if (order.deliveryLocation === 'home') {
            const [homeBtn] = await page.$x("//button[contains(text(), 'للمنزل')]");
            if(homeBtn) await homeBtn.click();
        } else {
            const [deskBtn] = await page.$x("//button[contains(text(), 'للمكتب')]");
            if(deskBtn) await deskBtn.click();
        }

        // 7. النقر على زر "إرسال الطلبية"
        console.log("🎯 جاري الضغط على زر التأكيد النهائي...");
        const [submitBtn] = await page.$x("//button[contains(text(), 'إرسال الطلبية')]");
        if(submitBtn) {
            await submitBtn.click();
            console.log("🎉 نجاح! تم تسجيل الطلبية رسمياً في بابا الجزائر.");
        }

        await new Promise(r => setTimeout(r, 4000));

    } catch (error) {
        console.error("❌ توقف البوت بسبب خطأ:", error.message);
    } finally {
        await browser.close();
        console.log("🔒 تم إغلاق المتصفح الخفي.");
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
