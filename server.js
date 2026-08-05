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

    try {
        console.log("🚀 جاري بدء الأتمتة في الخلفية للطلبية:", order.customerName);

        // 1. تسجيل الدخول
        await page.goto('https://babaalgeria.com/login', { waitUntil: 'networkidle2' });
        
        await page.type('input[type="email"]', process.env.BABA_EMAIL);
        await page.type('input[type="password"]', process.env.BABA_PASSWORD);
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        console.log("✅ تم تسجيل الدخول بنجاح");

        // 2. التوجه لصفحة إنشاء طلبية
        await page.goto('https://babaalgeria.com/create-order', { waitUntil: 'networkidle2' });

        // 3. إدخال كود المنتج والسعر
        const productInputs = await page.$$('input[type="text"]');
        if(productInputs.length >= 2) {
            await productInputs[0].type(order.babaId); 
            await productInputs[1].click({ clickCount: 3 }); 
            await productInputs[1].type(order.sellingPrice.toString()); 
        }

        // 4. إدخال بيانات الزبون
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
        const [submitBtn] = await page.$x("//button[contains(text(), 'إرسال الطلبية')]");
        if(submitBtn) {
            await submitBtn.click();
            console.log("✅ تم إرسال الطلبية بنجاح إلى بابا الجزائر!");
        }

        await new Promise(r => setTimeout(r, 3000));

    } catch (error) {
        console.error("❌ حدث خطأ أثناء الأتمتة:", error);
    } finally {
        await browser.close();
    }
}

// استقبال البيانات والرد الفوري لتجنب انتهاء المهلة (Timeout)
app.post('/api/order', (req, res) => {
    const orderData = req.body;
    
    // الرد الفوري على موقع Vercel بأن الطلبية وصلت بنجاح لتظهر للزبون فوراً
    res.status(200).json({ success: true, message: "Order received" });

    // تشغيل البوت في الخلفية بصمت تام لكي لا ينتظر الموقع
    submitToBabaAlgeria(orderData);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🤖 خادم Prix Choc يعمل على المنفذ ${PORT}`);
});
